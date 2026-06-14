-- OMR Maker persistence tables.
-- Run this in Supabase SQL Editor before enabling the app's Supabase env vars.

create table if not exists public.omr_organizations (
    id text primary key,
    name text not null,
    plan text not null default 'free',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_organization_members (
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    user_id text not null,
    email text,
    display_name text,
    role text not null default 'teacher',
    status text not null default 'active',
    created_at timestamptz not null default now(),
    primary key (organization_id, user_id)
);

create table if not exists public.omr_classes (
    id text primary key,
    organization_id text references public.omr_organizations(id) on delete cascade,
    name text not null,
    grade text,
    course text,
    campus text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create table if not exists public.omr_exams (
    id text primary key,
    organization_id text,
    class_id text,
    title text not null,
    payload jsonb not null,
    created_at timestamptz not null,
    updated_at timestamptz not null,
    archived boolean not null default false
);

create index if not exists omr_exams_updated_at_idx
    on public.omr_exams (updated_at desc);

create table if not exists public.omr_attempts (
    id text primary key,
    organization_id text,
    class_id text,
    exam_id text not null,
    student_name text not null,
    student_id text,
    group_id text,
    group_name text,
    payload jsonb not null,
    started_at timestamptz not null,
    finished_at timestamptz not null
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

alter table public.omr_exams
    add column if not exists organization_id text,
    add column if not exists class_id text;

alter table public.omr_attempts
    add column if not exists organization_id text,
    add column if not exists class_id text;

create index if not exists omr_organization_members_user_id_idx
    on public.omr_organization_members (user_id);

create index if not exists omr_classes_organization_id_idx
    on public.omr_classes (organization_id);

create index if not exists omr_exams_organization_id_idx
    on public.omr_exams (organization_id);

create index if not exists omr_exams_class_id_idx
    on public.omr_exams (class_id);

create index if not exists omr_attempts_exam_id_idx
    on public.omr_attempts (exam_id);

create index if not exists omr_attempts_organization_id_idx
    on public.omr_attempts (organization_id);

create index if not exists omr_attempts_class_id_idx
    on public.omr_attempts (class_id);

create index if not exists omr_attempts_finished_at_idx
    on public.omr_attempts (finished_at desc);

create index if not exists omr_audit_logs_organization_id_idx
    on public.omr_audit_logs (organization_id, created_at desc);

alter table public.omr_organizations enable row level security;
alter table public.omr_organization_members enable row level security;
alter table public.omr_classes enable row level security;
alter table public.omr_exams enable row level security;
alter table public.omr_attempts enable row level security;
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

drop policy if exists "OMR organization members are publicly writable" on public.omr_organization_members;
create policy "OMR organization members are publicly writable"
    on public.omr_organization_members
    for all
    using (true)
    with check (true);

drop policy if exists "OMR classes are publicly writable" on public.omr_classes;
create policy "OMR classes are publicly writable"
    on public.omr_classes
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

drop policy if exists "OMR audit logs are publicly writable" on public.omr_audit_logs;
create policy "OMR audit logs are publicly writable"
    on public.omr_audit_logs
    for all
    using (true)
    with check (true);
