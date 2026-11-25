\set ON_ERROR_STOP on

begin;
set local timezone to 'Asia/Seoul';

insert into public.omr_organizations (id, name, plan)
values ('test-roster-tz-org', 'UTC roster test', 'academy');
insert into public.omr_classes (id, organization_id, name, updated_at)
values ('test-roster-tz-class', 'test-roster-tz-org', 'UTC class', '2026-11-25 20:10:12.123456+09');
insert into public.omr_student_profiles (id, organization_id, display_name, updated_at)
values ('test-roster-tz-student', 'test-roster-tz-org', 'UTC student', '2026-11-25 20:10:15.654321+09');

do $$
declare
    roster jsonb := public.omr_load_roster_v2('test-roster-tz-org');
begin
    if roster #>> '{classes,0,updated_at}' is distinct from '2026-11-25T11:10:12.123456+00:00'
       or roster #>> '{students,0,updated_at}' is distinct from '2026-11-25T11:10:15.654321+00:00' then
        raise exception 'roster read must serialize both update timestamps in UTC with full precision';
    end if;
    if current_setting('TimeZone') <> 'Asia/Seoul' then
        raise exception 'roster read changed the caller time zone';
    end if;
end;
$$;

rollback;

