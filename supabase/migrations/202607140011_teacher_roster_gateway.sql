begin;

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

create or replace function public.omr_save_roster_v1(
    p_organization_id text,
    p_classes jsonb,
    p_students jsonb,
    p_enrollments jsonb,
    p_invites jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_now timestamptz := now();
begin
    if nullif(btrim(p_organization_id), '') is null
       or jsonb_typeof(p_classes) is distinct from 'array'
       or jsonb_typeof(p_students) is distinct from 'array'
       or jsonb_typeof(p_enrollments) is distinct from 'array'
       or jsonb_typeof(p_invites) is distinct from 'array' then
        raise exception 'invalid roster payload';
    end if;

    if exists (
        select 1 from jsonb_array_elements(p_classes) item
        where item->>'organization_id' is distinct from p_organization_id
    ) or exists (
        select 1 from jsonb_array_elements(p_students) item
        where item->>'organization_id' is distinct from p_organization_id
    ) or exists (
        select 1 from jsonb_array_elements(p_enrollments) item
        where item->>'organization_id' is distinct from p_organization_id
    ) or exists (
        select 1 from jsonb_array_elements(p_invites) item
        where item->>'organization_id' is distinct from p_organization_id
    ) then
        raise exception 'roster organization scope mismatch';
    end if;

    if exists (
        select 1
        from public.omr_classes row
        join jsonb_array_elements(p_classes) item on item->>'id' = row.id
        where row.organization_id is distinct from p_organization_id
    ) or exists (
        select 1
        from public.omr_student_profiles row
        join jsonb_array_elements(p_students) item on item->>'id' = row.id
        where row.organization_id is distinct from p_organization_id
    ) then
        raise exception 'roster identifier belongs to another organization';
    end if;

    update public.omr_classes row
    set status = 'archived', updated_at = v_now
    where row.organization_id = p_organization_id
      and row.status <> 'archived'
      and not exists (select 1 from jsonb_array_elements(p_classes) item where item->>'id' = row.id);

    insert into public.omr_classes (id, organization_id, name, campus, status, metadata, updated_at)
    select
        item->>'id', p_organization_id, item->>'name', nullif(item->>'campus', ''),
        coalesce(nullif(item->>'status', ''), 'active'), coalesce(item->'metadata', '{}'::jsonb), v_now
    from jsonb_array_elements(p_classes) item
    on conflict (id) do update set
        name = excluded.name,
        campus = excluded.campus,
        status = excluded.status,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    where public.omr_classes.organization_id = p_organization_id;

    update public.omr_student_profiles row
    set status = 'withdrawn', updated_at = v_now
    where row.organization_id = p_organization_id
      and row.status <> 'withdrawn'
      and not exists (select 1 from jsonb_array_elements(p_students) item where item->>'id' = row.id);

    insert into public.omr_student_profiles (
        id, organization_id, display_name, external_id, email, status, metadata, updated_at
    )
    select
        item->>'id', p_organization_id, item->>'display_name', nullif(item->>'external_id', ''),
        nullif(item->>'email', ''), coalesce(nullif(item->>'status', ''), 'active'),
        coalesce(item->'metadata', '{}'::jsonb), v_now
    from jsonb_array_elements(p_students) item
    on conflict (id) do update set
        display_name = excluded.display_name,
        external_id = excluded.external_id,
        email = excluded.email,
        status = excluded.status,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
    where public.omr_student_profiles.organization_id = p_organization_id;

    if exists (
        select 1
        from jsonb_array_elements(p_enrollments) item
        left join public.omr_classes class_row
          on class_row.id = item->>'class_id'
         and class_row.organization_id = p_organization_id
        left join public.omr_student_profiles student_row
          on student_row.id = item->>'student_profile_id'
         and student_row.organization_id = p_organization_id
        where class_row.id is null or student_row.id is null
    ) then
        raise exception 'roster enrollment target scope mismatch';
    end if;

    update public.omr_class_students row
    set enrollment_status = 'inactive'
    where row.organization_id = p_organization_id
      and row.enrollment_status <> 'inactive'
      and not exists (
          select 1 from jsonb_array_elements(p_enrollments) item
          where item->>'class_id' = row.class_id
            and item->>'student_profile_id' = row.student_profile_id
      );

    insert into public.omr_class_students (
        class_id, organization_id, student_profile_id, enrollment_status
    )
    select
        item->>'class_id', p_organization_id, item->>'student_profile_id',
        coalesce(nullif(item->>'enrollment_status', ''), 'active')
    from jsonb_array_elements(p_enrollments) item
    on conflict (class_id, student_profile_id) do update set
        organization_id = excluded.organization_id,
        enrollment_status = excluded.enrollment_status;

    delete from public.omr_roster_invites row
    where row.organization_id = p_organization_id
      and not exists (select 1 from jsonb_array_elements(p_invites) item where item->>'id' = row.id);

    insert into public.omr_roster_invites (organization_id, id, email, sent_at, status, updated_at)
    select
        p_organization_id, item->>'id', lower(item->>'email'), item->>'sent_at',
        coalesce(nullif(item->>'status', ''), 'pending'), v_now
    from jsonb_array_elements(p_invites) item
    on conflict (organization_id, id) do update set
        email = excluded.email,
        sent_at = excluded.sent_at,
        status = excluded.status,
        updated_at = excluded.updated_at;

    return jsonb_build_object(
        'classes', jsonb_array_length(p_classes),
        'students', jsonb_array_length(p_students),
        'enrollments', jsonb_array_length(p_enrollments),
        'invites', jsonb_array_length(p_invites)
    );
end;
$$;

revoke all on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb) to service_role;

commit;
