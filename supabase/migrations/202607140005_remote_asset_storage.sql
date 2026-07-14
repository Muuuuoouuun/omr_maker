begin;

insert into storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
values (
    'omr-private-assets',
    'omr-private-assets',
    false,
    52428800,
    array['application/pdf', 'application/json']::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.omr_remote_assets (
    id text primary key,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    kind text not null check (kind in ('problem_pdf', 'answer_key_pdf', 'attempt_handwriting')),
    exam_id text references public.omr_exams(id) on delete cascade,
    attempt_id text references public.omr_attempts(id) on delete cascade,
    storage_bucket text not null default 'omr-private-assets' check (storage_bucket = 'omr-private-assets'),
    object_path text not null,
    mime_type text not null check (mime_type in ('application/pdf', 'application/json')),
    byte_size bigint not null check (byte_size > 0 and byte_size <= 52428800),
    sha256_hex text not null check (sha256_hex ~ '^[a-f0-9]{64}$'),
    original_name text,
    created_by_user_id text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint omr_remote_assets_owner_check check (
        (
            kind in ('problem_pdf', 'answer_key_pdf')
            and exam_id is not null
            and attempt_id is null
            and mime_type = 'application/pdf'
            and object_path like (
                'organizations/' || organization_id || '/exams/' || exam_id || '/%'
            )
            and object_path like '%.pdf'
        )
        or
        (
            kind = 'attempt_handwriting'
            and attempt_id is not null
            and exam_id is null
            and mime_type = 'application/json'
            and byte_size <= 10485760
            and object_path like (
                'organizations/' || organization_id || '/attempts/' || attempt_id || '/handwriting/%'
            )
            and object_path like '%.json'
        )
    ),
    constraint omr_remote_assets_safe_path_check check (
        object_path like ('organizations/' || organization_id || '/%')
        and position('..' in object_path) = 0
        and position(chr(92) in object_path) = 0
    ),
    constraint omr_remote_assets_object_path_uidx unique (storage_bucket, object_path)
);

create index if not exists omr_remote_assets_exam_scope_idx
    on public.omr_remote_assets (organization_id, exam_id, kind)
    where exam_id is not null;

create index if not exists omr_remote_assets_attempt_scope_idx
    on public.omr_remote_assets (organization_id, attempt_id, kind)
    where attempt_id is not null;

alter table public.omr_remote_assets enable row level security;
alter table public.omr_remote_assets force row level security;

revoke all on table public.omr_remote_assets from public;
revoke all on table public.omr_remote_assets from anon;
revoke all on table public.omr_remote_assets from authenticated;
grant select, insert, update, delete on table public.omr_remote_assets to service_role;

comment on table public.omr_remote_assets is
    'Private Supabase Storage object registry. Only server service-role gateways may read, write, or sign these objects.';
comment on column public.omr_remote_assets.object_path is
    'Immutable organizations/{organization_id}/... path. Never expose as a public Storage URL.';

commit;
