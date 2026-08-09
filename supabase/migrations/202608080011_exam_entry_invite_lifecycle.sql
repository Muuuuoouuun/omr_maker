begin;

do $$
begin
    if pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') is null then
        raise exception 'pgcrypto extensions.gen_random_bytes(integer) is required';
    end if;
end
$$;

alter table public.omr_exam_entry_invites
    add column invite_id text,
    add column target_type text not null default 'groups',
    add column target_ids text[],
    add column generation integer not null default 1;

with ranked as (
    select token_hash,
           pg_catalog.row_number() over (
               partition by organization_id, exam_id
               order by created_at, token_hash
           )::integer as generation
      from public.omr_exam_entry_invites
)
update public.omr_exam_entry_invites invite
   set invite_id = 'exam_invite_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
       target_ids = invite.group_ids,
       generation = ranked.generation
  from ranked
 where ranked.token_hash = invite.token_hash;

alter table public.omr_exam_entry_invites
    alter column invite_id set default (
        'exam_invite_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex')
    ),
    alter column invite_id set not null,
    alter column target_ids set not null,
    add constraint omr_exam_entry_invites_invite_id_unique unique (invite_id),
    add constraint omr_exam_entry_invites_invite_id_check
        check (invite_id ~ '^exam_invite_[a-f0-9]{32}$'),
    add constraint omr_exam_entry_invites_target_type_check
        check (target_type = 'groups'),
    add constraint omr_exam_entry_invites_target_ids_check
        check (cardinality(target_ids) between 1 and 100 and target_ids = group_ids),
    add constraint omr_exam_entry_invites_generation_check
        check (generation between 1 and 2147483646),
    add constraint omr_exam_entry_invites_org_exam_generation_unique
        unique (organization_id, exam_id, generation);

create or replace function public.omr_rotate_exam_entry_invite_v1(
    p_organization_id text,
    p_exam_id text,
    p_actor_user_id text,
    p_token_hash text,
    p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_exam public.omr_exams%rowtype;
    v_group_ids text[];
    v_previous_generation integer;
    v_generation integer;
    v_invite public.omr_exam_entry_invites%rowtype;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_organization_id)) > 128
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_exam_id)) > 256
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_actor_user_id)) > 128
       or nullif(pg_catalog.btrim(p_token_hash), '') is null
       or pg_catalog.lower(pg_catalog.btrim(p_token_hash)) !~ '^[a-f0-9]{64}$'
       or p_expires_at is null
       or not (p_expires_at > v_now + interval '15 minutes')
       or not (p_expires_at <= v_now + interval '90 days') then
        return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    if not exists (
        select 1
          from public.omr_organization_members member
         where member.organization_id = pg_catalog.btrim(p_organization_id)
           and member.user_id = pg_catalog.btrim(p_actor_user_id)
           and member.status = 'active'
           and member.role in ('owner', 'admin', 'teacher')
    ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        pg_catalog.btrim(p_organization_id) || chr(31) || pg_catalog.btrim(p_exam_id) || chr(31) || 'entry-invite',
        604029
    ));

    select exam.* into v_exam
      from public.omr_exams exam
     where exam.id = pg_catalog.btrim(p_exam_id)
       and exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.archived is false
     for update;
    if not found
       or v_exam.payload #>> '{accessConfig,type}' is distinct from 'group'
       or pg_catalog.jsonb_typeof(v_exam.payload #> '{accessConfig,groupIds}') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_exam.payload #> '{accessConfig,groupIds}') not between 1 and 100 then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    select pg_catalog.array_agg(scope.group_id order by scope.group_id)
      into v_group_ids
      from (
          select distinct pg_catalog.btrim(item.value) as group_id
            from pg_catalog.jsonb_array_elements_text(v_exam.payload #> '{accessConfig,groupIds}') item(value)
           where nullif(pg_catalog.btrim(item.value), '') is not null
             and pg_catalog.octet_length(pg_catalog.btrim(item.value)) <= 128
      ) scope;
    if pg_catalog.cardinality(v_group_ids) is distinct from pg_catalog.jsonb_array_length(v_exam.payload #> '{accessConfig,groupIds}')
       or (select pg_catalog.count(*) from public.omr_classes class_item
            where class_item.id = any(v_group_ids)
              and class_item.organization_id = pg_catalog.btrim(p_organization_id)
              and class_item.status = 'active') is distinct from pg_catalog.cardinality(v_group_ids)::bigint then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    select pg_catalog.max(invite.generation)
      into v_previous_generation
      from public.omr_exam_entry_invites invite
     where invite.organization_id = pg_catalog.btrim(p_organization_id)
       and invite.exam_id = pg_catalog.btrim(p_exam_id);
    if v_previous_generation >= 2147483646 then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;
    v_generation := coalesce(v_previous_generation, 0) + 1;

    update public.omr_exam_entry_invites
       set revoked_at = v_now
     where organization_id = pg_catalog.btrim(p_organization_id)
       and exam_id = pg_catalog.btrim(p_exam_id)
       and revoked_at is null;

    insert into public.omr_exam_entry_invites (
        token_hash, organization_id, exam_id, group_ids, target_type, target_ids,
        generation, issued_by_user_id, expires_at, created_at
    ) values (
        pg_catalog.lower(pg_catalog.btrim(p_token_hash)), pg_catalog.btrim(p_organization_id),
        pg_catalog.btrim(p_exam_id), v_group_ids, 'groups', v_group_ids,
        v_generation, pg_catalog.btrim(p_actor_user_id), p_expires_at, v_now
    ) returning * into v_invite;

    return pg_catalog.jsonb_build_object(
        'status', 'issued',
        'metadata', pg_catalog.jsonb_build_object(
            'inviteId', v_invite.invite_id,
            'examId', v_invite.exam_id,
            'targetType', v_invite.target_type,
            'targetIds', pg_catalog.to_jsonb(v_invite.target_ids),
            'issuedAt', v_invite.created_at,
            'expiresAt', v_invite.expires_at,
            'revokedAt', v_invite.revoked_at,
            'generation', v_invite.generation
        )
    );
end;
$$;

create or replace function public.omr_get_exam_entry_invite_metadata_v1(
    p_organization_id text,
    p_exam_id text,
    p_actor_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_exam public.omr_exams%rowtype;
    v_group_ids text[];
    v_invite public.omr_exam_entry_invites%rowtype;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_organization_id)) > 128
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_exam_id)) > 256
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_actor_user_id)) > 128 then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    if not exists (
        select 1
          from public.omr_organization_members member
         where member.organization_id = pg_catalog.btrim(p_organization_id)
           and member.user_id = pg_catalog.btrim(p_actor_user_id)
           and member.status = 'active'
           and member.role in ('owner', 'admin', 'teacher')
    ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        pg_catalog.btrim(p_organization_id) || chr(31) || pg_catalog.btrim(p_exam_id) || chr(31) || 'entry-invite',
        604029
    ));

    select exam.* into v_exam
      from public.omr_exams exam
     where exam.id = pg_catalog.btrim(p_exam_id)
       and exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.archived is false
     for share;
    if not found
       or v_exam.payload #>> '{accessConfig,type}' is distinct from 'group'
       or pg_catalog.jsonb_typeof(v_exam.payload #> '{accessConfig,groupIds}') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_exam.payload #> '{accessConfig,groupIds}') not between 1 and 100 then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    select pg_catalog.array_agg(scope.group_id order by scope.group_id)
      into v_group_ids
      from (
          select distinct pg_catalog.btrim(item.value) as group_id
            from pg_catalog.jsonb_array_elements_text(v_exam.payload #> '{accessConfig,groupIds}') item(value)
           where nullif(pg_catalog.btrim(item.value), '') is not null
             and pg_catalog.octet_length(pg_catalog.btrim(item.value)) <= 128
      ) scope;
    if pg_catalog.cardinality(v_group_ids) is distinct from pg_catalog.jsonb_array_length(v_exam.payload #> '{accessConfig,groupIds}')
       or (select pg_catalog.count(*) from public.omr_classes class_item
            where class_item.id = any(v_group_ids)
              and class_item.organization_id = pg_catalog.btrim(p_organization_id)
              and class_item.status = 'active') is distinct from pg_catalog.cardinality(v_group_ids)::bigint then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    select invite.* into v_invite
      from public.omr_exam_entry_invites invite
     where invite.organization_id = pg_catalog.btrim(p_organization_id)
       and invite.exam_id = pg_catalog.btrim(p_exam_id)
     order by invite.generation desc
     limit 1
     for share;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'not_found');
    end if;
    if v_invite.target_type is distinct from 'groups'
       or v_invite.target_ids is distinct from v_group_ids then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    return pg_catalog.jsonb_build_object(
        'status', 'found',
        'metadata', pg_catalog.jsonb_build_object(
            'inviteId', v_invite.invite_id,
            'examId', v_invite.exam_id,
            'targetType', v_invite.target_type,
            'targetIds', pg_catalog.to_jsonb(v_invite.target_ids),
            'issuedAt', v_invite.created_at,
            'expiresAt', v_invite.expires_at,
            'revokedAt', v_invite.revoked_at,
            'generation', v_invite.generation
        )
    );
end;
$$;

create or replace function public.omr_revoke_exam_entry_invite_v1(
    p_organization_id text,
    p_exam_id text,
    p_actor_user_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '5s'
set lock_timeout = '2s'
as $$
declare
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_exam public.omr_exams%rowtype;
    v_group_ids text[];
    v_invite public.omr_exam_entry_invites%rowtype;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_organization_id)) > 128
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_exam_id)) > 256
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_actor_user_id)) > 128 then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    if not exists (
        select 1
          from public.omr_organization_members member
         where member.organization_id = pg_catalog.btrim(p_organization_id)
           and member.user_id = pg_catalog.btrim(p_actor_user_id)
           and member.status = 'active'
           and member.role in ('owner', 'admin', 'teacher')
    ) then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
        pg_catalog.btrim(p_organization_id) || chr(31) || pg_catalog.btrim(p_exam_id) || chr(31) || 'entry-invite',
        604029
    ));

    select exam.* into v_exam
      from public.omr_exams exam
     where exam.id = pg_catalog.btrim(p_exam_id)
       and exam.organization_id = pg_catalog.btrim(p_organization_id)
       and exam.archived is false
     for update;
    if not found
       or v_exam.payload #>> '{accessConfig,type}' is distinct from 'group'
       or pg_catalog.jsonb_typeof(v_exam.payload #> '{accessConfig,groupIds}') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_exam.payload #> '{accessConfig,groupIds}') not between 1 and 100 then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    select pg_catalog.array_agg(scope.group_id order by scope.group_id)
      into v_group_ids
      from (
          select distinct pg_catalog.btrim(item.value) as group_id
            from pg_catalog.jsonb_array_elements_text(v_exam.payload #> '{accessConfig,groupIds}') item(value)
           where nullif(pg_catalog.btrim(item.value), '') is not null
             and pg_catalog.octet_length(pg_catalog.btrim(item.value)) <= 128
      ) scope;
    if pg_catalog.cardinality(v_group_ids) is distinct from pg_catalog.jsonb_array_length(v_exam.payload #> '{accessConfig,groupIds}')
       or (select pg_catalog.count(*) from public.omr_classes class_item
            where class_item.id = any(v_group_ids)
              and class_item.organization_id = pg_catalog.btrim(p_organization_id)
              and class_item.status = 'active') is distinct from pg_catalog.cardinality(v_group_ids)::bigint then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    select invite.* into v_invite
      from public.omr_exam_entry_invites invite
     where invite.organization_id = pg_catalog.btrim(p_organization_id)
       and invite.exam_id = pg_catalog.btrim(p_exam_id)
     order by invite.generation desc
     limit 1
     for update;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'not_found');
    end if;
    if v_invite.target_type is distinct from 'groups'
       or v_invite.target_ids is distinct from v_group_ids then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    update public.omr_exam_entry_invites invite
       set revoked_at = coalesce(invite.revoked_at, v_now)
     where invite.invite_id = v_invite.invite_id
     returning invite.* into v_invite;

    return pg_catalog.jsonb_build_object(
        'status', 'revoked',
        'metadata', pg_catalog.jsonb_build_object(
            'inviteId', v_invite.invite_id,
            'examId', v_invite.exam_id,
            'targetType', v_invite.target_type,
            'targetIds', pg_catalog.to_jsonb(v_invite.target_ids),
            'issuedAt', v_invite.created_at,
            'expiresAt', v_invite.expires_at,
            'revokedAt', v_invite.revoked_at,
            'generation', v_invite.generation
        )
    );
end;
$$;

revoke all on function public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)
    from public, anon, authenticated;
revoke all on function public.omr_get_exam_entry_invite_metadata_v1(text,text,text)
    from public, anon, authenticated;
revoke all on function public.omr_revoke_exam_entry_invite_v1(text,text,text)
    from public, anon, authenticated;
grant execute on function public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)
    to service_role;
grant execute on function public.omr_get_exam_entry_invite_metadata_v1(text,text,text)
    to service_role;
grant execute on function public.omr_revoke_exam_entry_invite_v1(text,text,text)
    to service_role;

comment on table public.omr_exam_entry_invites is
    'Hash-only exam entry invites with opaque metadata identifiers and monotonic group-target generations.';
comment on function public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)
    is 'opaque-exam-entry-invite:202608060029';
comment on function public.omr_get_exam_entry_invite_metadata_v1(text,text,text)
    is 'metadata-only-exam-entry-invite-lifecycle:202608080011';
comment on function public.omr_revoke_exam_entry_invite_v1(text,text,text)
    is 'metadata-only-exam-entry-invite-lifecycle:202608080011';

commit;
