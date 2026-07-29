-- OMR Maker production server-only data boundary — ROLLBACK.
--
-- Inverse of supabase/production-server-boundary.sql, split into three stages
-- because they are not equally safe. Rolling this back means giving browser
-- roles their access back, so the stages are ordered by how much they re-expose
-- and the destructive ones refuse to run without an explicit confirmation.
--
--   STAGE 1  Storage only. Removes the restrictive policies that closed the
--            omr-private-assets bucket. Runs unconditionally. This is the stage
--            you almost certainly want: it is the only part of the boundary that
--            touches Supabase-managed relations, so it is the most likely thing
--            to have broken something unexpected.
--
--   STAGE 2  Browser role privileges on schema public. Re-exposes application
--            data to anon/authenticated. Requires confirmation.
--
--   STAGE 3  The 25 alpha allow-all RLS policies from schema.sql, and the FORCE
--            RLS flags. Returns the database to "anyone with the publishable key
--            can read and write everything". Requires confirmation.
--
-- Run only STAGE 1 unless you specifically need the others. Stages 2 and 3 are
-- pointless on their own — with no grants, policies do nothing, and with no
-- policies, grants are still blocked by RLS — so use 2+3 together or neither.
--
-- To enable stages 2 and 3, in the same session:
--
--     set omr.rollback_confirm = 'restore-browser-access';
--
-- WHAT THIS DOES NOT DO
--
--   - It does not restore the Supabase Auth policies from production-rls.sql.
--     If a database rehearsed that profile before the server-only cutover, run
--     production-rls.sql again instead of stage 3.
--   - It does not undo migrations. The gateway RPCs, preflight functions and
--     schema changes stay; they are additive and the app needs them.
--   - It does not re-create "OMR private assets alpha access" on
--     storage.objects. That policy is a test fixture from live-test-prelude.sql,
--     not a production object — a hosted project's own bucket policies are
--     whatever you configured them to be, and stage 1 leaves those untouched.
--
-- Verified by scripts/verify-supabase-live.mjs against PostgreSQL 17: boundary
-- applies, rollback reverts, and browser CRUD is denied before and permitted
-- after the full three-stage run.

-- ---------------------------------------------------------------------------
-- STAGE 1 — Storage: reopen the private bucket to browser roles.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'rollback must run as migration owner postgres';
    end if;
    if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin')
        or not pg_has_role(session_user, 'supabase_storage_admin', 'SET')
    then
        raise exception using
            errcode = '42501',
            message = 'postgres must be able to SET ROLE supabase_storage_admin';
    end if;
end
$$;

-- Same owner dance as the boundary: Supabase requires managed Storage entities
-- to retain supabase_storage_admin ownership, so enter that role only for the
-- policy phase. Dropping the restrictive policies is enough — restrictive
-- policies only ever subtract, so removing them restores whatever permissive
-- policies the project already had.
set local role supabase_storage_admin;

drop policy if exists "OMR private assets server-only objects" on storage.objects;
drop policy if exists "OMR private assets server-only buckets" on storage.buckets;

reset role;

commit;

-- ---------------------------------------------------------------------------
-- STAGE 2 — Browser role privileges on schema public.
--
-- DANGER: after this, anon/authenticated can reach application tables again
-- (subject to RLS). Requires omr.rollback_confirm.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'rollback must run as migration owner postgres';
    end if;
    if current_setting('omr.rollback_confirm', true) is distinct from 'restore-browser-access' then
        raise exception using
            errcode = '42501',
            message = 'stage 2 re-exposes application data to browser roles; '
                   || 'run: set omr.rollback_confirm = ''restore-browser-access'';';
    end if;
end
$$;

-- Undo the fail-closed default privileges first, so objects created after this
-- point behave like they did before the boundary.
alter default privileges for role postgres in schema public
    grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public
    grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public
    grant execute on functions to anon, authenticated;
alter default privileges for role postgres
    grant execute on functions to public;

grant usage on schema public to anon, authenticated;
grant all on all tables in schema public to anon, authenticated;
grant all on all sequences in schema public to anon, authenticated;
grant execute on all functions in schema public to anon, authenticated;

-- service_role keeps everything it had; the boundary granted it and nothing
-- here takes it away.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- CRITICAL: the blanket grants above are broader than the alpha baseline ever
-- was. schema.sql and the migrations explicitly revoked a set of tables and
-- SECURITY DEFINER RPCs from browser roles even while everything else was wide
-- open — re-granting without re-revoking would leave the database MORE exposed
-- after a rollback than it was before the boundary was ever applied. Restore
-- those revokes here.
revoke all on public.omr_student_start_credentials from anon, authenticated;
revoke all on public.omr_roster_invites from anon, authenticated;

do $$
declare
    guarded_function text;
    guarded_functions text[] := array[
        'omr_answer_attempt_question_v1',
        'omr_assert_production_boundary_preflight_v1',
        'omr_attach_attempt_handwriting_v1',
        'omr_claim_guest_attempts_v1',
        'omr_delete_exam_v1',
        'omr_force_finish_attempts_v1',
        'omr_guard_student_credential_mutation_v1',
        'omr_mark_feedback_opened_v2',
        'omr_production_boundary_preflight_v1',
        'omr_release_plan_usage',
        'omr_reserve_plan_usage',
        'omr_return_feedback_v1',
        'omr_revoke_withdrawn_student_credential_v1',
        'omr_save_exam_plan_unlocked_v1',
        'omr_save_exam_v1',
        'omr_save_feedback_v1',
        'omr_save_remote_asset_metadata_v1',
        'omr_save_roster_plan_unlocked_v1',
        'omr_save_roster_unlocked_v1',
        'omr_save_roster_v1',
        'omr_service_readiness_v1',
        'omr_set_subquestion_review_v1',
        'omr_submit_attempt_v1',
        'omr_submit_session_attempt_v1',
        'omr_sync_student_plan_usage',
        'omr_teacher_attempt_write_allowed_v1',
        'omr_teacher_update_attempt_v1'
    ];
begin
    -- Revoke every overload by identity so a signature change cannot silently
    -- leave one reachable.
    for guarded_function in select unnest(guarded_functions) loop
        execute (
            select coalesce(string_agg(
                format(
                    'revoke all on function public.%I(%s) from public, anon, authenticated;',
                    proc.proname,
                    pg_get_function_identity_arguments(proc.oid)
                ),
                ' '
            ), 'select 1;')
              from pg_proc proc
              join pg_namespace namespace on namespace.oid = proc.pronamespace
             where namespace.nspname = 'public'
               and proc.proname = guarded_function
        );
    end loop;
end
$$;

commit;

-- ---------------------------------------------------------------------------
-- STAGE 3 — Alpha allow-all RLS policies and FORCE RLS flags.
--
-- DANGER: this is the "anyone with the publishable key can read and write every
-- row" state. Do not run it on a database holding real student data.
-- Requires omr.rollback_confirm.
-- ---------------------------------------------------------------------------

begin;

do $$
begin
    if current_user is distinct from 'postgres' then
        raise exception using
            errcode = '42501',
            message = 'rollback must run as migration owner postgres';
    end if;
    if current_setting('omr.rollback_confirm', true) is distinct from 'restore-browser-access' then
        raise exception using
            errcode = '42501',
            message = 'stage 3 restores allow-all RLS policies; '
                   || 'run: set omr.rollback_confirm = ''restore-browser-access'';';
    end if;
end
$$;

-- FORCE RLS goes back off everywhere schema.sql did not set it. Only the two
-- credential/invite registries are FORCE in the alpha baseline; the boundary
-- forced all 27, so unforce the other 25. RLS itself stays ENABLED — that is
-- true in the alpha schema too.
alter table if exists public.omr_organizations no force row level security;
alter table if exists public.omr_plan_usage no force row level security;
alter table if exists public.omr_plan_usage_reservations no force row level security;
alter table if exists public.omr_user_profiles no force row level security;
alter table if exists public.omr_organization_members no force row level security;
alter table if exists public.omr_teacher_profiles no force row level security;
alter table if exists public.omr_student_profiles no force row level security;
alter table if exists public.omr_classes no force row level security;
alter table if exists public.omr_class_teachers no force row level security;
alter table if exists public.omr_class_students no force row level security;
alter table if exists public.omr_materials no force row level security;
alter table if exists public.omr_exams no force row level security;
alter table if exists public.omr_exam_questions no force row level security;
alter table if exists public.omr_exam_materials no force row level security;
alter table if exists public.omr_assignments no force row level security;
alter table if exists public.omr_assignment_targets no force row level security;
alter table if exists public.omr_attempts no force row level security;
alter table if exists public.omr_question_results no force row level security;
alter table if exists public.omr_assignment_submissions no force row level security;
alter table if exists public.omr_attempt_feedback no force row level security;
alter table if exists public.omr_kakao_candidate_reviews no force row level security;
alter table if exists public.omr_kakao_dispatch_logs no force row level security;
alter table if exists public.omr_comments no force row level security;
alter table if exists public.omr_audit_logs no force row level security;
alter table if exists public.omr_remote_assets no force row level security;

-- omr_student_start_credentials and omr_roster_invites keep FORCE RLS: schema.sql
-- sets it, so leaving it on is the correct alpha state, not an oversight.

-- The 25 alpha allow-all policies, verbatim from schema.sql. A contract test
-- asserts this list matches the set production-server-boundary.sql drops, so the
-- two files cannot drift apart.
drop policy if exists "OMR organizations are publicly writable" on public.omr_organizations;
create policy "OMR organizations are publicly writable" on public.omr_organizations for all using (true) with check (true);
drop policy if exists "OMR user profiles are publicly writable" on public.omr_user_profiles;
create policy "OMR user profiles are publicly writable" on public.omr_user_profiles for all using (true) with check (true);
drop policy if exists "OMR organization members are publicly writable" on public.omr_organization_members;
create policy "OMR organization members are publicly writable" on public.omr_organization_members for all using (true) with check (true);
drop policy if exists "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles;
create policy "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles for all using (true) with check (true);
drop policy if exists "OMR student profiles are publicly writable" on public.omr_student_profiles;
create policy "OMR student profiles are publicly writable" on public.omr_student_profiles for all using (true) with check (true);
drop policy if exists "OMR classes are publicly writable" on public.omr_classes;
create policy "OMR classes are publicly writable" on public.omr_classes for all using (true) with check (true);
drop policy if exists "OMR class teachers are publicly writable" on public.omr_class_teachers;
create policy "OMR class teachers are publicly writable" on public.omr_class_teachers for all using (true) with check (true);
drop policy if exists "OMR class students are publicly writable" on public.omr_class_students;
create policy "OMR class students are publicly writable" on public.omr_class_students for all using (true) with check (true);
drop policy if exists "OMR materials are publicly writable" on public.omr_materials;
create policy "OMR materials are publicly writable" on public.omr_materials for all using (true) with check (true);
drop policy if exists "OMR exams are publicly readable" on public.omr_exams;
create policy "OMR exams are publicly readable" on public.omr_exams for select using (true);
drop policy if exists "OMR exams are publicly writable" on public.omr_exams;
create policy "OMR exams are publicly writable" on public.omr_exams for all using (true) with check (true);
drop policy if exists "OMR exam questions are publicly writable" on public.omr_exam_questions;
create policy "OMR exam questions are publicly writable" on public.omr_exam_questions for all using (true) with check (true);
drop policy if exists "OMR exam materials are publicly writable" on public.omr_exam_materials;
create policy "OMR exam materials are publicly writable" on public.omr_exam_materials for all using (true) with check (true);
drop policy if exists "OMR assignments are publicly writable" on public.omr_assignments;
create policy "OMR assignments are publicly writable" on public.omr_assignments for all using (true) with check (true);
drop policy if exists "OMR assignment targets are publicly writable" on public.omr_assignment_targets;
create policy "OMR assignment targets are publicly writable" on public.omr_assignment_targets for all using (true) with check (true);
drop policy if exists "OMR attempts are publicly readable" on public.omr_attempts;
create policy "OMR attempts are publicly readable" on public.omr_attempts for select using (true);
drop policy if exists "OMR attempts are publicly writable" on public.omr_attempts;
create policy "OMR attempts are publicly writable" on public.omr_attempts for all using (true) with check (true);
drop policy if exists "OMR question results are publicly readable" on public.omr_question_results;
create policy "OMR question results are publicly readable" on public.omr_question_results for select using (true);
drop policy if exists "OMR question results are publicly writable" on public.omr_question_results;
create policy "OMR question results are publicly writable" on public.omr_question_results for all using (true) with check (true);
drop policy if exists "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions;
create policy "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions for all using (true) with check (true);
drop policy if exists "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback;
create policy "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback for all using (true) with check (true);
drop policy if exists "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews;
create policy "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews for all using (true) with check (true);
drop policy if exists "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs;
create policy "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs for all using (true) with check (true);
drop policy if exists "OMR comments are publicly writable" on public.omr_comments;
create policy "OMR comments are publicly writable" on public.omr_comments for all using (true) with check (true);
drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;
create policy "OMR audit logs are publicly writable" on public.omr_audit_logs for all using (true) with check (true);

commit;
