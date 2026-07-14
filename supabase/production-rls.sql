-- OMR Maker production RLS policies.
--
-- Apply this only after:
-- 1. Supabase Auth is enabled for staff accounts.
-- 2. Every production row has a non-null organization_id where the table supports it.
-- 3. omr_organization_members contains the active staff membership rows.
-- 4. Organization and first-owner bootstrap runs from a trusted server/service-role path.
--
-- This file intentionally removes the alpha public read/write policies from schema.sql.
-- Anonymous student quick-entry must stay app/server-mediated until student Auth accounts
-- or signed assignment tokens are implemented.

begin;

-- Paid-plan usage is server-owned. No browser role receives table access or
-- function execution; trusted server actions use the service-role key.
alter table public.omr_plan_usage enable row level security;
alter table public.omr_plan_usage_reservations enable row level security;
revoke all on table public.omr_plan_usage from anon, authenticated;
revoke all on table public.omr_plan_usage_reservations from anon, authenticated;
revoke all on function public.omr_reserve_plan_usage(text, text, date, text, integer, integer, integer) from public, anon, authenticated;
revoke all on function public.omr_sync_student_plan_usage(text, text[], integer, integer) from public, anon, authenticated;
revoke all on function public.omr_release_plan_usage(text, text, date, text) from public, anon, authenticated;
grant execute on function public.omr_reserve_plan_usage(text, text, date, text, integer, integer, integer) to service_role;
grant execute on function public.omr_sync_student_plan_usage(text, text[], integer, integer) to service_role;
grant execute on function public.omr_release_plan_usage(text, text, date, text) to service_role;

create or replace function public.omr_current_user_id()
returns text
language sql
stable
security definer
set search_path = ''
as $$
    select (auth.uid())::text
$$;

create or replace function public.omr_is_org_member(target_organization_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_organization_id is not null
        and exists (
            select 1
            from public.omr_organization_members member
            where member.organization_id = target_organization_id
                and member.user_id = (select public.omr_current_user_id())
                and member.status = 'active'
        )
$$;

create or replace function public.omr_has_org_role(target_organization_id text, allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_organization_id is not null
        and coalesce(array_length(allowed_roles, 1), 0) > 0
        and exists (
            select 1
            from public.omr_organization_members member
            where member.organization_id = target_organization_id
                and member.user_id = (select public.omr_current_user_id())
                and member.status = 'active'
                and member.role = any(allowed_roles)
        )
$$;

create or replace function public.omr_shares_org_with_user(target_user_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_user_id is not null
        and exists (
            select 1
            from public.omr_organization_members mine
            join public.omr_organization_members target
                on target.organization_id = mine.organization_id
            where mine.user_id = (select public.omr_current_user_id())
                and mine.status = 'active'
                and target.user_id = target_user_id
                and target.status = 'active'
        )
$$;

create or replace function public.omr_is_student_profile_owner(target_student_profile_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_student_profile_id is not null
        and exists (
            select 1
            from public.omr_student_profiles student
            where student.id = target_student_profile_id
                and student.user_id = (select public.omr_current_user_id())
                and student.status in ('invited', 'active')
        )
$$;

create or replace function public.omr_is_org_student(target_organization_id text, target_student_profile_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_organization_id is not null
        and target_student_profile_id is not null
        and exists (
            select 1
            from public.omr_student_profiles student
            where student.organization_id = target_organization_id
                and student.id = target_student_profile_id
                and student.user_id = (select public.omr_current_user_id())
                and student.status in ('invited', 'active')
        )
$$;

create or replace function public.omr_is_current_student_in_class(target_class_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_class_id is not null
        and exists (
            select 1
            from public.omr_class_students enrollment
            join public.omr_student_profiles student
                on student.id = enrollment.student_profile_id
            where enrollment.class_id = target_class_id
                and enrollment.enrollment_status = 'active'
                and student.user_id = (select public.omr_current_user_id())
                and student.status in ('invited', 'active')
        )
$$;

create or replace function public.omr_can_read_assignment(target_organization_id text, target_assignment_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_organization_id is not null
        and target_assignment_id is not null
        and (
            public.omr_is_org_member(target_organization_id)
            or exists (
                select 1
                from public.omr_student_profiles student
                join public.omr_assignments assignment
                    on assignment.id = target_assignment_id
                    and assignment.organization_id = target_organization_id
                left join public.omr_assignment_targets target
                    on target.assignment_id = assignment.id
                    and target.status = 'active'
                where student.organization_id = target_organization_id
                    and student.user_id = (select public.omr_current_user_id())
                    and student.status in ('invited', 'active')
                    and assignment.status in ('scheduled', 'open', 'closed')
                    and (
                        assignment.access_mode = 'public'
                        or target.student_profile_id = student.id
                        or (
                            target.class_id is not null
                            and exists (
                                select 1
                                from public.omr_class_students enrollment
                                where enrollment.class_id = target.class_id
                                    and enrollment.student_profile_id = student.id
                                    and enrollment.enrollment_status = 'active'
                            )
                        )
                    )
            )
        )
$$;

create or replace function public.omr_can_read_exam(target_organization_id text, target_exam_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select target_organization_id is not null
        and target_exam_id is not null
        and (
            public.omr_is_org_member(target_organization_id)
            or exists (
                select 1
                from public.omr_assignments assignment
                where assignment.organization_id = target_organization_id
                    and assignment.exam_id = target_exam_id
                    and public.omr_can_read_assignment(assignment.organization_id, assignment.id)
            )
        )
$$;

create or replace function public.omr_can_read_exam_by_id(target_exam_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.omr_exams exam
        where exam.id = target_exam_id
            and public.omr_can_read_exam(exam.organization_id, exam.id)
    )
$$;

create or replace function public.omr_can_write_exam_by_id(target_exam_id text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.omr_exams exam
        where exam.id = target_exam_id
            and public.omr_has_org_role(exam.organization_id, array['owner', 'admin', 'teacher', 'assistant'])
    )
$$;

revoke all on function public.omr_current_user_id() from public;
revoke all on function public.omr_is_org_member(text) from public;
revoke all on function public.omr_has_org_role(text, text[]) from public;
revoke all on function public.omr_shares_org_with_user(text) from public;
revoke all on function public.omr_is_student_profile_owner(text) from public;
revoke all on function public.omr_is_org_student(text, text) from public;
revoke all on function public.omr_is_current_student_in_class(text) from public;
revoke all on function public.omr_can_read_assignment(text, text) from public;
revoke all on function public.omr_can_read_exam(text, text) from public;
revoke all on function public.omr_can_read_exam_by_id(text) from public;
revoke all on function public.omr_can_write_exam_by_id(text) from public;

grant execute on function public.omr_current_user_id() to authenticated;
grant execute on function public.omr_is_org_member(text) to authenticated;
grant execute on function public.omr_has_org_role(text, text[]) to authenticated;
grant execute on function public.omr_shares_org_with_user(text) to authenticated;
grant execute on function public.omr_is_student_profile_owner(text) to authenticated;
grant execute on function public.omr_is_org_student(text, text) to authenticated;
grant execute on function public.omr_is_current_student_in_class(text) to authenticated;
grant execute on function public.omr_can_read_assignment(text, text) to authenticated;
grant execute on function public.omr_can_read_exam(text, text) to authenticated;
grant execute on function public.omr_can_read_exam_by_id(text) to authenticated;
grant execute on function public.omr_can_write_exam_by_id(text) to authenticated;

revoke all on schema public from anon;
revoke all on all tables in schema public from anon;
revoke all on all tables in schema public from authenticated;

grant usage on schema public to authenticated;

grant select, insert, update, delete on
    public.omr_organizations,
    public.omr_user_profiles,
    public.omr_organization_members,
    public.omr_teacher_profiles,
    public.omr_student_profiles,
    public.omr_classes,
    public.omr_class_teachers,
    public.omr_class_students,
    public.omr_materials,
    public.omr_exams,
    public.omr_exam_questions,
    public.omr_exam_materials,
    public.omr_assignments,
    public.omr_assignment_targets,
    public.omr_attempts,
    public.omr_question_results,
    public.omr_assignment_submissions,
    public.omr_kakao_candidate_reviews,
    public.omr_kakao_dispatch_logs,
    public.omr_comments
to authenticated;

grant select on public.omr_audit_logs to authenticated;

alter table public.omr_organizations enable row level security;
alter table public.omr_user_profiles enable row level security;
alter table public.omr_organization_members enable row level security;
alter table public.omr_teacher_profiles enable row level security;
alter table public.omr_student_profiles enable row level security;
alter table public.omr_classes enable row level security;
alter table public.omr_class_teachers enable row level security;
alter table public.omr_class_students enable row level security;
alter table public.omr_materials enable row level security;
alter table public.omr_exams enable row level security;
alter table public.omr_exam_questions enable row level security;
alter table public.omr_exam_materials enable row level security;
alter table public.omr_assignments enable row level security;
alter table public.omr_assignment_targets enable row level security;
alter table public.omr_attempts enable row level security;
alter table public.omr_question_results enable row level security;
alter table public.omr_assignment_submissions enable row level security;
alter table public.omr_kakao_candidate_reviews enable row level security;
alter table public.omr_kakao_dispatch_logs enable row level security;
alter table public.omr_comments enable row level security;
alter table public.omr_audit_logs enable row level security;

alter table public.omr_organizations force row level security;
alter table public.omr_plan_usage force row level security;
alter table public.omr_plan_usage_reservations force row level security;
alter table public.omr_user_profiles force row level security;
alter table public.omr_organization_members force row level security;
alter table public.omr_teacher_profiles force row level security;
alter table public.omr_student_profiles force row level security;
alter table public.omr_classes force row level security;
alter table public.omr_class_teachers force row level security;
alter table public.omr_class_students force row level security;
alter table public.omr_materials force row level security;
alter table public.omr_exams force row level security;
alter table public.omr_exam_questions force row level security;
alter table public.omr_exam_materials force row level security;
alter table public.omr_assignments force row level security;
alter table public.omr_assignment_targets force row level security;
alter table public.omr_attempts force row level security;
alter table public.omr_question_results force row level security;
alter table public.omr_assignment_submissions force row level security;
alter table public.omr_kakao_candidate_reviews force row level security;
alter table public.omr_kakao_dispatch_logs force row level security;
alter table public.omr_comments force row level security;
alter table public.omr_audit_logs force row level security;

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
drop policy if exists "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews;
drop policy if exists "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs;
drop policy if exists "OMR comments are publicly writable" on public.omr_comments;
drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;

drop policy if exists "prod organizations read by members" on public.omr_organizations;
create policy "prod organizations read by members"
    on public.omr_organizations
    for select
    to authenticated
    using ((select public.omr_is_org_member(id)));

drop policy if exists "prod organizations managed by admins" on public.omr_organizations;
create policy "prod organizations managed by admins"
    on public.omr_organizations
    for update
    to authenticated
    using ((select public.omr_has_org_role(id, array['owner', 'admin'])))
    with check ((select public.omr_has_org_role(id, array['owner', 'admin'])));

drop policy if exists "prod user profiles read by self or shared org" on public.omr_user_profiles;
create policy "prod user profiles read by self or shared org"
    on public.omr_user_profiles
    for select
    to authenticated
    using (user_id = (select public.omr_current_user_id()) or (select public.omr_shares_org_with_user(user_id)));

drop policy if exists "prod user profiles insert self" on public.omr_user_profiles;
create policy "prod user profiles insert self"
    on public.omr_user_profiles
    for insert
    to authenticated
    with check (user_id = (select public.omr_current_user_id()));

drop policy if exists "prod user profiles update self" on public.omr_user_profiles;
create policy "prod user profiles update self"
    on public.omr_user_profiles
    for update
    to authenticated
    using (user_id = (select public.omr_current_user_id()))
    with check (user_id = (select public.omr_current_user_id()));

drop policy if exists "prod organization members read by members or self" on public.omr_organization_members;
create policy "prod organization members read by members or self"
    on public.omr_organization_members
    for select
    to authenticated
    using (user_id = (select public.omr_current_user_id()) or (select public.omr_is_org_member(organization_id)));

drop policy if exists "prod organization members managed by admins" on public.omr_organization_members;
create policy "prod organization members managed by admins"
    on public.omr_organization_members
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin'])));

drop policy if exists "prod teacher profiles read by members" on public.omr_teacher_profiles;
create policy "prod teacher profiles read by members"
    on public.omr_teacher_profiles
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)) or user_id = (select public.omr_current_user_id()));

drop policy if exists "prod teacher profiles write by admins or self" on public.omr_teacher_profiles;
create policy "prod teacher profiles write by admins or self"
    on public.omr_teacher_profiles
    for all
    to authenticated
    using (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin']))
        or (user_id = (select public.omr_current_user_id()) and (select public.omr_is_org_member(organization_id)))
    )
    with check (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin']))
        or (user_id = (select public.omr_current_user_id()) and (select public.omr_is_org_member(organization_id)))
    );

drop policy if exists "prod student profiles read by staff or self" on public.omr_student_profiles;
create policy "prod student profiles read by staff or self"
    on public.omr_student_profiles
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)) or user_id = (select public.omr_current_user_id()));

drop policy if exists "prod student profiles write by staff" on public.omr_student_profiles;
create policy "prod student profiles write by staff"
    on public.omr_student_profiles
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod classes read by staff or enrolled students" on public.omr_classes;
create policy "prod classes read by staff or enrolled students"
    on public.omr_classes
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)) or (select public.omr_is_current_student_in_class(id)));

drop policy if exists "prod classes write by staff" on public.omr_classes;
create policy "prod classes write by staff"
    on public.omr_classes
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod class teachers read by members" on public.omr_class_teachers;
create policy "prod class teachers read by members"
    on public.omr_class_teachers
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)));

drop policy if exists "prod class teachers managed by admins" on public.omr_class_teachers;
create policy "prod class teachers managed by admins"
    on public.omr_class_teachers
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin'])));

drop policy if exists "prod class students read by staff or self" on public.omr_class_students;
create policy "prod class students read by staff or self"
    on public.omr_class_students
    for select
    to authenticated
    using (
        (select public.omr_is_org_member(organization_id))
        or (select public.omr_is_student_profile_owner(student_profile_id))
    );

drop policy if exists "prod class students write by staff" on public.omr_class_students;
create policy "prod class students write by staff"
    on public.omr_class_students
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod materials read by members" on public.omr_materials;
create policy "prod materials read by members"
    on public.omr_materials
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)));

drop policy if exists "prod materials write by staff" on public.omr_materials;
create policy "prod materials write by staff"
    on public.omr_materials
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod exams read by members or assigned students" on public.omr_exams;
create policy "prod exams read by members or assigned students"
    on public.omr_exams
    for select
    to authenticated
    using ((select public.omr_can_read_exam(organization_id, id)));

drop policy if exists "prod exams write by staff" on public.omr_exams;
create policy "prod exams write by staff"
    on public.omr_exams
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod exam questions read with exam" on public.omr_exam_questions;
create policy "prod exam questions read with exam"
    on public.omr_exam_questions
    for select
    to authenticated
    using (
        (organization_id is not null and (select public.omr_can_read_exam(organization_id, exam_id)))
        or (organization_id is null and (select public.omr_can_read_exam_by_id(exam_id)))
    );

drop policy if exists "prod exam questions write with exam" on public.omr_exam_questions;
create policy "prod exam questions write with exam"
    on public.omr_exam_questions
    for all
    to authenticated
    using (
        (organization_id is not null and (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
        or (organization_id is null and (select public.omr_can_write_exam_by_id(exam_id)))
    )
    with check (
        (organization_id is not null and (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
        or (organization_id is null and (select public.omr_can_write_exam_by_id(exam_id)))
    );

drop policy if exists "prod exam materials read with exam" on public.omr_exam_materials;
create policy "prod exam materials read with exam"
    on public.omr_exam_materials
    for select
    to authenticated
    using ((select public.omr_can_read_exam_by_id(exam_id)));

drop policy if exists "prod exam materials write with exam" on public.omr_exam_materials;
create policy "prod exam materials write with exam"
    on public.omr_exam_materials
    for all
    to authenticated
    using ((select public.omr_can_write_exam_by_id(exam_id)))
    with check ((select public.omr_can_write_exam_by_id(exam_id)));

drop policy if exists "prod assignments read by staff or assigned students" on public.omr_assignments;
create policy "prod assignments read by staff or assigned students"
    on public.omr_assignments
    for select
    to authenticated
    using ((select public.omr_can_read_assignment(organization_id, id)));

drop policy if exists "prod assignments write by staff" on public.omr_assignments;
create policy "prod assignments write by staff"
    on public.omr_assignments
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod assignment targets read by staff or assigned students" on public.omr_assignment_targets;
create policy "prod assignment targets read by staff or assigned students"
    on public.omr_assignment_targets
    for select
    to authenticated
    using (
        (select public.omr_is_org_member(organization_id))
        or (student_profile_id is not null and (select public.omr_is_org_student(organization_id, student_profile_id)))
        or (class_id is not null and (select public.omr_is_current_student_in_class(class_id)))
    );

drop policy if exists "prod assignment targets write by staff" on public.omr_assignment_targets;
create policy "prod assignment targets write by staff"
    on public.omr_assignment_targets
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod attempts read by staff or self" on public.omr_attempts;
create policy "prod attempts read by staff or self"
    on public.omr_attempts
    for select
    to authenticated
    using (
        (select public.omr_is_org_member(organization_id))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    );

drop policy if exists "prod attempts write by staff or self" on public.omr_attempts;
create policy "prod attempts write by staff or self"
    on public.omr_attempts
    for all
    to authenticated
    using (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant']))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    )
    with check (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant']))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    );

drop policy if exists "prod question results read by staff or self" on public.omr_question_results;
create policy "prod question results read by staff or self"
    on public.omr_question_results
    for select
    to authenticated
    using (
        (select public.omr_is_org_member(organization_id))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    );

drop policy if exists "prod question results write by staff or self" on public.omr_question_results;
create policy "prod question results write by staff or self"
    on public.omr_question_results
    for all
    to authenticated
    using (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant']))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    )
    with check (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant']))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    );

drop policy if exists "prod assignment submissions read by staff or self" on public.omr_assignment_submissions;
create policy "prod assignment submissions read by staff or self"
    on public.omr_assignment_submissions
    for select
    to authenticated
    using (
        (select public.omr_is_org_member(organization_id))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    );

drop policy if exists "prod assignment submissions write by staff or self" on public.omr_assignment_submissions;
create policy "prod assignment submissions write by staff or self"
    on public.omr_assignment_submissions
    for all
    to authenticated
    using (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant']))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    )
    with check (
        (select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant']))
        or (select public.omr_is_org_student(organization_id, student_profile_id))
    );

drop policy if exists "prod kakao reviews read by staff" on public.omr_kakao_candidate_reviews;
create policy "prod kakao reviews read by staff"
    on public.omr_kakao_candidate_reviews
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)));

drop policy if exists "prod kakao reviews write by staff" on public.omr_kakao_candidate_reviews;
create policy "prod kakao reviews write by staff"
    on public.omr_kakao_candidate_reviews
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod kakao logs read by staff" on public.omr_kakao_dispatch_logs;
create policy "prod kakao logs read by staff"
    on public.omr_kakao_dispatch_logs
    for select
    to authenticated
    using ((select public.omr_is_org_member(organization_id)));

drop policy if exists "prod kakao logs write by staff" on public.omr_kakao_dispatch_logs;
create policy "prod kakao logs write by staff"
    on public.omr_kakao_dispatch_logs
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod comments read by staff or visible student" on public.omr_comments;
create policy "prod comments read by staff or visible student"
    on public.omr_comments
    for select
    to authenticated
    using (
        (select public.omr_is_org_member(organization_id))
        or (
            visibility = 'student_visible'
            and student_profile_id is not null
            and (select public.omr_is_org_student(organization_id, student_profile_id))
        )
    );

drop policy if exists "prod comments write by staff" on public.omr_comments;
create policy "prod comments write by staff"
    on public.omr_comments
    for all
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])))
    with check ((select public.omr_has_org_role(organization_id, array['owner', 'admin', 'teacher', 'assistant'])));

drop policy if exists "prod audit logs read by admins" on public.omr_audit_logs;
create policy "prod audit logs read by admins"
    on public.omr_audit_logs
    for select
    to authenticated
    using ((select public.omr_has_org_role(organization_id, array['owner', 'admin'])));

commit;
