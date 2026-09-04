begin;

-- Whole-roster saves replace multiple related tables. Keep an explicit
-- organization-scoped revision so stale browser snapshots cannot overwrite a
-- newer save from another teacher or device.
create table if not exists public.omr_roster_revisions (
    organization_id text primary key references public.omr_organizations(id) on delete cascade,
    revision bigint not null default 0 check (revision >= 0),
    updated_at timestamptz not null default now()
);

alter table public.omr_roster_revisions enable row level security;
alter table public.omr_roster_revisions force row level security;
revoke all on public.omr_roster_revisions from public, anon, authenticated;

create or replace function public.omr_save_roster_v2(
    p_organization_id text,
    p_expected_revision bigint,
    p_classes jsonb,
    p_students jsonb,
    p_enrollments jsonb,
    p_invites jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_revision bigint;
    v_result jsonb;
begin
    if nullif(btrim(p_organization_id), '') is null
       or p_expected_revision is null
       or p_expected_revision < 0 then
        raise exception 'invalid roster revision payload';
    end if;

    insert into public.omr_roster_revisions (organization_id, revision)
    values (btrim(p_organization_id), 0)
    on conflict (organization_id) do nothing;

    select row.revision into v_revision
      from public.omr_roster_revisions row
     where row.organization_id = btrim(p_organization_id)
     for update;

    if v_revision is distinct from p_expected_revision then
        raise exception using
            errcode = '40001',
            message = 'roster revision conflict';
    end if;

    v_result := public.omr_save_roster_v1(
        btrim(p_organization_id),
        p_classes,
        p_students,
        p_enrollments,
        p_invites
    );

    update public.omr_roster_revisions
       set revision = v_revision + 1,
           updated_at = now()
     where organization_id = btrim(p_organization_id);

    return coalesce(v_result, '{}'::jsonb)
        || jsonb_build_object('revision', v_revision + 1);
end;
$$;

revoke all on function public.omr_save_roster_v2(text, bigint, jsonb, jsonb, jsonb, jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_save_roster_v2(text, bigint, jsonb, jsonb, jsonb, jsonb)
    to service_role;

-- Prevent older app instances from bypassing the revision guard. The v2
-- security-definer function can still call v1 as its owner.
revoke execute on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    from service_role;

commit;
