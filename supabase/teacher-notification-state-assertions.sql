\set ON_ERROR_STOP on

begin;

insert into public.omr_organizations (id, name, plan)
values
    ('notification-state-org', 'Notification State Org', 'free'),
    ('notification-state-foreign', 'Notification State Foreign', 'free')
on conflict (id) do nothing;

do $$
declare
    v_id text := 'auto-recent-exams:3:11111111111111111111111111111111';
    v_other_id text := 'auto-student-questions:2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    v_count integer;
    v_dismissed_at timestamptz;
begin
    perform public.omr_mutate_teacher_notification_state_v1(
        'notification-state-org', 'teacher-user-a', 'dismiss', array[v_id]
    );

    select count(*) into v_count
      from public.omr_load_teacher_notification_state_v1(
          'notification-state-foreign', 'teacher-user-a', array[v_id]
      );
    if v_count <> 0 then
        raise exception 'notification state organization isolation failed';
    end if;

    select count(*) into v_count
      from public.omr_load_teacher_notification_state_v1(
          'notification-state-org', 'teacher-user-b', array[v_id]
      );
    if v_count <> 0 then
        raise exception 'notification state teacher isolation failed';
    end if;

    select state.dismissed_at into v_dismissed_at
      from public.omr_load_teacher_notification_state_v1(
          'notification-state-org', 'teacher-user-a', array[v_id]
      ) state;
    if v_dismissed_at is null then
        raise exception 'dismiss mutation did not persist';
    end if;

    perform public.omr_mutate_teacher_notification_state_v1(
        'notification-state-org', 'teacher-user-a', 'mark_read', array[v_id]
    );
    select state.dismissed_at into v_dismissed_at
      from public.omr_load_teacher_notification_state_v1(
          'notification-state-org', 'teacher-user-a', array[v_id]
      ) state;
    if v_dismissed_at is null then
        raise exception 'dismissal was resurrected by mark_read';
    end if;

    perform public.omr_mutate_teacher_notification_state_v1(
        'notification-state-org', 'teacher-user-b', 'mark_read', array[v_other_id]
    );
end;
$$;

-- Generate more than the retained per-user maximum through bounded requests.
do $$
declare
    v_start integer;
    v_ids text[];
    v_count integer;
begin
    for v_start in 1..5 loop
        select pg_catalog.array_agg(
            'auto-recent-exams:' || item::text || ':' || pg_catalog.md5('notification-state-' || item::text)
            order by item
        )
          into v_ids
          from pg_catalog.generate_series((v_start - 1) * 14 + 1, v_start * 14) item;
        perform public.omr_mutate_teacher_notification_state_v1(
            'notification-state-org', 'teacher-retention', 'mark_read', v_ids
        );
    end loop;

    select count(*) into v_count
      from public.omr_teacher_notification_states state
     where state.organization_id = 'notification-state-org'
       and state.teacher_user_id = 'teacher-retention';
    if v_count <> 64 then
        raise exception 'notification state retention cap failed: %', v_count;
    end if;
end;
$$;

do $$
declare
    v_failed boolean := false;
begin
    begin
        perform public.omr_mutate_teacher_notification_state_v1(
            'notification-state-org',
            'teacher-user-a',
            'dismiss',
            pg_catalog.array_fill(
                'auto-recent-exams:1:22222222222222222222222222222222'::text,
                array[17]
            )
        );
    exception when others then
        v_failed := true;
    end;
    if not v_failed then
        raise exception 'notification state accepted an oversized request';
    end if;

    if pg_catalog.has_table_privilege(
        'public', 'public.omr_teacher_notification_states',
        'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'anon', 'public.omr_teacher_notification_states',
        'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'authenticated', 'public.omr_teacher_notification_states',
        'SELECT,INSERT,UPDATE,DELETE'
    ) or pg_catalog.has_table_privilege(
        'service_role', 'public.omr_teacher_notification_states',
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'
    ) then
        raise exception 'notification state table privileges are not RPC-only';
    end if;

    if pg_catalog.has_function_privilege(
        'anon', 'public.omr_load_teacher_notification_state_v1(text,text,text[])', 'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated', 'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_load_teacher_notification_state_v1(text,text,text[])', 'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role', 'public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])', 'EXECUTE'
    ) then
        raise exception 'notification state RPC privileges are not service-only';
    end if;

    if not exists (
        select 1
          from pg_catalog.pg_class relation
         where relation.oid = 'public.omr_teacher_notification_states'::pg_catalog.regclass
           and relation.relrowsecurity
           and relation.relforcerowsecurity
    ) then
        raise exception 'notification state table is not FORCE RLS';
    end if;
end;
$$;

rollback;
