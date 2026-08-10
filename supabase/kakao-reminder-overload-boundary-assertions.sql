\set ON_ERROR_STOP on

do $kakao_overload_boundary$
declare
    readiness jsonb;
begin
    if exists (
        select 1
          from pg_catalog.pg_proc routine
          join pg_catalog.pg_namespace namespace on namespace.oid = routine.pronamespace
         where namespace.nspname = 'public'
           and routine.proname in (
               'omr_save_kakao_candidate_review_v1',
               'omr_save_kakao_simulation_dispatch_v1',
               'omr_kakao_reminder_legacy_inventory_v1',
               'omr_quarantine_kakao_reminder_legacy_v1',
               'omr_kakao_reminder_entitlement_ready_v1'
           )
           and (
               pg_catalog.oidvectortypes(routine.proargtypes) in ('text', 'text, text')
           )
           and (
               pg_catalog.has_function_privilege('anon', routine.oid, 'EXECUTE')
               or pg_catalog.has_function_privilege('authenticated', routine.oid, 'EXECUTE')
               or pg_catalog.has_function_privilege('service_role', routine.oid, 'EXECUTE')
           )
    ) then
        raise exception 'production boundary left Kakao impostor routine executable';
    end if;

    readiness := public.omr_service_readiness_v1();
    if readiness ->> 'kakaoReminderEntitlementReady' <> 'false'
       or readiness ->> 'ready' <> 'false' then
        raise exception 'Kakao overload/procedure drift passed readiness: %', readiness;
    end if;
end
$kakao_overload_boundary$;

drop function public.omr_save_kakao_candidate_review_v1(text);
drop procedure public.omr_save_kakao_simulation_dispatch_v1(text);
drop function public.omr_kakao_reminder_legacy_inventory_v1(text);
drop function public.omr_kakao_reminder_entitlement_ready_v1(text);
drop procedure public.omr_quarantine_kakao_reminder_legacy_v1(text,text);
