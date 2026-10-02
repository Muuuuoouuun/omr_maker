\set ON_ERROR_STOP on

begin;

do $kakao_quarantine_policy_attestation$
begin
    if (
        select pg_catalog.count(*)
          from pg_catalog.pg_policy policy
         where policy.polrelid =
                   'public.omr_kakao_reminder_legacy_quarantine'::pg_catalog.regclass
           and policy.polname = 'Kakao reminder quarantine service read'
           and policy.polcmd = 'r'
           and policy.polpermissive
           and policy.polroles = array[
               'service_role'::pg_catalog.regrole::pg_catalog.oid
           ]
           and pg_catalog.regexp_replace(
                   pg_catalog.lower(pg_catalog.pg_get_expr(
                       policy.polqual, policy.polrelid, true
                   )),
                   '\s+', '', 'g'
               ) = 'current_user=''service_role''::name'
    ) <> 1 then
        raise exception 'Kakao quarantine policy predicate drifted';
    end if;
end
$kakao_quarantine_policy_attestation$;

-- Six isolated teacher identities exercise paid, free, expired, superseded and
-- cross-organization behavior without sharing any grant provenance.
insert into public.omr_organizations (id, name, plan, metadata) values
    ('pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'Kakao Pro', 'free', '{}'::jsonb),
    ('pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'Kakao Academy', 'free', '{}'::jsonb),
    ('pilot_org_cccccccccccccccccccccccc', 'Kakao Expired', 'academy', '{}'::jsonb),
    ('pilot_org_dddddddddddddddddddddddd', 'Kakao Superseded', 'academy', '{}'::jsonb),
    ('pilot_org_eeeeeeeeeeeeeeeeeeeeeeee', 'Kakao Cross', 'free', '{}'::jsonb),
    ('teacher_kakaofree', 'Kakao Free', 'free', '{}'::jsonb);

insert into public.omr_teacher_accounts (
    id, email, display_name, password_hash, status, email_verified_at,
    session_generation
) values
    ('teacher_aaaaaaaaaaaaaaaa', 'kakao-pro@example.test', 'Kakao Pro Teacher',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('a', 64),
     'active', pg_catalog.now(), 11),
    ('teacher_bbbbbbbbbbbbbbbb', 'kakao-academy@example.test', 'Kakao Academy Teacher',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('b', 64),
     'active', pg_catalog.now(), 12),
    ('teacher_cccccccccccccccc', 'kakao-expired@example.test', 'Kakao Expired Teacher',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('c', 64),
     'active', pg_catalog.now(), 13),
    ('teacher_dddddddddddddddd', 'kakao-superseded@example.test', 'Kakao Superseded Teacher',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('d', 64),
     'active', pg_catalog.now(), 14),
    ('teacher_eeeeeeeeeeeeeeee', 'kakao-cross@example.test', 'Kakao Cross Teacher',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('e', 64),
     'active', pg_catalog.now(), 15),
    ('teacher_ffffffffffffffff', 'kakao-free@example.test', 'Kakao Free Teacher',
     'pbkdf2-sha256:120000:0123456789abcdef0123456789abcdef:' || repeat('f', 64),
     'active', pg_catalog.now(), 16);

insert into public.omr_organization_members (
    organization_id, user_id, email, display_name, role, status
) values
    ('pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
     'kakao-pro@example.test', 'Kakao Pro Teacher', 'owner', 'active'),
    ('pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_bbbbbbbbbbbbbbbb',
     'kakao-academy@example.test', 'Kakao Academy Teacher', 'owner', 'active'),
    ('pilot_org_cccccccccccccccccccccccc', 'teacher_cccccccccccccccc',
     'kakao-expired@example.test', 'Kakao Expired Teacher', 'owner', 'active'),
    ('pilot_org_dddddddddddddddddddddddd', 'teacher_dddddddddddddddd',
     'kakao-superseded@example.test', 'Kakao Superseded Teacher', 'owner', 'active'),
    ('pilot_org_eeeeeeeeeeeeeeeeeeeeeeee', 'teacher_eeeeeeeeeeeeeeee',
     'kakao-cross@example.test', 'Kakao Cross Teacher', 'owner', 'active'),
    ('teacher_kakaofree', 'teacher_kakaofree',
     'kakao-free@example.test', 'Kakao Free Teacher', 'owner', 'active');

insert into public.omr_teacher_profiles (
    organization_id, user_id, display_name, status
) values
    ('pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa', 'Kakao Pro Teacher', 'active'),
    ('pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_bbbbbbbbbbbbbbbb', 'Kakao Academy Teacher', 'active'),
    ('pilot_org_cccccccccccccccccccccccc', 'teacher_cccccccccccccccc', 'Kakao Expired Teacher', 'active'),
    ('pilot_org_dddddddddddddddddddddddd', 'teacher_dddddddddddddddd', 'Kakao Superseded Teacher', 'active'),
    ('pilot_org_eeeeeeeeeeeeeeeeeeeeeeee', 'teacher_eeeeeeeeeeeeeeee', 'Kakao Cross Teacher', 'active'),
    ('teacher_kakaofree', 'teacher_kakaofree', 'Kakao Free Teacher', 'active');

insert into public.omr_pilot_plan_grants (
    id, idempotency_key_hash, request_hash, organization_id, account_id,
    plan, expires_at, state, superseded_at
) values
    ('pilot_grant_aaaaaaaaaaaaaaaaaaaaaaaa', repeat('1', 64), repeat('a', 64),
     'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
     'pro', pg_catalog.clock_timestamp() + interval '1 day', 'active', null),
    ('pilot_grant_bbbbbbbbbbbbbbbbbbbbbbbb', repeat('2', 64), repeat('b', 64),
     'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_bbbbbbbbbbbbbbbb',
     'academy', pg_catalog.clock_timestamp() + interval '1 day', 'active', null),
    ('pilot_grant_cccccccccccccccccccccccc', repeat('3', 64), repeat('c', 64),
     'pilot_org_cccccccccccccccccccccccc', 'teacher_cccccccccccccccc',
     'academy', pg_catalog.clock_timestamp() + interval '1 day', 'active', null),
    ('pilot_grant_dddddddddddddddddddddddd', repeat('4', 64), repeat('d', 64),
     'pilot_org_dddddddddddddddddddddddd', 'teacher_dddddddddddddddd',
     'academy', pg_catalog.clock_timestamp() + interval '1 day', 'superseded',
     pg_catalog.clock_timestamp()),
    ('pilot_grant_eeeeeeeeeeeeeeeeeeeeeeee', repeat('5', 64), repeat('e', 64),
     'pilot_org_eeeeeeeeeeeeeeeeeeeeeeee', 'teacher_eeeeeeeeeeeeeeee',
     'pro', pg_catalog.clock_timestamp() + interval '1 day', 'active', null);

update public.omr_pilot_plan_grants
   set created_at = pg_catalog.clock_timestamp() - interval '2 days',
       expires_at = pg_catalog.clock_timestamp() - interval '1 minute',
       updated_at = pg_catalog.clock_timestamp()
 where id = 'pilot_grant_cccccccccccccccccccccccc';

insert into public.omr_exams (
    id, organization_id, title, payload, created_by_user_id,
    created_at, updated_at, archived
) values
    ('kakao-pro-exam', 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'Kakao Pro Exam',
     '{"id":"kakao-pro-exam"}'::jsonb, 'teacher_aaaaaaaaaaaaaaaa',
     pg_catalog.now(), pg_catalog.now(), false),
    ('kakao-pro-other-exam', 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'Kakao Other Exam',
     '{"id":"kakao-pro-other-exam"}'::jsonb, 'teacher_aaaaaaaaaaaaaaaa',
     pg_catalog.now(), pg_catalog.now(), false),
    ('kakao-academy-exam', 'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'Kakao Academy Exam',
     '{"id":"kakao-academy-exam"}'::jsonb, 'teacher_bbbbbbbbbbbbbbbb',
     pg_catalog.now(), pg_catalog.now(), false),
    ('kakao-expired-exam', 'pilot_org_cccccccccccccccccccccccc', 'Kakao Expired Exam',
     '{"id":"kakao-expired-exam"}'::jsonb, 'teacher_cccccccccccccccc',
     pg_catalog.now(), pg_catalog.now(), false),
    ('kakao-superseded-exam', 'pilot_org_dddddddddddddddddddddddd', 'Kakao Superseded Exam',
     '{"id":"kakao-superseded-exam"}'::jsonb, 'teacher_dddddddddddddddd',
     pg_catalog.now(), pg_catalog.now(), false),
    ('kakao-cross-exam', 'pilot_org_eeeeeeeeeeeeeeeeeeeeeeee', 'Kakao Cross Exam',
     '{"id":"kakao-cross-exam"}'::jsonb, 'teacher_eeeeeeeeeeeeeeee',
     pg_catalog.now(), pg_catalog.now(), false),
    ('kakao-free-exam', 'teacher_kakaofree', 'Kakao Free Exam',
     '{"id":"kakao-free-exam"}'::jsonb, 'teacher_kakaofree',
     pg_catalog.now(), pg_catalog.now(), false);

-- Pre-cutover reviews let each non-paid state prove dispatch denial without
-- weakening the new write boundary to seed through the RPC itself.
insert into public.omr_kakao_candidate_reviews (
    id, organization_id, exam_id, candidate_kind, status, title, target_count,
    student_ids, student_names, message_preview, reviewed_by_user_id, payload,
    entitlement_state
) values (
    'kakao:expired:ready', 'pilot_org_cccccccccccccccccccccccc',
    'kakao-expired-exam', 'missing_exam', 'ready', 'Expired Ready', 1,
    array['expired-student'], array['만료 학생'], '만료 대상',
    'teacher_cccccccccccccccc', '{"source":"pre-cutover"}'::jsonb, 'trusted'
), (
    'kakao:superseded:ready', 'pilot_org_dddddddddddddddddddddddd',
    'kakao-superseded-exam', 'missing_exam', 'ready', 'Superseded Ready', 1,
    array['superseded-student'], array['대체 학생'], '대체 대상',
    'teacher_dddddddddddddddd', '{"source":"pre-cutover"}'::jsonb, 'trusted'
), (
    'kakao:free:ready', 'teacher_kakaofree',
    'kakao-free-exam', 'missing_exam', 'ready', 'Free Ready', 1,
    array['free-student'], array['무료 학생'], '무료 대상',
    'teacher_kakaofree', '{"source":"pre-cutover"}'::jsonb, 'trusted'
);

do $$
begin
    if exists (
        select 1
          from pg_catalog.aclexplode(
              coalesce(
                  (select relation.relacl from pg_catalog.pg_class relation
                    where relation.oid = 'public.omr_kakao_candidate_reviews'::regclass),
                  pg_catalog.acldefault('r', 'postgres'::regrole)
              )
          ) privilege
         where privilege.grantee = 0
           and privilege.privilege_type in (
               'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
           )
    ) or exists (
        select 1
          from pg_catalog.aclexplode(
              coalesce(
                  (select relation.relacl from pg_catalog.pg_class relation
                    where relation.oid = 'public.omr_kakao_dispatch_logs'::regclass),
                  pg_catalog.acldefault('r', 'postgres'::regrole)
              )
          ) privilege
         where privilege.grantee = 0
           and privilege.privilege_type in (
               'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'
           )
    ) then
        raise exception 'PUBLIC retained direct Kakao reminder DML';
    end if;
    if exists (
        select 1 from pg_catalog.unnest(array['anon', 'authenticated', 'service_role']) role_name
         where pg_catalog.has_table_privilege(
             role_name, 'public.omr_kakao_candidate_reviews',
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         ) or pg_catalog.has_table_privilege(
             role_name, 'public.omr_kakao_dispatch_logs',
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
         )
    ) then
        raise exception 'application role retained direct Kakao reminder DML';
    end if;
    if not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'anon',
        'public.omr_save_kakao_candidate_review_v1(text,text,bigint,text,text,jsonb)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated',
        'public.omr_save_kakao_simulation_dispatch_v1(text,text,bigint,text,text,jsonb)',
        'EXECUTE'
    ) then
        raise exception 'Kakao reminder RPC execute ACL mismatch';
    end if;
end
$$;

set local role service_role;

do $kakao_behavior$
declare
    v_result jsonb;
    v_review jsonb;
    v_dispatch jsonb;
    v_before integer;
    v_reviewed_at timestamptz;
begin
    v_review := pg_catalog.jsonb_build_object(
        'id', 'kakao:pro:missing', 'examId', 'kakao-pro-exam',
        'candidateKind', 'missing_exam', 'status', 'ready',
        'title', '미응시 확인', 'targetCount', 2,
        'studentIds', pg_catalog.jsonb_build_array('student-1', 'student-2'),
        'studentNames', pg_catalog.jsonb_build_array('김학생', '이학생'),
        'groupNames', '[]'::jsonb, 'regionNames', '[]'::jsonb,
        'messagePreview', '미응시 확인이 필요합니다.',
        'reason', null, 'href', '/dashboard?exam=kakao-pro-exam'
    );
    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'Pro Kakao review failed: %', v_result;
    end if;
    select reviewed_at into v_reviewed_at
      from public.omr_kakao_candidate_reviews where id = 'kakao:pro:missing';
    if not exists (
        select 1 from public.omr_kakao_candidate_reviews review
         where review.id = 'kakao:pro:missing'
           and review.organization_id = 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa'
           and review.exam_id = 'kakao-pro-exam'
           and review.reviewed_by_user_id = 'teacher_aaaaaaaaaaaaaaaa'
           and review.student_ids = array['student-1', 'student-2']
           and review.reviewed_at = review.updated_at
           and review.reviewed_at <= pg_catalog.clock_timestamp()
    ) then
        raise exception 'Pro Kakao review server-owned scope/stamps mismatch';
    end if;

    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_bbbbbbbbbbbbbbbb', 12,
        'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_bbbbbbbbbbbbbbbb',
        v_review || pg_catalog.jsonb_build_object(
            'id', 'kakao:academy:missing', 'examId', 'kakao-academy-exam'
        )
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'Academy Kakao review failed: %', v_result;
    end if;

    v_before := (select pg_catalog.count(*) from public.omr_kakao_candidate_reviews);
    v_result := public.omr_save_kakao_candidate_review_v1(
        'legacy_account', 'teacher_ffffffffffffffff', 16,
        'teacher_kakaofree', 'teacher_kakaofree',
        v_review || pg_catalog.jsonb_build_object(
            'id', 'kakao:free:denied', 'examId', 'kakao-free-exam'
        )
    );
    if v_result ->> 'status' <> 'plan_denied'
       or (select pg_catalog.count(*) from public.omr_kakao_candidate_reviews) <> v_before then
        raise exception 'Free Kakao review changed rows: %', v_result;
    end if;
    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_cccccccccccccccc', 13,
        'pilot_org_cccccccccccccccccccccccc', 'teacher_cccccccccccccccc',
        v_review || pg_catalog.jsonb_build_object(
            'id', 'kakao:expired:denied', 'examId', 'kakao-expired-exam'
        )
    );
    if v_result ->> 'status' <> 'plan_denied'
       or (select pg_catalog.count(*) from public.omr_kakao_candidate_reviews) <> v_before then
        raise exception 'expired Kakao review changed rows: %', v_result;
    end if;
    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_dddddddddddddddd', 14,
        'pilot_org_dddddddddddddddddddddddd', 'teacher_dddddddddddddddd',
        v_review || pg_catalog.jsonb_build_object(
            'id', 'kakao:superseded:denied', 'examId', 'kakao-superseded-exam'
        )
    );
    if v_result ->> 'status' <> 'plan_denied'
       or (select pg_catalog.count(*) from public.omr_kakao_candidate_reviews) <> v_before then
        raise exception 'superseded Kakao review changed rows: %', v_result;
    end if;

    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review || pg_catalog.jsonb_build_object(
            'id', 'kakao:cross:denied', 'examId', 'kakao-cross-exam'
        )
    );
    if v_result ->> 'status' <> 'unauthorized'
       or (select pg_catalog.count(*) from public.omr_kakao_candidate_reviews) <> v_before then
        raise exception 'cross-org Kakao review changed rows: %', v_result;
    end if;

    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_bbbbbbbbbbbbbbbb', 12,
        'pilot_org_bbbbbbbbbbbbbbbbbbbbbbbb', 'teacher_bbbbbbbbbbbbbbbb',
        v_review || pg_catalog.jsonb_build_object(
            'examId', 'kakao-academy-exam'
        )
    );
    if v_result ->> 'status' <> 'unauthorized'
       or (select exam_id from public.omr_kakao_candidate_reviews
            where id = 'kakao:pro:missing') <> 'kakao-pro-exam' then
        raise exception 'review ID rebound across organizations: %', v_result;
    end if;
    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review || pg_catalog.jsonb_build_object('examId', 'kakao-pro-other-exam')
    );
    if v_result ->> 'status' <> 'scope_conflict'
       or (select exam_id from public.omr_kakao_candidate_reviews
            where id = 'kakao:pro:missing') <> 'kakao-pro-exam' then
        raise exception 'review ID rebound within organization: %', v_result;
    end if;
    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review || pg_catalog.jsonb_build_object('extra', true)
    );
    if v_result ->> 'status' <> 'invalid_request'
       or (select reviewed_at from public.omr_kakao_candidate_reviews
            where id = 'kakao:pro:missing') is distinct from v_reviewed_at then
        raise exception 'invalid review payload crossed boundary: %', v_result;
    end if;

    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review || pg_catalog.jsonb_build_object(
            'id', 'kakao:pro:hold', 'status', 'hold'
        )
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'hold review setup failed: %', v_result;
    end if;

    v_dispatch := pg_catalog.jsonb_build_object(
        'id', 'kakao:dispatch:pro:1', 'reviewId', 'kakao:pro:hold',
        'examId', 'kakao-pro-exam', 'status', 'queued',
        'providerMessageId', null, 'errorMessage', null
    );
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch
    );
    if v_result ->> 'status' <> 'invalid_transition'
       or exists (select 1 from public.omr_kakao_dispatch_logs
                   where id = 'kakao:dispatch:pro:1') then
        raise exception 'hold review queued a simulation: %', v_result;
    end if;

    v_dispatch := v_dispatch || pg_catalog.jsonb_build_object(
        'id', 'kakao:dispatch:pro:2', 'reviewId', 'kakao:pro:missing'
    );
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'ready review did not queue simulation: %', v_result;
    end if;
    if not exists (
        select 1 from public.omr_kakao_dispatch_logs dispatch
         where dispatch.id = 'kakao:dispatch:pro:2'
           and dispatch.organization_id = 'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa'
           and dispatch.provider = 'simulation'
           and dispatch.status = 'queued'
           and dispatch.target_count = 2
           and dispatch.student_ids = array['student-1', 'student-2']
           and dispatch.created_at <= pg_catalog.clock_timestamp()
           and dispatch.payload ->> 'actorUserId' = 'teacher_aaaaaaaaaaaaaaaa'
    ) then
        raise exception 'queued simulation did not use server review scope/stamps';
    end if;

    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review || pg_catalog.jsonb_build_object('status', 'hold')
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'queued review hold setup failed: %', v_result;
    end if;
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch || pg_catalog.jsonb_build_object(
            'status', 'sent', 'providerMessageId', 'simulation:held-message'
        )
    );
    if v_result ->> 'status' <> 'invalid_transition'
       or (select status from public.omr_kakao_dispatch_logs
            where id = 'kakao:dispatch:pro:2') <> 'queued' then
        raise exception 'held review allowed a terminal dispatch: %', v_result;
    end if;
    v_result := public.omr_save_kakao_candidate_review_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_review
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'queued review ready restoration failed: %', v_result;
    end if;

    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch || pg_catalog.jsonb_build_object(
            'status', 'sent', 'providerMessageId', 'simulation:message-1'
        )
    );
    if v_result ->> 'status' <> 'saved'
       or not exists (
           select 1 from public.omr_kakao_dispatch_logs
            where id = 'kakao:dispatch:pro:2' and status = 'sent'
              and provider_message_id = 'simulation:message-1' and sent_at is not null
       ) then
        raise exception 'queued simulation did not reach sent terminal: %', v_result;
    end if;
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch || pg_catalog.jsonb_build_object(
            'status', 'sent', 'providerMessageId', 'simulation:message-1'
        )
    );
    if v_result ->> 'status' <> 'saved' then
        raise exception 'exact terminal simulation replay was not idempotent: %', v_result;
    end if;
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch || pg_catalog.jsonb_build_object(
            'status', 'sent', 'providerMessageId', 'simulation:message-forged'
        )
    );
    if v_result ->> 'status' <> 'invalid_transition'
       or (select provider_message_id from public.omr_kakao_dispatch_logs
            where id = 'kakao:dispatch:pro:2') <> 'simulation:message-1' then
        raise exception 'conflicting same-terminal replay was acknowledged: %', v_result;
    end if;
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_aaaaaaaaaaaaaaaa', 11,
        'pilot_org_aaaaaaaaaaaaaaaaaaaaaaaa', 'teacher_aaaaaaaaaaaaaaaa',
        v_dispatch || pg_catalog.jsonb_build_object(
            'status', 'failed', 'errorMessage', 'provider timeout'
        )
    );
    if v_result ->> 'status' <> 'invalid_transition'
       or (select status from public.omr_kakao_dispatch_logs
            where id = 'kakao:dispatch:pro:2') <> 'sent' then
        raise exception 'terminal simulation transition was reversible: %', v_result;
    end if;

    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'legacy_account', 'teacher_ffffffffffffffff', 16,
        'teacher_kakaofree', 'teacher_kakaofree',
        pg_catalog.jsonb_build_object(
            'id', 'kakao:dispatch:free', 'reviewId', 'kakao:free:ready',
            'examId', 'kakao-free-exam', 'status', 'queued',
            'providerMessageId', null, 'errorMessage', null
        )
    );
    if v_result ->> 'status' <> 'plan_denied'
       or exists (select 1 from public.omr_kakao_dispatch_logs
                   where id = 'kakao:dispatch:free') then
        raise exception 'Free plan queued a simulation: %', v_result;
    end if;

    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_cccccccccccccccc', 13,
        'pilot_org_cccccccccccccccccccccccc', 'teacher_cccccccccccccccc',
        pg_catalog.jsonb_build_object(
            'id', 'kakao:dispatch:expired', 'reviewId', 'kakao:expired:ready',
            'examId', 'kakao-expired-exam', 'status', 'queued',
            'providerMessageId', null, 'errorMessage', null
        )
    );
    if v_result ->> 'status' <> 'plan_denied'
       or exists (select 1 from public.omr_kakao_dispatch_logs
                   where id = 'kakao:dispatch:expired') then
        raise exception 'expired plan queued a simulation: %', v_result;
    end if;
    v_result := public.omr_save_kakao_simulation_dispatch_v1(
        'account', 'teacher_dddddddddddddddd', 14,
        'pilot_org_dddddddddddddddddddddddd', 'teacher_dddddddddddddddd',
        pg_catalog.jsonb_build_object(
            'id', 'kakao:dispatch:superseded', 'reviewId', 'kakao:superseded:ready',
            'examId', 'kakao-superseded-exam', 'status', 'queued',
            'providerMessageId', null, 'errorMessage', null
        )
    );
    if v_result ->> 'status' <> 'plan_denied'
       or exists (select 1 from public.omr_kakao_dispatch_logs
                   where id = 'kakao:dispatch:superseded') then
        raise exception 'superseded plan queued a simulation: %', v_result;
    end if;
end
$kakao_behavior$;

reset role;

do $kakao_binding_delete_guard$
begin
    begin
        delete from public.omr_kakao_candidate_reviews
         where id = 'kakao:pro:missing';
        raise exception 'dispatch review binding was deletable';
    exception
        when foreign_key_violation then null;
    end;

    begin
        delete from public.omr_exams where id = 'kakao-pro-exam';
        raise exception 'dispatch exam binding was deletable';
    exception
        when foreign_key_violation then null;
    end;
end
$kakao_binding_delete_guard$;

rollback;
