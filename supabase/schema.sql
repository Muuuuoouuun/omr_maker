-- OMR Maker persistence tables.
-- Run this in Supabase SQL Editor before enabling the app's Supabase env vars.
--
-- This schema is intentionally compatible with the current alpha app:
-- - Existing client code can keep syncing exams/attempts through JSON payloads.
-- - New relational tables model users, rosters, materials, assignments, and feedback.
-- - Public RLS policies are kept for alpha/local testing only.
-- - Apply supabase/production-rls.sql after Supabase Auth, organization_id backfill,
--   and staff membership bootstrap are ready for production.

create table if not exists public.omr_organizations (
    id text primary key,
    name text not null,
    plan text not null default 'free'
        check (plan in ('free', 'pro', 'academy')),
    billing_email text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_user_profiles (
    user_id text primary key,
    email text,
    display_name text,
    avatar_url text,
    locale text not null default 'ko-KR',
    timezone text not null default 'Asia/Seoul',
    status text not null default 'active'
        check (status in ('invited', 'active', 'disabled', 'deleted')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_organization_members (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    user_id text not null,
    email text,
    display_name text,
    role text not null default 'teacher'
        check (role in ('owner', 'admin', 'teacher', 'assistant', 'viewer')),
    status text not null default 'active'
        check (status in ('invited', 'active', 'suspended', 'removed')),
    invited_by_user_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, user_id)
);

create table if not exists public.omr_teacher_profiles (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    user_id text not null,
    display_name text not null,
    subjects text[] not null default '{}'::text[],
    bio text,
    status text not null default 'active'
        check (status in ('active', 'inactive', 'removed')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (organization_id, user_id)
);

create table if not exists public.omr_student_profiles (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    user_id text,
    display_name text not null,
    external_id text,
    email text,
    phone text,
    guardian_name text,
    guardian_contact text,
    status text not null default 'active'
        check (status in ('invited', 'active', 'inactive', 'graduated', 'withdrawn')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create unique index if not exists omr_student_profiles_org_id_uidx
    on public.omr_student_profiles (organization_id, id);

create table if not exists public.omr_student_start_credentials (
    organization_id text not null,
    student_profile_id text not null,
    start_code_hash text not null,
    updated_at timestamptz not null default now(),
    primary key (organization_id, student_profile_id),
    foreign key (organization_id, student_profile_id)
        references public.omr_student_profiles(organization_id, id)
        on delete cascade
);

comment on table public.omr_student_start_credentials is
    'Server-only PBKDF2 student start-code hashes. Access is restricted to service-role server actions.';

alter table public.omr_student_start_credentials enable row level security;
alter table public.omr_student_start_credentials force row level security;
revoke all on public.omr_student_start_credentials from anon, authenticated;

create table if not exists public.omr_classes (
    id text primary key,
    organization_id text references public.omr_organizations(id) on delete cascade,
    name text not null,
    grade text,
    course text,
    campus text,
    academic_year text,
    term text,
    homeroom_teacher_user_id text,
    status text not null default 'active'
        check (status in ('active', 'archived')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_roster_invites (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    id text not null,
    email text not null,
    sent_at text not null,
    status text not null default 'pending'
        check (status in ('pending', 'accepted', 'expired')),
    updated_at timestamptz not null default now(),
    primary key (organization_id, id)
);

alter table public.omr_roster_invites enable row level security;
alter table public.omr_roster_invites force row level security;
revoke all on public.omr_roster_invites from anon, authenticated;

create table if not exists public.omr_class_teachers (
    class_id text not null references public.omr_classes(id) on delete cascade,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    teacher_user_id text not null,
    class_role text not null default 'lead'
        check (class_role in ('lead', 'co_teacher', 'grader', 'viewer')),
    created_at timestamptz not null default now(),
    primary key (class_id, teacher_user_id)
);

create table if not exists public.omr_class_students (
    class_id text not null references public.omr_classes(id) on delete cascade,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    student_profile_id text not null references public.omr_student_profiles(id) on delete cascade,
    seat_number text,
    enrollment_status text not null default 'active'
        check (enrollment_status in ('active', 'inactive', 'transferred', 'completed')),
    enrolled_at timestamptz not null default now(),
    left_at timestamptz,
    primary key (class_id, student_profile_id)
);

create table if not exists public.omr_materials (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    owner_user_id text,
    class_id text references public.omr_classes(id) on delete set null,
    title text not null,
    description text,
    material_type text not null
        check (material_type in ('problem_pdf', 'answer_key', 'solution', 'worksheet', 'image', 'video', 'link', 'note', 'other')),
    storage_bucket text,
    storage_path text,
    source_url text,
    mime_type text,
    size_bytes bigint check (size_bytes is null or size_bytes >= 0),
    checksum_sha256 text,
    tags text[] not null default '{}'::text[],
    visibility text not null default 'organization'
        check (visibility in ('private', 'class', 'organization', 'public')),
    metadata jsonb not null default '{}'::jsonb,
    archived boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_exams (
    id text primary key,
    organization_id text references public.omr_organizations(id) on delete set null,
    class_id text references public.omr_classes(id) on delete set null,
    title text not null,
    payload jsonb not null,
    created_by_user_id text,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    archived boolean not null default false
);

create table if not exists public.omr_exam_questions (
    id text primary key,
    organization_id text,
    class_id text,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    question_id integer not null,
    question_number integer not null,
    canonical_question_id text not null,
    label text,
    subject text,
    unit text,
    concept text,
    skill text,
    source text,
    difficulty text,
    cognitive_level text,
    mistake_types text[] not null default '{}'::text[],
    prerequisites text[] not null default '{}'::text[],
    expected_time_sec integer,
    choices integer not null default 5 check (choices in (4, 5)),
    correct_answer integer,
    score numeric not null default 0,
    pdf_page integer,
    pdf_location jsonb,
    pdf_region jsonb,
    has_pdf_region boolean not null default false,
    asset_status text not null default 'metadata_only'
        check (asset_status in ('metadata_only', 'pdf_region_ready', 'image_asset_ready')),
    image_asset_ref jsonb,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (exam_id, question_id)
);

create table if not exists public.omr_exam_materials (
    exam_id text not null references public.omr_exams(id) on delete cascade,
    material_id text not null references public.omr_materials(id) on delete cascade,
    material_role text not null default 'problem'
        check (material_role in ('problem', 'answer_key', 'solution', 'reference', 'attachment')),
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    primary key (exam_id, material_id, material_role)
);

create table if not exists public.omr_assignments (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    exam_id text references public.omr_exams(id) on delete set null,
    class_id text references public.omr_classes(id) on delete set null,
    title text not null,
    instructions text,
    access_mode text not null default 'class'
        check (access_mode in ('public', 'class', 'targeted', 'code')),
    status text not null default 'draft'
        check (status in ('draft', 'scheduled', 'open', 'closed', 'archived')),
    opens_at timestamptz,
    due_at timestamptz,
    closes_at timestamptz,
    max_attempts integer not null default 1 check (max_attempts > 0),
    time_limit_min integer check (time_limit_min is null or time_limit_min > 0),
    created_by_user_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_assignment_targets (
    id text primary key,
    assignment_id text not null references public.omr_assignments(id) on delete cascade,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    target_type text not null
        check (target_type in ('class', 'student', 'group')),
    target_id text not null,
    class_id text references public.omr_classes(id) on delete cascade,
    student_profile_id text references public.omr_student_profiles(id) on delete cascade,
    group_id text,
    access_pin_hash text,
    status text not null default 'active'
        check (status in ('active', 'paused', 'removed')),
    created_at timestamptz not null default now()
);

create table if not exists public.omr_attempts (
    id text primary key,
    ticket_id text,
    organization_id text,
    class_id text,
    assignment_id text,
    student_profile_id text,
    exam_id text not null,
    student_name text not null,
    student_id text,
    group_id text,
    group_name text,
    region_id text,
    region_name text,
    identity_type text
        check (identity_type in ('guest', 'temporary', 'registered')),
    status text not null default 'completed'
        check (status in ('completed', 'in_progress')),
    score numeric not null default 0,
    total_score numeric not null default 0,
    score_percent numeric not null default 0,
    retake_source_attempt_id text,
    retake_mode text
        check (retake_mode in ('wrong', 'similar', 'custom')),
    retake_question_ids integer[] not null default '{}'::integer[],
    merged_from_guest_id text,
    merged_at timestamptz,
    payload jsonb not null,
    started_at timestamptz not null,
    finished_at timestamptz not null
);

create table if not exists public.omr_question_results (
    id text primary key,
    organization_id text,
    class_id text,
    assignment_id text,
    student_profile_id text,
    attempt_id text not null references public.omr_attempts(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    student_name text not null,
    student_id text,
    group_id text,
    group_name text,
    region_id text,
    region_name text,
    identity_type text
        check (identity_type in ('guest', 'temporary', 'registered')),
    question_id integer not null,
    question_number integer not null,
    canonical_question_id text,
    label text,
    subject text,
    unit text,
    concept text,
    skill text,
    source text,
    difficulty text,
    cognitive_level text,
    mistake_types text[] not null default '{}'::text[],
    prerequisites text[] not null default '{}'::text[],
    expected_time_sec integer,
    selected_answer integer,
    correct_answer integer,
    status text not null
        check (status in ('correct', 'wrong', 'unanswered', 'ungraded')),
    is_correct boolean not null default false,
    is_wrong boolean not null default false,
    is_unanswered boolean not null default false,
    score numeric not null default 0,
    earned_score numeric not null default 0,
    pdf_page integer,
    pdf_location jsonb,
    pdf_region jsonb,
    time_sec integer,
    visit_count integer,
    revisit_count integer,
    answer_change_count integer,
    handwriting_stroke_count integer,
    handwriting_page integer,
    retake_source_attempt_id text,
    retake_mode text
        check (retake_mode in ('wrong', 'similar', 'custom')),
    answered_at timestamptz,
    finished_at timestamptz not null,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (attempt_id, question_id)
);

create table if not exists public.omr_assignment_submissions (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    assignment_id text not null references public.omr_assignments(id) on delete cascade,
    attempt_id text references public.omr_attempts(id) on delete set null,
    exam_id text references public.omr_exams(id) on delete set null,
    student_profile_id text references public.omr_student_profiles(id) on delete set null,
    student_user_id text,
    status text not null default 'assigned'
        check (status in ('assigned', 'in_progress', 'submitted', 'graded', 'returned', 'excused')),
    score numeric,
    total_score numeric,
    submitted_at timestamptz,
    graded_at timestamptz,
    feedback_summary text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_attempt_feedback (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    attempt_id text not null references public.omr_attempts(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    student_profile_id text references public.omr_student_profiles(id) on delete set null,
    teacher_user_id text,
    status text not null default 'draft'
        check (status in ('draft', 'returned', 'archived')),
    summary text,
    question_comments jsonb not null default '[]'::jsonb,
    markup jsonb,
    markup_drawings jsonb,
    download_policy jsonb not null default '{"allowStudentDownload":false,"allowAnnotatedPdfDownload":false,"watermarkStudentName":true}'::jsonb,
    notification_status text not null default 'not_queued'
        check (notification_status in ('not_queued', 'queued', 'sent', 'failed')),
    notification_channel text not null default 'in_app'
        check (notification_channel in ('in_app', 'kakao_candidate')),
    notified_at timestamptz,
    first_opened_at timestamptz,
    last_opened_at timestamptz,
    open_count integer not null default 0 check (open_count >= 0),
    returned_at timestamptz,
    payload jsonb not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (attempt_id)
);

create or replace function public.omr_mark_feedback_opened(
    target_feedback_id text,
    opened_at timestamptz default now()
)
returns public.omr_attempt_feedback
language plpgsql
security definer
set search_path = ''
as $$
declare
    feedback_row public.omr_attempt_feedback;
begin
    update public.omr_attempt_feedback
        set
            notification_status = 'sent',
            first_opened_at = coalesce(first_opened_at, opened_at),
            last_opened_at = opened_at,
            open_count = open_count + 1,
            updated_at = opened_at,
            payload = jsonb_set(
                jsonb_set(coalesce(payload, '{}'::jsonb), '{updatedAt}', to_jsonb(opened_at), true),
                '{delivery}',
                coalesce(payload->'delivery', '{}'::jsonb) || jsonb_build_object(
                    'notificationStatus', 'sent',
                    'firstOpenedAt', coalesce(first_opened_at, opened_at),
                    'lastOpenedAt', opened_at,
                    'openCount', open_count + 1
                ),
                true
            )
        where id = target_feedback_id
            and status = 'returned'
        returning * into feedback_row;

    return feedback_row;
end;
$$;

create table if not exists public.omr_kakao_candidate_reviews (
    id text primary key,
    organization_id text references public.omr_organizations(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    candidate_kind text not null
        check (candidate_kind in ('missing_exam', 'retake_recommendation', 'class_retake_recommendation')),
    channel text not null default 'kakao'
        check (channel in ('kakao')),
    status text not null
        check (status in ('ready', 'hold', 'excluded')),
    title text not null,
    target_count integer not null default 0 check (target_count >= 0),
    student_ids text[] not null default '{}'::text[],
    student_names text[] not null default '{}'::text[],
    group_names text[] not null default '{}'::text[],
    region_names text[] not null default '{}'::text[],
    message_preview text not null,
    reason text,
    href text,
    reviewed_by_user_id text,
    payload jsonb not null default '{}'::jsonb,
    reviewed_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_kakao_dispatch_logs (
    id text primary key,
    organization_id text references public.omr_organizations(id) on delete cascade,
    review_id text references public.omr_kakao_candidate_reviews(id) on delete set null,
    exam_id text references public.omr_exams(id) on delete set null,
    channel text not null default 'kakao'
        check (channel in ('kakao')),
    provider text,
    status text not null
        check (status in ('queued', 'sent', 'failed', 'cancelled', 'skipped')),
    target_count integer not null default 0 check (target_count >= 0),
    student_ids text[] not null default '{}'::text[],
    message_preview text not null,
    provider_message_id text,
    error_message text,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    sent_at timestamptz
);

create table if not exists public.omr_comments (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    entity_type text not null
        check (entity_type in ('student', 'class', 'material', 'exam', 'assignment', 'submission', 'attempt', 'question')),
    entity_id text not null,
    author_user_id text,
    student_profile_id text references public.omr_student_profiles(id) on delete set null,
    body text not null,
    visibility text not null default 'teacher_only'
        check (visibility in ('teacher_only', 'student_visible', 'organization')),
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    deleted_at timestamptz
);

create table if not exists public.omr_audit_logs (
    id text primary key,
    organization_id text,
    actor_user_id text,
    action text not null,
    entity_type text not null,
    entity_id text,
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

alter table public.omr_organizations
    add column if not exists billing_email text,
    add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.omr_organization_members
    add column if not exists invited_by_user_id text,
    add column if not exists updated_at timestamptz not null default now();

alter table public.omr_classes
    add column if not exists academic_year text,
    add column if not exists term text,
    add column if not exists homeroom_teacher_user_id text,
    add column if not exists status text not null default 'active',
    add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table public.omr_exams
    add column if not exists organization_id text,
    add column if not exists class_id text,
    add column if not exists created_by_user_id text;

alter table public.omr_attempts
    add column if not exists ticket_id text,
    add column if not exists organization_id text,
    add column if not exists class_id text,
    add column if not exists assignment_id text,
    add column if not exists student_profile_id text,
    add column if not exists region_id text,
    add column if not exists region_name text,
    add column if not exists identity_type text,
    add column if not exists status text not null default 'completed',
    add column if not exists score numeric not null default 0,
    add column if not exists total_score numeric not null default 0,
    add column if not exists score_percent numeric not null default 0,
    add column if not exists retake_source_attempt_id text,
    add column if not exists retake_mode text,
    add column if not exists retake_question_ids integer[] not null default '{}'::integer[],
    add column if not exists merged_from_guest_id text,
    add column if not exists merged_at timestamptz;

alter table public.omr_question_results
    add column if not exists organization_id text,
    add column if not exists class_id text,
    add column if not exists assignment_id text,
    add column if not exists student_profile_id text,
    add column if not exists region_id text,
    add column if not exists region_name text,
    add column if not exists identity_type text,
    add column if not exists expected_time_sec integer,
    add column if not exists retake_source_attempt_id text,
    add column if not exists retake_mode text,
    add column if not exists payload jsonb not null default '{}'::jsonb;

alter table public.omr_exam_questions
    add column if not exists asset_status text not null default 'metadata_only',
    add column if not exists image_asset_ref jsonb;

update public.omr_attempts
    set
        identity_type = case
            when payload->>'identityType' in ('guest', 'temporary', 'registered') then payload->>'identityType'
            else identity_type
        end,
        status = case
            when payload->>'status' in ('completed', 'in_progress') then payload->>'status'
            else status
        end,
        score = case
            when payload->>'score' ~ '^-?[0-9]+(\.[0-9]+)?$' then (payload->>'score')::numeric
            else score
        end,
        total_score = case
            when payload->>'totalScore' ~ '^-?[0-9]+(\.[0-9]+)?$' then (payload->>'totalScore')::numeric
            else total_score
        end,
        retake_source_attempt_id = coalesce(retake_source_attempt_id, payload #>> '{retake,sourceAttemptId}'),
        retake_mode = case
            when payload #>> '{retake,mode}' in ('wrong', 'similar', 'custom') then payload #>> '{retake,mode}'
            else retake_mode
        end,
        retake_question_ids = case
            when jsonb_typeof(payload #> '{retake,questionIds}') = 'array' then (
                select coalesce(array_agg(value::integer), '{}'::integer[])
                from jsonb_array_elements_text(payload #> '{retake,questionIds}') as items(value)
                where value ~ '^-?[0-9]+$'
            )
            else retake_question_ids
        end,
        region_id = coalesce(region_id, payload->>'regionId'),
        region_name = coalesce(region_name, payload->>'regionName'),
        merged_from_guest_id = coalesce(merged_from_guest_id, payload->>'mergedFromGuestId'),
        merged_at = case
            when merged_at is null and payload->>'mergedAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ]' then (payload->>'mergedAt')::timestamptz
            else merged_at
        end;

update public.omr_attempts
    set score_percent = round((score / total_score) * 100)
    where total_score > 0;

update public.omr_question_results
    set
        identity_type = case
            when payload->>'identityType' in ('guest', 'temporary', 'registered') then payload->>'identityType'
            else identity_type
        end,
        expected_time_sec = case
            when payload->>'expectedTimeSec' ~ '^-?[0-9]+$' then (payload->>'expectedTimeSec')::integer
            else expected_time_sec
        end,
        region_id = coalesce(region_id, payload->>'regionId'),
        region_name = coalesce(region_name, payload->>'regionName'),
        retake_source_attempt_id = coalesce(retake_source_attempt_id, payload->>'retakeSourceAttemptId'),
        retake_mode = case
            when payload->>'retakeMode' in ('wrong', 'similar', 'custom') then payload->>'retakeMode'
            else retake_mode
        end;

update public.omr_question_results qr
    set
        region_id = coalesce(qr.region_id, attempts.region_id),
        region_name = coalesce(qr.region_name, attempts.region_name)
    from public.omr_attempts attempts
    where qr.attempt_id = attempts.id
        and (qr.region_id is null or qr.region_name is null);

do $$
begin
    update public.omr_organizations
        set plan = 'academy'
        where plan = 'school';

    alter table public.omr_organizations
        drop constraint if exists omr_organizations_plan_check;

    alter table public.omr_organizations
        add constraint omr_organizations_plan_check
        check (plan in ('free', 'pro', 'academy')) not valid;

    if not exists (select 1 from pg_constraint where conname = 'omr_exam_questions_asset_status_check') then
        alter table public.omr_exam_questions
            add constraint omr_exam_questions_asset_status_check
            check (asset_status in ('metadata_only', 'pdf_region_ready', 'image_asset_ready')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_organization_members_role_check') then
        alter table public.omr_organization_members
            add constraint omr_organization_members_role_check
            check (role in ('owner', 'admin', 'teacher', 'assistant', 'viewer')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_organization_members_status_check') then
        alter table public.omr_organization_members
            add constraint omr_organization_members_status_check
            check (status in ('invited', 'active', 'suspended', 'removed')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_classes_status_check') then
        alter table public.omr_classes
            add constraint omr_classes_status_check
            check (status in ('active', 'archived')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_attempts_identity_type_check') then
        alter table public.omr_attempts
            add constraint omr_attempts_identity_type_check
            check (identity_type in ('guest', 'temporary', 'registered')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_attempts_status_check') then
        alter table public.omr_attempts
            add constraint omr_attempts_status_check
            check (status in ('completed', 'in_progress')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_attempts_retake_mode_check') then
        alter table public.omr_attempts
            add constraint omr_attempts_retake_mode_check
            check (retake_mode in ('wrong', 'similar', 'custom')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_question_results_identity_type_check') then
        alter table public.omr_question_results
            add constraint omr_question_results_identity_type_check
            check (identity_type in ('guest', 'temporary', 'registered')) not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_question_results_retake_mode_check') then
        alter table public.omr_question_results
            add constraint omr_question_results_retake_mode_check
            check (retake_mode in ('wrong', 'similar', 'custom')) not valid;
    end if;
end $$;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'omr_exams_organization_id_fkey') then
        alter table public.omr_exams
            add constraint omr_exams_organization_id_fkey
            foreign key (organization_id) references public.omr_organizations(id) on delete set null not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_exams_class_id_fkey') then
        alter table public.omr_exams
            add constraint omr_exams_class_id_fkey
            foreign key (class_id) references public.omr_classes(id) on delete set null not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_attempts_assignment_id_fkey') then
        alter table public.omr_attempts
            add constraint omr_attempts_assignment_id_fkey
            foreign key (assignment_id) references public.omr_assignments(id) on delete set null not valid;
    end if;

    if not exists (select 1 from pg_constraint where conname = 'omr_attempts_student_profile_id_fkey') then
        alter table public.omr_attempts
            add constraint omr_attempts_student_profile_id_fkey
            foreign key (student_profile_id) references public.omr_student_profiles(id) on delete set null not valid;
    end if;
end $$;

create unique index if not exists omr_user_profiles_email_uidx
    on public.omr_user_profiles (lower(email))
    where email is not null;

create index if not exists omr_organization_members_user_id_idx
    on public.omr_organization_members (user_id);

create index if not exists omr_teacher_profiles_user_id_idx
    on public.omr_teacher_profiles (user_id);

create unique index if not exists omr_student_profiles_org_external_id_uidx
    on public.omr_student_profiles (organization_id, external_id)
    where external_id is not null;

create index if not exists omr_student_profiles_org_name_idx
    on public.omr_student_profiles (organization_id, display_name);

create index if not exists omr_classes_organization_id_idx
    on public.omr_classes (organization_id);

create index if not exists omr_class_teachers_teacher_idx
    on public.omr_class_teachers (organization_id, teacher_user_id);

create index if not exists omr_class_students_student_idx
    on public.omr_class_students (organization_id, student_profile_id);

create index if not exists omr_materials_org_owner_idx
    on public.omr_materials (organization_id, owner_user_id, created_at desc);

create index if not exists omr_materials_class_idx
    on public.omr_materials (class_id, created_at desc);

create index if not exists omr_exams_updated_at_idx
    on public.omr_exams (updated_at desc);

create index if not exists omr_exams_organization_id_idx
    on public.omr_exams (organization_id);

create index if not exists omr_exams_class_id_idx
    on public.omr_exams (class_id);

create index if not exists omr_exam_materials_material_idx
    on public.omr_exam_materials (material_id);

create index if not exists omr_assignments_org_status_idx
    on public.omr_assignments (organization_id, status, due_at);

create index if not exists omr_assignment_targets_assignment_idx
    on public.omr_assignment_targets (assignment_id, target_type);

create index if not exists omr_attempts_exam_id_idx
    on public.omr_attempts (exam_id);

create unique index if not exists omr_attempts_ticket_id_unique_idx
    on public.omr_attempts (ticket_id)
    where ticket_id is not null;

create index if not exists omr_attempts_organization_id_idx
    on public.omr_attempts (organization_id);

create index if not exists omr_attempts_class_id_idx
    on public.omr_attempts (class_id);

create index if not exists omr_attempts_region_idx
    on public.omr_attempts (region_id, region_name, finished_at desc);

create index if not exists omr_attempts_exam_region_idx
    on public.omr_attempts (exam_id, region_id, region_name, finished_at desc);

create index if not exists omr_attempts_assignment_id_idx
    on public.omr_attempts (assignment_id);

create index if not exists omr_attempts_student_profile_idx
    on public.omr_attempts (student_profile_id, finished_at desc);

create index if not exists omr_attempts_finished_at_idx
    on public.omr_attempts (finished_at desc);

create index if not exists omr_attempts_exam_status_idx
    on public.omr_attempts (exam_id, status, finished_at desc);

create index if not exists omr_attempts_score_idx
    on public.omr_attempts (exam_id, score_percent);

create index if not exists omr_attempts_identity_idx
    on public.omr_attempts (identity_type, finished_at desc);

create index if not exists omr_attempts_retake_idx
    on public.omr_attempts (exam_id, retake_mode, retake_source_attempt_id);

create index if not exists omr_exam_questions_exam_idx
    on public.omr_exam_questions (exam_id, question_number);

create index if not exists omr_exam_questions_canonical_idx
    on public.omr_exam_questions (canonical_question_id);

create index if not exists omr_exam_questions_concept_idx
    on public.omr_exam_questions (exam_id, concept, difficulty);

create index if not exists omr_exam_questions_mistake_types_idx
    on public.omr_exam_questions using gin (mistake_types);

create index if not exists omr_exam_questions_pdf_region_idx
    on public.omr_exam_questions (exam_id, has_pdf_region);

create index if not exists omr_exam_questions_asset_status_idx
    on public.omr_exam_questions (exam_id, asset_status);

create index if not exists omr_question_results_attempt_idx
    on public.omr_question_results (attempt_id, question_number);

create index if not exists omr_question_results_exam_question_idx
    on public.omr_question_results (exam_id, question_id);

create index if not exists omr_question_results_canonical_idx
    on public.omr_question_results (canonical_question_id);

create index if not exists omr_question_results_exam_status_idx
    on public.omr_question_results (exam_id, status);

create index if not exists omr_question_results_student_idx
    on public.omr_question_results (student_id, finished_at desc);

create index if not exists omr_question_results_group_idx
    on public.omr_question_results (group_id, finished_at desc);

create index if not exists omr_question_results_region_idx
    on public.omr_question_results (region_id, region_name, finished_at desc);

create index if not exists omr_question_results_exam_region_status_idx
    on public.omr_question_results (exam_id, region_id, region_name, status);

create index if not exists omr_question_results_concept_idx
    on public.omr_question_results (exam_id, concept, status);

create index if not exists omr_question_results_option_idx
    on public.omr_question_results (exam_id, question_id, selected_answer);

create index if not exists omr_question_results_mistake_types_idx
    on public.omr_question_results using gin (mistake_types);

create index if not exists omr_question_results_retake_idx
    on public.omr_question_results (exam_id, retake_mode, retake_source_attempt_id);

create index if not exists omr_assignment_submissions_assignment_idx
    on public.omr_assignment_submissions (assignment_id, status);

create index if not exists omr_assignment_submissions_student_idx
    on public.omr_assignment_submissions (student_profile_id, submitted_at desc);

create index if not exists omr_attempt_feedback_attempt_idx
    on public.omr_attempt_feedback (attempt_id);

create index if not exists omr_attempt_feedback_student_unread_idx
    on public.omr_attempt_feedback (student_profile_id, status, first_opened_at, updated_at desc);

create index if not exists omr_attempt_feedback_org_status_idx
    on public.omr_attempt_feedback (organization_id, status, updated_at desc);

create index if not exists omr_kakao_candidate_reviews_exam_status_idx
    on public.omr_kakao_candidate_reviews (exam_id, status, updated_at desc);

create index if not exists omr_kakao_candidate_reviews_org_status_idx
    on public.omr_kakao_candidate_reviews (organization_id, status, updated_at desc);

create index if not exists omr_kakao_candidate_reviews_kind_idx
    on public.omr_kakao_candidate_reviews (candidate_kind, updated_at desc);

create index if not exists omr_kakao_candidate_reviews_student_ids_idx
    on public.omr_kakao_candidate_reviews using gin (student_ids);

create index if not exists omr_kakao_dispatch_logs_review_idx
    on public.omr_kakao_dispatch_logs (review_id, created_at desc);

create index if not exists omr_kakao_dispatch_logs_exam_idx
    on public.omr_kakao_dispatch_logs (exam_id, created_at desc);

create index if not exists omr_kakao_dispatch_logs_status_idx
    on public.omr_kakao_dispatch_logs (status, created_at desc);

create index if not exists omr_comments_entity_idx
    on public.omr_comments (entity_type, entity_id, created_at desc);

create index if not exists omr_audit_logs_organization_id_idx
    on public.omr_audit_logs (organization_id, created_at desc);

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
alter table public.omr_attempt_feedback enable row level security;
alter table public.omr_kakao_candidate_reviews enable row level security;
alter table public.omr_kakao_dispatch_logs enable row level security;
alter table public.omr_comments enable row level security;
alter table public.omr_audit_logs enable row level security;

-- Development/open-classroom policies. The current app has no real auth yet,
-- so publishable-key clients need public read/write access to sync data.
-- Tighten these policies before using this with sensitive student data.
drop policy if exists "OMR organizations are publicly writable" on public.omr_organizations;
create policy "OMR organizations are publicly writable"
    on public.omr_organizations
    for all
    using (true)
    with check (true);

drop policy if exists "OMR user profiles are publicly writable" on public.omr_user_profiles;
create policy "OMR user profiles are publicly writable"
    on public.omr_user_profiles
    for all
    using (true)
    with check (true);

drop policy if exists "OMR organization members are publicly writable" on public.omr_organization_members;
create policy "OMR organization members are publicly writable"
    on public.omr_organization_members
    for all
    using (true)
    with check (true);

drop policy if exists "OMR teacher profiles are publicly writable" on public.omr_teacher_profiles;
create policy "OMR teacher profiles are publicly writable"
    on public.omr_teacher_profiles
    for all
    using (true)
    with check (true);

drop policy if exists "OMR student profiles are publicly writable" on public.omr_student_profiles;
create policy "OMR student profiles are publicly writable"
    on public.omr_student_profiles
    for all
    using (true)
    with check (true);

drop policy if exists "OMR classes are publicly writable" on public.omr_classes;
create policy "OMR classes are publicly writable"
    on public.omr_classes
    for all
    using (true)
    with check (true);

drop policy if exists "OMR class teachers are publicly writable" on public.omr_class_teachers;
create policy "OMR class teachers are publicly writable"
    on public.omr_class_teachers
    for all
    using (true)
    with check (true);

drop policy if exists "OMR class students are publicly writable" on public.omr_class_students;
create policy "OMR class students are publicly writable"
    on public.omr_class_students
    for all
    using (true)
    with check (true);

drop policy if exists "OMR materials are publicly writable" on public.omr_materials;
create policy "OMR materials are publicly writable"
    on public.omr_materials
    for all
    using (true)
    with check (true);

drop policy if exists "OMR exams are publicly readable" on public.omr_exams;
create policy "OMR exams are publicly readable"
    on public.omr_exams
    for select
    using (true);

drop policy if exists "OMR exams are publicly writable" on public.omr_exams;
create policy "OMR exams are publicly writable"
    on public.omr_exams
    for all
    using (true)
    with check (true);

drop policy if exists "OMR exam questions are publicly writable" on public.omr_exam_questions;
create policy "OMR exam questions are publicly writable"
    on public.omr_exam_questions
    for all
    using (true)
    with check (true);

drop policy if exists "OMR exam materials are publicly writable" on public.omr_exam_materials;
create policy "OMR exam materials are publicly writable"
    on public.omr_exam_materials
    for all
    using (true)
    with check (true);

drop policy if exists "OMR assignments are publicly writable" on public.omr_assignments;
create policy "OMR assignments are publicly writable"
    on public.omr_assignments
    for all
    using (true)
    with check (true);

drop policy if exists "OMR assignment targets are publicly writable" on public.omr_assignment_targets;
create policy "OMR assignment targets are publicly writable"
    on public.omr_assignment_targets
    for all
    using (true)
    with check (true);

drop policy if exists "OMR attempts are publicly readable" on public.omr_attempts;
create policy "OMR attempts are publicly readable"
    on public.omr_attempts
    for select
    using (true);

drop policy if exists "OMR attempts are publicly writable" on public.omr_attempts;
create policy "OMR attempts are publicly writable"
    on public.omr_attempts
    for all
    using (true)
    with check (true);

drop policy if exists "OMR question results are publicly readable" on public.omr_question_results;
create policy "OMR question results are publicly readable"
    on public.omr_question_results
    for select
    using (true);

drop policy if exists "OMR question results are publicly writable" on public.omr_question_results;
create policy "OMR question results are publicly writable"
    on public.omr_question_results
    for all
    using (true)
    with check (true);

drop policy if exists "OMR assignment submissions are publicly writable" on public.omr_assignment_submissions;
create policy "OMR assignment submissions are publicly writable"
    on public.omr_assignment_submissions
    for all
    using (true)
    with check (true);

drop policy if exists "OMR attempt feedback is publicly writable" on public.omr_attempt_feedback;
create policy "OMR attempt feedback is publicly writable"
    on public.omr_attempt_feedback
    for all
    using (true)
    with check (true);

drop policy if exists "OMR Kakao candidate reviews are publicly writable" on public.omr_kakao_candidate_reviews;
create policy "OMR Kakao candidate reviews are publicly writable"
    on public.omr_kakao_candidate_reviews
    for all
    using (true)
    with check (true);

drop policy if exists "OMR Kakao dispatch logs are publicly writable" on public.omr_kakao_dispatch_logs;
create policy "OMR Kakao dispatch logs are publicly writable"
    on public.omr_kakao_dispatch_logs
    for all
    using (true)
    with check (true);

drop policy if exists "OMR comments are publicly writable" on public.omr_comments;
create policy "OMR comments are publicly writable"
    on public.omr_comments
    for all
    using (true)
    with check (true);

drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;
create policy "OMR audit logs are publicly writable"
    on public.omr_audit_logs
    for all
    using (true)
    with check (true);
