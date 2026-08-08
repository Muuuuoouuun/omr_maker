begin;

do $$
begin
    if pg_catalog.to_regprocedure('extensions.digest(text,text)') is null
       or pg_catalog.to_regprocedure('extensions.gen_random_bytes(integer)') is null then
        raise exception 'pgcrypto digest and gen_random_bytes are required';
    end if;
end
$$;

create table public.omr_student_credential_batch_receipts (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    idempotency_key_hash text not null,
    request_fingerprint text not null,
    student_count integer not null,
    state text not null default 'pending',
    created_at timestamptz not null default pg_catalog.clock_timestamp(),
    applied_at timestamptz,
    primary key (organization_id, idempotency_key_hash),
    constraint omr_student_credential_batch_receipts_key_hash_check
        check (idempotency_key_hash ~ '^[a-f0-9]{64}$'),
    constraint omr_student_credential_batch_receipts_fingerprint_check
        check (request_fingerprint ~ '^[a-f0-9]{64}$'),
    constraint omr_student_credential_batch_receipts_count_check
        check (student_count between 1 and 100),
    constraint omr_student_credential_batch_receipts_state_check
        check (state in ('pending', 'applied')),
    constraint omr_student_credential_batch_receipts_applied_check
        check (
            (state = 'pending' and applied_at is null)
            or (state = 'applied' and applied_at is not null and applied_at >= created_at)
        )
);

comment on table public.omr_student_credential_batch_receipts is
    'RPC-only idempotency receipts for atomic student credential batches. Stores hashes and counts only, never raw codes, verifiers, student identifiers, or idempotency keys.';

alter table public.omr_student_credential_batch_receipts enable row level security;
alter table public.omr_student_credential_batch_receipts force row level security;
revoke all on table public.omr_student_credential_batch_receipts
    from public, anon, authenticated, service_role;

create function public.omr_issue_student_start_code_batch_v1(
    p_session_authority text,
    p_account_id text,
    p_session_generation bigint,
    p_organization_id text,
    p_actor_user_id text,
    p_items jsonb,
    p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set statement_timeout = '10s'
set lock_timeout = '2s'
as $$
declare
    v_identity jsonb;
    v_item_count integer;
    v_unique_count integer;
    v_items_valid boolean;
    v_canonical_items jsonb;
    v_student_ids text[];
    v_idempotency_key_hash text;
    v_request_fingerprint text;
    v_receipt public.omr_student_credential_batch_receipts%rowtype;
    v_locked_count integer;
    v_item record;
    v_epoch public.omr_student_credential_epochs%rowtype;
    v_account_id text;
    v_generation integer;
    v_now timestamptz;
begin
    if p_session_authority not in ('account', 'legacy_account')
       or nullif(pg_catalog.btrim(p_account_id), '') is null
       or nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or pg_catalog.octet_length(p_account_id) > 256
       or pg_catalog.octet_length(p_organization_id) > 256
       or pg_catalog.octet_length(p_actor_user_id) > 256
       or p_session_generation is null
       or p_session_generation < 1
       or p_session_generation > 9007199254740991
       or p_idempotency_key is null
       or pg_catalog.octet_length(p_idempotency_key) not between 38 and 128
       or p_idempotency_key !~ '^batch_[A-Za-z0-9_-]{32,122}$'
       or p_items is null
       or pg_catalog.jsonb_typeof(p_items) is distinct from 'array' then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if pg_catalog.jsonb_array_length(p_items) = 0 then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;
    if pg_catalog.jsonb_array_length(p_items) > 100 then
        return pg_catalog.jsonb_build_object('status', 'capacity_exceeded');
    end if;

    select pg_catalog.count(*)::integer,
           pg_catalog.count(distinct ((element ->> 'studentId') collate "C"))::integer,
           pg_catalog.bool_and(
               case when pg_catalog.jsonb_typeof(element) = 'object' then
                   (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(element)) = 2
                   and element ? 'studentId'
                   and element ? 'verifier'
                   and pg_catalog.jsonb_typeof(element -> 'studentId') = 'string'
                   and pg_catalog.jsonb_typeof(element -> 'verifier') = 'string'
                    and element ->> 'studentId' = pg_catalog.btrim(
                        element ->> 'studentId',
                        pg_catalog.chr(9) || pg_catalog.chr(10)
                        || pg_catalog.chr(11) || pg_catalog.chr(12)
                        || pg_catalog.chr(13) || pg_catalog.chr(32)
                        || pg_catalog.chr(160) || pg_catalog.chr(5760)
                        || pg_catalog.chr(8192) || pg_catalog.chr(8193)
                        || pg_catalog.chr(8194) || pg_catalog.chr(8195)
                        || pg_catalog.chr(8196) || pg_catalog.chr(8197)
                        || pg_catalog.chr(8198) || pg_catalog.chr(8199)
                        || pg_catalog.chr(8200) || pg_catalog.chr(8201)
                        || pg_catalog.chr(8202) || pg_catalog.chr(8232)
                        || pg_catalog.chr(8233) || pg_catalog.chr(8239)
                        || pg_catalog.chr(8287) || pg_catalog.chr(12288)
                        || pg_catalog.chr(65279)
                    )
                    and pg_catalog.octet_length(element ->> 'studentId') between 1 and 256
                    and element ->> 'studentId' !~ '[[:cntrl:]]'
                    and not exists (
                        select 1
                          from pg_catalog.generate_series(127, 159) forbidden(codepoint)
                         where pg_catalog.strpos(
                             element ->> 'studentId',
                             pg_catalog.chr(forbidden.codepoint)
                         ) > 0
                    )
                    and pg_catalog.strpos(element ->> 'studentId', pg_catalog.chr(133)) = 0
                    and pg_catalog.strpos(element ->> 'studentId', pg_catalog.chr(8232)) = 0
                    and pg_catalog.strpos(element ->> 'studentId', pg_catalog.chr(8233)) = 0
                    and pg_catalog.strpos(element ->> 'studentId', pg_catalog.chr(65279)) = 0
                   and element ->> 'verifier' ~ '^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$'
               else false end
           )
      into v_item_count, v_unique_count, v_items_valid
      from pg_catalog.jsonb_array_elements(p_items) element;
    if not coalesce(v_items_valid, false)
       or v_item_count not between 1 and 100
       or v_unique_count is distinct from v_item_count then
        return pg_catalog.jsonb_build_object('status', 'invalid_request');
    end if;

    select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                   'studentId', normalized.student_id,
                   'verifier', normalized.verifier
               ) order by normalized.student_id collate "C"
           ),
           pg_catalog.array_agg(normalized.student_id order by normalized.student_id collate "C")
      into v_canonical_items, v_student_ids
      from (
          select item."studentId" as student_id, item.verifier
            from pg_catalog.jsonb_to_recordset(p_items)
                 as item("studentId" text, verifier text)
      ) normalized;

    v_idempotency_key_hash := pg_catalog.encode(
        extensions.digest(p_idempotency_key, 'sha256'),
        'hex'
    );
    v_request_fingerprint := pg_catalog.encode(
        extensions.digest(
            pg_catalog.jsonb_build_object(
                'sessionAuthority', p_session_authority,
                'accountId', pg_catalog.btrim(p_account_id),
                'sessionGeneration', p_session_generation,
                'organizationId', pg_catalog.btrim(p_organization_id),
                    'actorUserId', pg_catalog.btrim(p_actor_user_id),
                    'studentIds', pg_catalog.to_jsonb(v_student_ids),
                    'studentCount', v_item_count
            )::text,
            'sha256'
        ),
        'hex'
    );

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'omr_roster:' || pg_catalog.btrim(p_organization_id),
            0
        )
    );
    v_identity := public.omr_lock_teacher_mutation_identity_v1(
        p_session_authority,
        pg_catalog.btrim(p_account_id),
        p_session_generation,
        pg_catalog.btrim(p_organization_id),
        pg_catalog.btrim(p_actor_user_id)
    );
    if v_identity is null
       or v_identity ->> 'memberRole' not in ('owner', 'admin', 'teacher', 'assistant') then
        return pg_catalog.jsonb_build_object('status', 'unauthorized');
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'omr_student_credential_batch_receipt:'
            || pg_catalog.btrim(p_organization_id) || ':' || v_idempotency_key_hash,
            608010
        )
    );
    select receipt.* into v_receipt
      from public.omr_student_credential_batch_receipts receipt
     where receipt.organization_id = pg_catalog.btrim(p_organization_id)
       and receipt.idempotency_key_hash = v_idempotency_key_hash
     for update;
    if found then
        if v_receipt.request_fingerprint is distinct from v_request_fingerprint
           or v_receipt.student_count is distinct from v_item_count then
            return pg_catalog.jsonb_build_object('status', 'idempotency_conflict');
        end if;
        if v_receipt.state = 'applied' then
            return pg_catalog.jsonb_build_object(
                'status', 'already_applied',
                'count', v_item_count,
                'studentIds', pg_catalog.to_jsonb(v_student_ids)
            );
        end if;
        raise exception 'student credential receipt remained pending';
    end if;

    -- Lock every profile in deterministic byte order before touching any epoch.
    perform student.id
      from public.omr_student_profiles student
     where student.organization_id = pg_catalog.btrim(p_organization_id)
       and student.id = any(v_student_ids)
     order by student.id collate "C"
     for update;
    get diagnostics v_locked_count = row_count;
    if v_locked_count is distinct from v_item_count
       or exists (
           select 1
             from public.omr_student_profiles student
            where student.organization_id = pg_catalog.btrim(p_organization_id)
              and student.id = any(v_student_ids)
              and student.status not in ('invited', 'active')
       ) then
        return pg_catalog.jsonb_build_object('status', 'student_unavailable');
    end if;

    -- Missing epochs are valid only for a never-issued generation-1 profile.
    perform epoch.student_profile_id
      from public.omr_student_credential_epochs epoch
     where epoch.organization_id = pg_catalog.btrim(p_organization_id)
       and epoch.student_profile_id = any(v_student_ids)
     order by epoch.student_profile_id collate "C"
     for update;

    perform credential.student_profile_id
      from public.omr_student_start_credentials credential
     where credential.organization_id = pg_catalog.btrim(p_organization_id)
       and credential.student_profile_id = any(v_student_ids)
     order by credential.student_profile_id collate "C"
     for update;

    if exists (
        select 1 from public.omr_student_credential_epochs epoch
         where epoch.organization_id = pg_catalog.btrim(p_organization_id)
           and epoch.student_profile_id = any(v_student_ids)
           and epoch.credential_generation >= 2147483646
    ) then
        raise exception 'student credential generation exhausted';
    end if;

    if exists (
        select 1
          from public.omr_student_profiles student
          left join public.omr_student_credential_epochs epoch
            on epoch.organization_id = student.organization_id
           and epoch.student_profile_id = student.id
          left join public.omr_student_start_credentials credential
            on credential.organization_id = student.organization_id
           and credential.student_profile_id = student.id
         where student.organization_id = pg_catalog.btrim(p_organization_id)
           and student.id = any(v_student_ids)
           and (
               (epoch.student_profile_id is null and (
                   student.credential_generation <> 1
                   or credential.student_profile_id is not null
               ))
               or (epoch.student_profile_id is not null and (
                   (credential.student_profile_id is null and
                       student.credential_generation not in (1, epoch.credential_generation))
                   or (credential.student_profile_id is not null and (
                       student.credential_generation is distinct from epoch.credential_generation
                       or
                       credential.account_id is distinct from epoch.account_id
                       or credential.credential_generation is distinct from epoch.credential_generation
                   ))
               ))
           )
    ) then
        raise exception 'student credential generation drift';
    end if;

    insert into public.omr_student_credential_batch_receipts (
        organization_id,
        idempotency_key_hash,
        request_fingerprint,
        student_count,
        state
    ) values (
        pg_catalog.btrim(p_organization_id),
        v_idempotency_key_hash,
        v_request_fingerprint,
        v_item_count,
        'pending'
    )
    on conflict (organization_id, idempotency_key_hash) do nothing;
    if not found then
        raise exception 'student credential receipt serialization failure';
    end if;

    for v_item in
        select item."studentId" as student_id, item.verifier
          from pg_catalog.jsonb_to_recordset(v_canonical_items)
               as item("studentId" text, verifier text)
         order by item."studentId" collate "C"
    loop
        v_account_id := null;
        v_generation := null;
        select epoch.* into v_epoch
          from public.omr_student_credential_epochs epoch
         where epoch.organization_id = pg_catalog.btrim(p_organization_id)
           and epoch.student_profile_id = v_item.student_id;
        if found then
            update public.omr_student_credential_epochs epoch
               set account_id = 'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
                   credential_generation = epoch.credential_generation + 1,
                   updated_at = pg_catalog.clock_timestamp()
             where epoch.organization_id = pg_catalog.btrim(p_organization_id)
               and epoch.student_profile_id = v_item.student_id
               and epoch.credential_generation < 2147483646
            returning epoch.account_id, epoch.credential_generation
                 into v_account_id, v_generation;
        else
            insert into public.omr_student_credential_epochs (
                organization_id,
                student_profile_id,
                account_id,
                credential_generation,
                created_at,
                updated_at
            ) values (
                pg_catalog.btrim(p_organization_id),
                v_item.student_id,
                'student_credential_' || pg_catalog.encode(extensions.gen_random_bytes(16), 'hex'),
                1,
                pg_catalog.clock_timestamp(),
                pg_catalog.clock_timestamp()
            ) returning account_id, credential_generation into v_account_id, v_generation;
        end if;
        if v_account_id is null or v_generation is null then
            raise exception 'student credential generation exhausted';
        end if;

        update public.omr_student_profiles student
           set credential_generation = v_generation,
               updated_at = pg_catalog.clock_timestamp()
         where student.organization_id = pg_catalog.btrim(p_organization_id)
           and student.id = v_item.student_id;
        if not found then
            raise exception 'student profile disappeared during credential issuance';
        end if;

        insert into public.omr_student_start_credentials (
            organization_id,
            student_profile_id,
            start_code_hash,
            account_id,
            credential_generation,
            updated_at
        ) values (
            pg_catalog.btrim(p_organization_id),
            v_item.student_id,
            v_item.verifier,
            v_account_id,
            v_generation,
            pg_catalog.clock_timestamp()
        )
        on conflict (organization_id, student_profile_id) do update
           set start_code_hash = excluded.start_code_hash,
               account_id = excluded.account_id,
               credential_generation = excluded.credential_generation,
               updated_at = excluded.updated_at;
    end loop;

    v_now := pg_catalog.clock_timestamp();
    insert into public.omr_audit_logs (
        id,
        organization_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        metadata,
        created_at
    ) values (
        'audit_credential_batch_' || pg_catalog.encode(extensions.gen_random_bytes(12), 'hex'),
        pg_catalog.btrim(p_organization_id),
        pg_catalog.btrim(p_actor_user_id),
        'student_start_code_batch_issued',
        'student_credential_batch',
        null,
        pg_catalog.jsonb_build_object(
            'studentCount', v_item_count,
            'sessionAuthority', p_session_authority
        ),
        v_now
    );

    update public.omr_student_credential_batch_receipts receipt
       set state = 'applied', applied_at = v_now
     where receipt.organization_id = pg_catalog.btrim(p_organization_id)
       and receipt.idempotency_key_hash = v_idempotency_key_hash
       and receipt.request_fingerprint = v_request_fingerprint
       and receipt.state = 'pending';
    if not found then
        raise exception 'student credential receipt finalization failure';
    end if;

    return pg_catalog.jsonb_build_object(
        'status', 'issued',
        'count', v_item_count,
        'studentIds', pg_catalog.to_jsonb(v_student_ids)
    );
end;
$$;

comment on function public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text) is
    'Atomically issues 1-100 verifier-only student credentials with no secret replay.';
alter function public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)
    owner to postgres;
revoke all on function public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)
    from public, anon, authenticated;
grant execute on function public.omr_issue_student_start_code_batch_v1(text,text,bigint,text,text,jsonb,text)
    to service_role;

-- The one-student mutation bypass is retired. Compatibility callers must route
-- through the batch gateway so every issuance has the same receipt and audit.
revoke all on function public.omr_rotate_student_start_credential_v1(text,text,bigint,text,text,text,text)
    from public, anon, authenticated, service_role;

commit;
