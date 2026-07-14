begin;

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

commit;
