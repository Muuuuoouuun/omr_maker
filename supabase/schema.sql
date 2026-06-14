-- OMR Maker persistence tables.
-- Run this in Supabase SQL Editor before enabling the app's Supabase env vars.

create table if not exists public.omr_exams (
    id text primary key,
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
    exam_id text not null,
    student_name text not null,
    student_id text,
    group_id text,
    group_name text,
    payload jsonb not null,
    started_at timestamptz not null,
    finished_at timestamptz not null
);

create index if not exists omr_attempts_exam_id_idx
    on public.omr_attempts (exam_id);

create index if not exists omr_attempts_finished_at_idx
    on public.omr_attempts (finished_at desc);

alter table public.omr_exams enable row level security;
alter table public.omr_attempts enable row level security;

-- Development/open-classroom policies. The current app has no real auth yet,
-- so publishable-key clients need public read/write access to sync data.
-- Tighten these policies before using this with sensitive student data.
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
