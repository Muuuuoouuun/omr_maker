begin;

-- Load the roster rows and the revision under the same lock used by saves. A
-- parallel Promise.all of table reads can otherwise pair old rows with a new
-- revision (or vice versa), defeating the optimistic-concurrency boundary.
create function public.omr_load_roster_v2(p_organization_id text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_current_revision bigint;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_roster:' || pg_catalog.btrim(p_organization_id), 0)
    );
    select case
               when coalesce(organization.metadata->>'rosterRevision', '') ~ '^[0-9]+$'
                   then (organization.metadata->>'rosterRevision')::bigint
               else 0
           end
      into v_current_revision
      from public.omr_organizations organization
     where organization.id = pg_catalog.btrim(p_organization_id);
    if not found then
        raise exception 'roster organization does not exist';
    end if;

    return pg_catalog.jsonb_build_object(
        'revision', v_current_revision,
        'classes', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(class_row) order by class_row.id)
              from (
                  select class_item.id, class_item.organization_id, class_item.name,
                         class_item.campus, class_item.status, class_item.metadata, class_item.updated_at
                    from public.omr_classes class_item
                   where class_item.organization_id = pg_catalog.btrim(p_organization_id)
                   order by class_item.id
                   limit 101
              ) class_row
        ), '[]'::jsonb),
        'students', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(student_row) order by student_row.id)
              from (
                  select student_item.id, student_item.organization_id, student_item.display_name,
                         student_item.external_id, student_item.email, student_item.status,
                         student_item.metadata, student_item.updated_at
                    from public.omr_student_profiles student_item
                   where student_item.organization_id = pg_catalog.btrim(p_organization_id)
                   order by student_item.id
                   limit 101
              ) student_row
        ), '[]'::jsonb),
        'enrollments', coalesce((
            select pg_catalog.jsonb_agg(
                       pg_catalog.to_jsonb(enrollment_row)
                       order by enrollment_row.class_id, enrollment_row.student_profile_id
                   )
              from (
                  select enrollment_item.class_id, enrollment_item.organization_id,
                         enrollment_item.student_profile_id, enrollment_item.enrollment_status
                    from public.omr_class_students enrollment_item
                   where enrollment_item.organization_id = pg_catalog.btrim(p_organization_id)
                   order by enrollment_item.class_id, enrollment_item.student_profile_id
                   limit 501
              ) enrollment_row
        ), '[]'::jsonb),
        'invites', coalesce((
            select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(invite_row) order by invite_row.id)
              from (
                  select invite_item.id, invite_item.organization_id, invite_item.email,
                         invite_item.sent_at, invite_item.status
                    from public.omr_roster_invites invite_item
                   where invite_item.organization_id = pg_catalog.btrim(p_organization_id)
                   order by invite_item.id
                   limit 251
              ) invite_row
        ), '[]'::jsonb)
    );
end;
$$;

revoke all on function public.omr_load_roster_v2(text) from public, anon, authenticated;
grant execute on function public.omr_load_roster_v2(text) to service_role;

-- The existing v1 RPC serializes whole-roster writes, but serialization alone
-- still lets a stale device overwrite a newer committed snapshot. V2 is now the
-- only service-role write boundary; it invokes v1 internally after the CAS.
create function public.omr_save_roster_v2(
    p_organization_id text,
    p_classes jsonb,
    p_students jsonb,
    p_enrollments jsonb,
    p_invites jsonb,
    p_expected_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_current_revision bigint;
    v_result jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;

    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_roster:' || pg_catalog.btrim(p_organization_id), 0)
    );

    select case
               when coalesce(organization.metadata->>'rosterRevision', '') ~ '^[0-9]+$'
                   then (organization.metadata->>'rosterRevision')::bigint
               else 0
           end
      into v_current_revision
      from public.omr_organizations organization
     where organization.id = pg_catalog.btrim(p_organization_id)
     for update;

    if not found then
        raise exception 'roster organization does not exist';
    end if;
    if (p_expected_revision is null and v_current_revision <> 0)
       or (p_expected_revision is not null and p_expected_revision <> v_current_revision) then
        raise exception 'roster revision conflict'
            using errcode = '40001',
                  detail = pg_catalog.format(
                      'expected revision %s, current revision %s',
                      coalesce(p_expected_revision::text, 'null'),
                      v_current_revision
                  );
    end if;

    v_result := public.omr_save_roster_v1(
        p_organization_id,
        p_classes,
        p_students,
        p_enrollments,
        p_invites
    );

    update public.omr_organizations organization
       set metadata = pg_catalog.jsonb_set(
               coalesce(organization.metadata, '{}'::jsonb),
               '{rosterRevision}',
               pg_catalog.to_jsonb(v_current_revision + 1),
               true
           ),
           updated_at = pg_catalog.now()
     where organization.id = pg_catalog.btrim(p_organization_id);

    return v_result || pg_catalog.jsonb_build_object('revision', v_current_revision + 1);
end;
$$;

revoke all on function public.omr_save_roster_v2(text, jsonb, jsonb, jsonb, jsonb, bigint)
    from public, anon, authenticated;
grant execute on function public.omr_save_roster_v2(text, jsonb, jsonb, jsonb, jsonb, bigint)
    to service_role;
revoke execute on function public.omr_save_roster_v1(text, jsonb, jsonb, jsonb, jsonb)
    from service_role;

-- Workspace bootstrap previously replaced organization metadata wholesale.
-- Serialize it with roster saves and retain the server-owned revision key so a
-- later action-context bootstrap cannot silently reset CAS back to revision 0.
create or replace function public.omr_bootstrap_workspace_organization_v1(
    p_organization_id text,
    p_name text,
    p_metadata jsonb,
    p_updated_at timestamptz
)
returns public.omr_organizations
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_organization public.omr_organizations%rowtype;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null then
        raise exception 'organization_id is required';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'omr_roster:' || pg_catalog.btrim(p_organization_id),
            0
        )
    );

    insert into public.omr_organizations as existing (
        id, name, plan, metadata, created_at, updated_at
    )
    values (
        pg_catalog.btrim(p_organization_id),
        coalesce(nullif(pg_catalog.btrim(p_name), ''), pg_catalog.btrim(p_organization_id)),
        'free',
        coalesce(p_metadata, '{}'::jsonb),
        coalesce(p_updated_at, pg_catalog.now()),
        coalesce(p_updated_at, pg_catalog.now())
    )
    on conflict (id) do update set
        name = excluded.name,
        metadata = excluded.metadata || case
            when existing.metadata ? 'rosterRevision' then pg_catalog.jsonb_build_object(
                'rosterRevision', existing.metadata->'rosterRevision'
            )
            else '{}'::jsonb
        end,
        updated_at = excluded.updated_at
    returning * into v_organization;

    return v_organization;
end;
$$;

commit;
