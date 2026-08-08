\set ON_ERROR_STOP on

insert into public.omr_organizations (id, name, plan, metadata)
values ('live-roster-cas-org', 'Roster CAS', 'academy', '{}'::jsonb)
on conflict (id) do update
set name = excluded.name,
    plan = excluded.plan,
    metadata = '{}'::jsonb;

select public.omr_save_roster_v2(
    'live-roster-cas-org',
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    null
);

do $$
declare
    v_revision bigint;
begin
    select (organization.metadata->>'rosterRevision')::bigint
      into v_revision
      from public.omr_organizations organization
     where organization.id = 'live-roster-cas-org';
    if v_revision <> 1 then
        raise exception 'first roster CAS save did not advance revision to 1';
    end if;

    begin
        perform public.omr_save_roster_v2(
            'live-roster-cas-org',
            '[{"id":"stale-class","organization_id":"live-roster-cas-org","name":"stale","status":"active","metadata":{}}]'::jsonb,
            '[]'::jsonb,
            '[]'::jsonb,
            '[]'::jsonb,
            0
        );
        raise exception 'stale roster writer unexpectedly committed';
    exception
        when serialization_failure then null;
    end;

    if exists (select 1 from public.omr_classes where id = 'stale-class') then
        raise exception 'stale roster writer changed canonical rows';
    end if;
    select (organization.metadata->>'rosterRevision')::bigint
      into v_revision
      from public.omr_organizations organization
     where organization.id = 'live-roster-cas-org';
    if v_revision <> 1 then
        raise exception 'stale roster writer changed the canonical revision';
    end if;
end;
$$;

select public.omr_save_roster_v2(
    'live-roster-cas-org',
    '[{"id":"fresh-class","organization_id":"live-roster-cas-org","name":"fresh","status":"active","metadata":{}}]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    '[]'::jsonb,
    1
);

do $$
begin
    if not exists (
        select 1 from public.omr_classes
         where id = 'fresh-class'
           and organization_id = 'live-roster-cas-org'
           and status = 'active'
    ) then
        raise exception 'fresh roster CAS writer did not commit';
    end if;
    if not exists (
        select 1 from public.omr_organizations organization
         where organization.id = 'live-roster-cas-org'
           and (organization.metadata->>'rosterRevision')::bigint = 2
    ) then
        raise exception 'fresh roster CAS writer did not advance revision to 2';
    end if;
    if has_function_privilege(
        'anon',
        'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)',
        'EXECUTE'
    ) or has_function_privilege(
        'authenticated',
        'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)',
        'EXECUTE'
    ) then
        raise exception 'browser role unexpectedly has roster CAS execute privilege';
    end if;
    if has_function_privilege(
        'service_role',
        'public.omr_save_roster_v2(text,jsonb,jsonb,jsonb,jsonb,bigint)',
        'EXECUTE'
    ) or not has_function_privilege(
        'service_role',
        'public.omr_save_roster_v3(text,text,bigint,text,text,jsonb,jsonb,jsonb,jsonb,bigint)',
        'EXECUTE'
    ) then
        raise exception 'service role roster CAS boundary is not v3-only';
    end if;
end;
$$;

select public.omr_bootstrap_workspace_organization_v1(
    'live-roster-cas-org',
    'Roster CAS renamed',
    '{"source":"bootstrap-race-check"}'::jsonb,
    pg_catalog.now()
);

do $$
begin
    if not exists (
        select 1 from public.omr_organizations organization
         where organization.id = 'live-roster-cas-org'
           and organization.metadata->>'source' = 'bootstrap-race-check'
           and (organization.metadata->>'rosterRevision')::bigint = 2
    ) then
        raise exception 'workspace bootstrap reset the roster revision';
    end if;
end;
$$;

create function public.omr_test_roster_locked_update()
returns void
language plpgsql
set search_path = ''
as $$
begin
    perform pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('omr_roster:live-roster-cas-org', 0)
    );
    update public.omr_classes
       set name = 'concurrent-fresh'
     where id = 'fresh-class'
       and organization_id = 'live-roster-cas-org';
    update public.omr_organizations organization
       set metadata = pg_catalog.jsonb_set(
           organization.metadata,
           '{rosterRevision}',
           '3'::jsonb,
           true
       )
     where organization.id = 'live-roster-cas-org';
    perform pg_catalog.pg_sleep(2);
end;
$$;
revoke all on function public.omr_test_roster_locked_update() from public, anon, authenticated;

do $$
declare
    v_remote_pid integer;
    v_remote_sleeping boolean := false;
    v_counter integer;
    v_snapshot jsonb;
begin
    perform extensions.dblink_connect(
        'roster-load-lock',
        'host=127.0.0.1 port=' || current_setting('port')
            || ' dbname=' || current_database()
            || ' user=postgres password=omr-live-test-password'
    );
    select remote.pid into v_remote_pid
      from extensions.dblink(
          'roster-load-lock', 'select pg_backend_pid()'
      ) as remote(pid integer);
    perform extensions.dblink_send_query(
        'roster-load-lock',
        'select public.omr_test_roster_locked_update()'
    );
    for v_counter in 1..200 loop
        select activity.wait_event = 'PgSleep'
          into v_remote_sleeping
          from pg_catalog.pg_stat_activity activity
         where activity.pid = v_remote_pid;
        exit when coalesce(v_remote_sleeping, false);
        perform pg_catalog.pg_sleep(0.01);
    end loop;
    if not coalesce(v_remote_sleeping, false) then
        raise exception 'roster load lock concurrency fixture was not ready';
    end if;

    v_snapshot := public.omr_load_roster_v2('live-roster-cas-org');
    if (v_snapshot->>'revision')::bigint <> 3
       or v_snapshot->'classes'->0->>'name' <> 'concurrent-fresh' then
        raise exception 'atomic roster load returned rows from a different revision';
    end if;

    perform * from extensions.dblink_get_result(
        'roster-load-lock'
    ) as remote_result(result text);
    perform extensions.dblink_disconnect('roster-load-lock');
end;
$$;

drop function public.omr_test_roster_locked_update();

begin;
revoke execute on function public.omr_load_roster_v2(text) from service_role;
do $$
declare
    v_readiness jsonb;
begin
    v_readiness := public.omr_service_readiness_v1();
    if v_readiness->>'version' <> '202608080010'
       or v_readiness->>'rosterSnapshotCasReady' <> 'false'
       or v_readiness->>'serverGatewayCapabilitiesReady' <> 'false'
       or v_readiness->>'ready' <> 'false' then
        raise exception 'readiness accepted a missing atomic roster load privilege: %', v_readiness;
    end if;
end;
$$;
rollback;

delete from public.omr_organizations where id = 'live-roster-cas-org';
