-- OMR Maker production server-only data boundary.
--
-- Apply only after every migration, including the organization-integrity
-- preflight. This profile is intentionally incompatible with browser-side
-- canonical CRUD: anon/authenticated receive no public app table, sequence, or
-- function privileges. Canonical access must use trusted server actions with
-- the service-role key.

begin;

-- Fail before changing privileges. The assertion is SECURITY DEFINER,
-- service-role-only, bounded, and reports no PII or raw row identifiers.
select public.omr_assert_production_boundary_preflight_v1();

-- Close current objects and the schema itself to browser roles. PUBLIC must be
-- revoked as well because function EXECUTE is granted to PUBLIC by default.
revoke all on schema public from public, anon, authenticated;
revoke all on all tables in schema public from public, anon, authenticated;
revoke all on all sequences in schema public from public, anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Keep trusted server/service-role gateways operational, including trigger
-- helpers and future server RPCs created before this profile is applied.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant all on all functions in schema public to service_role;

-- Keep future public-schema objects fail-closed when migrations run as the
-- profile owner. Reapplying this file is safe.
alter default privileges in schema public
    revoke all on tables from public, anon, authenticated;
alter default privileges in schema public
    revoke all on sequences from public, anon, authenticated;
alter default privileges in schema public
    revoke all on functions from public, anon, authenticated;
alter default privileges in schema public
    grant all on tables to service_role;
alter default privileges in schema public
    grant all on sequences to service_role;
alter default privileges in schema public
    grant all on functions to service_role;

-- Alpha allow-all policies from schema.sql.
drop policy if exists "OMR organizations are publicly writable" on public.omr_organizations;
drop policy if exists "OMR user profiles are publicly writable" on public.omr_user_profiles;
drop policy if exists "OMR organization members are publicly writable" on public.omr_organization_members;
drop policy if exists "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles;
drop policy if exists "OMR student profiles are publicly writable" on public.omr_student_profiles;
drop policy if exists "OMR classes are publicly writable" on public.omr_classes;
drop policy if exists "OMR class teachers are publicly writable" on public.omr_class_teachers;
drop policy if exists "OMR class students are publicly writable" on public.omr_class_students;
drop policy if exists "OMR materials are publicly writable" on public.omr_materials;
drop policy if exists "OMR exams are publicly readable" on public.omr_exams;
drop policy if exists "OMR exams are publicly writable" on public.omr_exams;
drop policy if exists "OMR exam questions are publicly writable" on public.omr_exam_questions;
drop policy if exists "OMR exam materials are publicly writable" on public.omr_exam_materials;
drop policy if exists "OMR assignments are publicly writable" on public.omr_assignments;
drop policy if exists "OMR assignment targets are publicly writable" on public.omr_assignment_targets;
drop policy if exists "OMR attempts are publicly readable" on public.omr_attempts;
drop policy if exists "OMR attempts are publicly writable" on public.omr_attempts;
drop policy if exists "OMR question results are publicly readable" on public.omr_question_results;
drop policy if exists "OMR question results are publicly writable" on public.omr_question_results;
drop policy if exists "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions;
drop policy if exists "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback;
drop policy if exists "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews;
drop policy if exists "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs;
drop policy if exists "OMR comments are publicly writable" on public.omr_comments;
drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;

-- Superseded authenticated-browser policies from production-rls.sql. These
-- explicit drops make the server-only cutover safe on databases that rehearsed
-- or applied the former Supabase Auth profile.
drop policy if exists "prod organizations read by members" on public.omr_organizations;
drop policy if exists "prod organizations managed by admins" on public.omr_organizations;
drop policy if exists "prod user profiles read by self or shared org" on public.omr_user_profiles;
drop policy if exists "prod user profiles insert self" on public.omr_user_profiles;
drop policy if exists "prod user profiles update self" on public.omr_user_profiles;
drop policy if exists "prod organization members read by members or self" on public.omr_organization_members;
drop policy if exists "prod organization members managed by admins" on public.omr_organization_members;
drop policy if exists "prod teacher profiles read by members" on public.omr_teacher_profiles;
drop policy if exists "prod teacher profiles write by admins or self" on public.omr_teacher_profiles;
drop policy if exists "prod student profiles read by staff or self" on public.omr_student_profiles;
drop policy if exists "prod student profiles write by staff" on public.omr_student_profiles;
drop policy if exists "prod classes read by staff or enrolled students" on public.omr_classes;
drop policy if exists "prod classes write by staff" on public.omr_classes;
drop policy if exists "prod class teachers read by members" on public.omr_class_teachers;
drop policy if exists "prod class teachers managed by admins" on public.omr_class_teachers;
drop policy if exists "prod class students read by staff or self" on public.omr_class_students;
drop policy if exists "prod class students write by staff" on public.omr_class_students;
drop policy if exists "prod materials read by members" on public.omr_materials;
drop policy if exists "prod materials write by staff" on public.omr_materials;
drop policy if exists "prod exams read by members or assigned students" on public.omr_exams;
drop policy if exists "prod exams read by staff" on public.omr_exams;
drop policy if exists "prod exams write by staff" on public.omr_exams;
drop policy if exists "prod exam questions read with exam" on public.omr_exam_questions;
drop policy if exists "prod exam questions read by staff" on public.omr_exam_questions;
drop policy if exists "prod exam questions write with exam" on public.omr_exam_questions;
drop policy if exists "prod exam materials read with exam" on public.omr_exam_materials;
drop policy if exists "prod exam materials write with exam" on public.omr_exam_materials;
drop policy if exists "prod assignments read by staff or assigned students" on public.omr_assignments;
drop policy if exists "prod assignments write by staff" on public.omr_assignments;
drop policy if exists "prod assignment targets read by staff or assigned students" on public.omr_assignment_targets;
drop policy if exists "prod assignment targets write by staff" on public.omr_assignment_targets;
drop policy if exists "prod attempts read by staff or self" on public.omr_attempts;
drop policy if exists "prod attempts write by staff or self" on public.omr_attempts;
drop policy if exists "prod attempts write by staff" on public.omr_attempts;
drop policy if exists "prod question results read by staff or self" on public.omr_question_results;
drop policy if exists "prod question results write by staff or self" on public.omr_question_results;
drop policy if exists "prod question results write by staff" on public.omr_question_results;
drop policy if exists "prod assignment submissions read by staff or self" on public.omr_assignment_submissions;
drop policy if exists "prod assignment submissions write by staff or self" on public.omr_assignment_submissions;
drop policy if exists "prod assignment submissions write by staff" on public.omr_assignment_submissions;
drop policy if exists "prod attempt feedback read by staff or returned student" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback insert by staff" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback update by staff or returned student" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback update by staff" on public.omr_attempt_feedback;
drop policy if exists "prod attempt feedback delete by staff" on public.omr_attempt_feedback;
drop policy if exists "prod kakao reviews read by staff" on public.omr_kakao_candidate_reviews;
drop policy if exists "prod kakao reviews write by staff" on public.omr_kakao_candidate_reviews;
drop policy if exists "prod kakao logs read by staff" on public.omr_kakao_dispatch_logs;
drop policy if exists "prod kakao logs write by staff" on public.omr_kakao_dispatch_logs;
drop policy if exists "prod comments read by staff or visible student" on public.omr_comments;
drop policy if exists "prod comments write by staff" on public.omr_comments;
drop policy if exists "prod audit logs read by admins" on public.omr_audit_logs;

-- Defense in depth: every canonical/PII registry remains RLS-enabled and
-- FORCE RLS even though browser roles have no direct relation privileges.
-- This is the complete set of 27 public.omr_* app tables created by schema.sql
-- plus migrations. storage.buckets is the 28th relation in the local verifier,
-- but it is a Supabase-managed storage-schema catalog, not a public app table;
-- its private bucket invariant is verified separately by live assertions.
alter table if exists public.omr_organizations enable row level security;
alter table if exists public.omr_organizations force row level security;
alter table if exists public.omr_plan_usage enable row level security;
alter table if exists public.omr_plan_usage force row level security;
alter table if exists public.omr_plan_usage_reservations enable row level security;
alter table if exists public.omr_plan_usage_reservations force row level security;
alter table if exists public.omr_user_profiles enable row level security;
alter table if exists public.omr_user_profiles force row level security;
alter table if exists public.omr_organization_members enable row level security;
alter table if exists public.omr_organization_members force row level security;
alter table if exists public.omr_teacher_profiles enable row level security;
alter table if exists public.omr_teacher_profiles force row level security;
alter table if exists public.omr_student_profiles enable row level security;
alter table if exists public.omr_student_profiles force row level security;
alter table if exists public.omr_student_start_credentials enable row level security;
alter table if exists public.omr_student_start_credentials force row level security;
alter table if exists public.omr_classes enable row level security;
alter table if exists public.omr_classes force row level security;
alter table if exists public.omr_roster_invites enable row level security;
alter table if exists public.omr_roster_invites force row level security;
alter table if exists public.omr_class_teachers enable row level security;
alter table if exists public.omr_class_teachers force row level security;
alter table if exists public.omr_class_students enable row level security;
alter table if exists public.omr_class_students force row level security;
alter table if exists public.omr_materials enable row level security;
alter table if exists public.omr_materials force row level security;
alter table if exists public.omr_exams enable row level security;
alter table if exists public.omr_exams force row level security;
alter table if exists public.omr_exam_questions enable row level security;
alter table if exists public.omr_exam_questions force row level security;
alter table if exists public.omr_exam_materials enable row level security;
alter table if exists public.omr_exam_materials force row level security;
alter table if exists public.omr_assignments enable row level security;
alter table if exists public.omr_assignments force row level security;
alter table if exists public.omr_assignment_targets enable row level security;
alter table if exists public.omr_assignment_targets force row level security;
alter table if exists public.omr_attempts enable row level security;
alter table if exists public.omr_attempts force row level security;
alter table if exists public.omr_question_results enable row level security;
alter table if exists public.omr_question_results force row level security;
alter table if exists public.omr_assignment_submissions enable row level security;
alter table if exists public.omr_assignment_submissions force row level security;
alter table if exists public.omr_attempt_feedback enable row level security;
alter table if exists public.omr_attempt_feedback force row level security;
alter table if exists public.omr_kakao_candidate_reviews enable row level security;
alter table if exists public.omr_kakao_candidate_reviews force row level security;
alter table if exists public.omr_kakao_dispatch_logs enable row level security;
alter table if exists public.omr_kakao_dispatch_logs force row level security;
alter table if exists public.omr_comments enable row level security;
alter table if exists public.omr_comments force row level security;
alter table if exists public.omr_audit_logs enable row level security;
alter table if exists public.omr_audit_logs force row level security;
alter table if exists public.omr_remote_assets enable row level security;
alter table if exists public.omr_remote_assets force row level security;

commit;
