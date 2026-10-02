begin;

create table if not exists public.omr_exam_entry_invites (
    token_hash text primary key check (token_hash ~ '^[a-f0-9]{64}$'),
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    group_ids text[] not null check (cardinality(group_ids) between 1 and 100),
    issued_by_user_id text not null,
    expires_at timestamptz not null,
    revoked_at timestamptz,
    created_at timestamptz not null default now(),
    check (octet_length(exam_id) between 1 and 256),
    check (octet_length(organization_id) between 1 and 128),
    check (octet_length(issued_by_user_id) between 1 and 128),
    check (expires_at > created_at),
    check (revoked_at is null or revoked_at >= created_at)
);

create unique index if not exists omr_exam_entry_invites_one_active_idx
    on public.omr_exam_entry_invites (organization_id, exam_id)
    where revoked_at is null;
create index if not exists omr_exam_entry_invites_org_exam_fk_idx
    on public.omr_exam_entry_invites (organization_id, exam_id);
create index if not exists omr_exam_entry_invites_exam_fk_idx
    on public.omr_exam_entry_invites (exam_id);
create index if not exists omr_exam_entry_invites_expiry_idx
    on public.omr_exam_entry_invites (expires_at, organization_id, exam_id);

alter table public.omr_exam_entry_invites enable row level security;
alter table public.omr_exam_entry_invites force row level security;
revoke all on public.omr_exam_entry_invites from public, anon, authenticated, service_role;

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
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_exam public.omr_exams%rowtype;
    v_group_ids text[];
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
       or (select count(*) from public.omr_classes class_item
            where class_item.id = any(v_group_ids)
              and class_item.organization_id = pg_catalog.btrim(p_organization_id)
              and class_item.status = 'active') is distinct from pg_catalog.cardinality(v_group_ids)::bigint then
        return pg_catalog.jsonb_build_object('status', 'invalid_scope');
    end if;

    update public.omr_exam_entry_invites
       set revoked_at = v_now
     where organization_id = pg_catalog.btrim(p_organization_id)
       and exam_id = pg_catalog.btrim(p_exam_id)
       and revoked_at is null;

    insert into public.omr_exam_entry_invites (
        token_hash, organization_id, exam_id, group_ids, issued_by_user_id, expires_at, created_at
    ) values (
        pg_catalog.lower(pg_catalog.btrim(p_token_hash)), pg_catalog.btrim(p_organization_id),
        pg_catalog.btrim(p_exam_id), v_group_ids, pg_catalog.btrim(p_actor_user_id), p_expires_at, v_now
    );

    return pg_catalog.jsonb_build_object('status', 'issued', 'expiresAt', p_expires_at);
end;
$$;

create or replace function public.omr_resolve_exam_entry_invite_v1(
    p_token_hash text,
    p_exam_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := clock_timestamp();
    v_invite public.omr_exam_entry_invites%rowtype;
    v_exam public.omr_exams%rowtype;
    v_current_group_ids text[];
begin
    if nullif(pg_catalog.btrim(p_token_hash), '') is null
       or pg_catalog.lower(pg_catalog.btrim(p_token_hash)) !~ '^[a-f0-9]{64}$'
       or nullif(pg_catalog.btrim(p_exam_id), '') is null
       or pg_catalog.octet_length(pg_catalog.btrim(p_exam_id)) > 256 then
        return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    -- Read only the scope first. The authoritative invite row is locked again
    -- after the exam so rotate and resolve always acquire exam -> invite locks.
    -- The second read catches revocation/expiry that races with this first read.
    select invite.* into v_invite
      from public.omr_exam_entry_invites invite
     where invite.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))
       and invite.exam_id = pg_catalog.btrim(p_exam_id)
       and invite.revoked_at is null
       and invite.expires_at > v_now;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    select exam.* into v_exam
      from public.omr_exams exam
     where exam.id = v_invite.exam_id
       and exam.organization_id = v_invite.organization_id
       and exam.archived is false
     for share;
    if not found
       or v_exam.payload #>> '{accessConfig,type}' is distinct from 'group'
       or pg_catalog.jsonb_typeof(v_exam.payload #> '{accessConfig,groupIds}') is distinct from 'array' then
        return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    select invite.* into v_invite
      from public.omr_exam_entry_invites invite
     where invite.token_hash = pg_catalog.lower(pg_catalog.btrim(p_token_hash))
       and invite.exam_id = v_exam.id
       and invite.organization_id = v_exam.organization_id
       and invite.revoked_at is null
       and invite.expires_at > v_now
     for share;
    if not found then
        return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    select pg_catalog.array_agg(scope.group_id order by scope.group_id)
      into v_current_group_ids
      from (
          select distinct pg_catalog.btrim(item.value) as group_id
            from pg_catalog.jsonb_array_elements_text(v_exam.payload #> '{accessConfig,groupIds}') item(value)
           where nullif(pg_catalog.btrim(item.value), '') is not null
      ) scope;
    perform 1
      from public.omr_classes class_item
     where class_item.id = any(v_current_group_ids)
     for share;
    if v_current_group_ids is distinct from v_invite.group_ids
       or pg_catalog.cardinality(v_current_group_ids) not between 1 and 100
       or exists (
           select 1
             from pg_catalog.unnest(v_current_group_ids) group_id
             left join public.omr_classes class_item
               on class_item.id = group_id
              and class_item.organization_id = v_invite.organization_id
              and class_item.status = 'active'
            where class_item.id is null
       ) then
        return pg_catalog.jsonb_build_object('status', 'invalid');
    end if;

    return pg_catalog.jsonb_build_object(
        'status', 'resolved',
        'organizationId', v_invite.organization_id,
        'examId', v_invite.exam_id,
        'groupIds', pg_catalog.to_jsonb(v_invite.group_ids),
        'expiresAt', v_invite.expires_at
    );
end;
$$;

revoke all on function public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)
    from public, anon, authenticated;
revoke all on function public.omr_resolve_exam_entry_invite_v1(text,text)
    from public, anon, authenticated;
grant execute on function public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)
    to service_role;
grant execute on function public.omr_resolve_exam_entry_invite_v1(text,text)
    to service_role;

comment on table public.omr_exam_entry_invites is
    'Hash-only, revocable and bounded exam-scoped entry invites. Raw bearer tokens are never persisted.';
comment on function public.omr_rotate_exam_entry_invite_v1(text,text,text,text,timestamptz)
    is 'opaque-exam-entry-invite:202608060029';
comment on function public.omr_resolve_exam_entry_invite_v1(text,text)
    is 'opaque-exam-entry-invite:202608060029';

commit;
