\set ON_ERROR_STOP on

do $kakao_upgrade_inventory$
declare
    inventory jsonb;
    quarantined jsonb;
begin
    if not exists (
        select 1 from public.omr_kakao_candidate_reviews
         where id = 'kakao:upgrade:valid-review'
           and entitlement_state = 'validated_legacy'
           and organization_id = 'kakao-upgrade-valid-org'
           and exam_id = 'kakao-upgrade-valid-exam'
           and payload = '{"fixture":"valid-preserve-v1"}'::jsonb
    ) or not exists (
        select 1 from public.omr_kakao_dispatch_logs
         where id = 'kakao:upgrade:valid-dispatch'
           and entitlement_state = 'validated_legacy'
           and organization_id = 'kakao-upgrade-valid-org'
           and review_id = 'kakao:upgrade:valid-review'
           and exam_id = 'kakao-upgrade-valid-exam'
           and payload = '{"fixture":"valid-dispatch-preserve-v1"}'::jsonb
    ) then
        raise exception 'objectively scoped Kakao legacy rows were not preserved and validated';
    end if;

    if not exists (
        select 1 from public.omr_kakao_candidate_reviews
         where id = 'kakao:upgrade:ambiguous-review'
           and entitlement_state = 'legacy_unreconciled'
           and organization_id is null
           and payload = '{"fixture":"ambiguous-preserve-v1","opaque":"must-survive"}'::jsonb
    ) then
        raise exception 'ambiguous Kakao legacy source was changed or deleted implicitly';
    end if;

    select row_snapshot into quarantined
      from public.omr_kakao_reminder_legacy_quarantine
     where source_table = 'omr_kakao_candidate_reviews'
       and source_id = 'kakao:upgrade:ambiguous-review';
    if quarantined is null
       or quarantined -> 'payload'
          <> '{"fixture":"ambiguous-preserve-v1","opaque":"must-survive"}'::jsonb
       or quarantined ->> 'organization_id' is not null
       or quarantined ->> 'entitlement_state' <> 'legacy_unreconciled' then
        raise exception 'ambiguous Kakao legacy quarantine snapshot is not exact';
    end if;
    if not exists (
        select 1 from public.omr_kakao_dispatch_logs
         where id = 'kakao:upgrade:ambiguous-dispatch'
           and entitlement_state = 'legacy_unreconciled'
           and organization_id = 'kakao-upgrade-ambiguous-org'
           and review_id = 'kakao:upgrade:ambiguous-review'
           and payload = '{"fixture":"ambiguous-dispatch-preserve-v1"}'::jsonb
    ) or not exists (
        select 1 from public.omr_kakao_reminder_legacy_quarantine
         where source_table = 'omr_kakao_dispatch_logs'
           and source_id = 'kakao:upgrade:ambiguous-dispatch'
           and row_snapshot -> 'payload'
               = '{"fixture":"ambiguous-dispatch-preserve-v1"}'::jsonb
    ) then
        raise exception 'dispatch with ambiguous parent was not preserved and quarantined';
    end if;

    inventory := public.omr_kakao_reminder_legacy_inventory_v1();
    if inventory <> pg_catalog.jsonb_build_object(
        'reviewUnreconciled', 1,
        'dispatchUnreconciled', 1,
        'reviewValidatedLegacy', 1,
        'dispatchValidatedLegacy', 1,
        'quarantineInventory', 2
    ) or inventory::text like '%kakao:upgrade:%'
       or public.omr_kakao_reminder_entitlement_ready_v1() then
        raise exception 'Kakao legacy inventory/readiness leaked identity or accepted ambiguity: %', inventory;
    end if;
end
$kakao_upgrade_inventory$;

-- Even service_role cannot mutate the retained source or perform reconciliation.
begin;
set local role service_role;
do $kakao_upgrade_service_acl$
begin
    begin
        update public.omr_kakao_candidate_reviews
           set payload = '{"tampered":true}'::jsonb
         where id = 'kakao:upgrade:ambiguous-review';
        raise exception 'service_role unexpectedly mutated ambiguous Kakao source';
    exception when insufficient_privilege then
        null;
    end;
    begin
        perform public.omr_quarantine_kakao_reminder_legacy_v1(
            'quarantine_untrusted_kakao_reminder_rows'
        );
        raise exception 'service_role unexpectedly reconciled ambiguous Kakao source';
    exception when insufficient_privilege then
        null;
    end;
end
$kakao_upgrade_service_acl$;
rollback;

do $kakao_upgrade_explicit_quarantine$
declare result jsonb;
begin
    result := public.omr_quarantine_kakao_reminder_legacy_v1(
        'quarantine_untrusted_kakao_reminder_rows'
    );
    if result <> '{"status":"quarantined","reviewCount":1,"dispatchCount":1}'::jsonb
       or not public.omr_kakao_reminder_entitlement_ready_v1()
       or not exists (
           select 1 from public.omr_kakao_candidate_reviews
            where id = 'kakao:upgrade:ambiguous-review'
              and entitlement_state = 'quarantined'
              and organization_id is null
              and payload = '{"fixture":"ambiguous-preserve-v1","opaque":"must-survive"}'::jsonb
       )
       or not exists (
           select 1 from public.omr_kakao_reminder_legacy_quarantine
            where source_table = 'omr_kakao_candidate_reviews'
              and source_id = 'kakao:upgrade:ambiguous-review'
              and row_snapshot -> 'payload'
                  = '{"fixture":"ambiguous-preserve-v1","opaque":"must-survive"}'::jsonb
       )
       or not exists (
           select 1 from public.omr_kakao_dispatch_logs
            where id = 'kakao:upgrade:ambiguous-dispatch'
              and entitlement_state = 'quarantined'
              and payload = '{"fixture":"ambiguous-dispatch-preserve-v1"}'::jsonb
       ) then
        raise exception 'explicit Kakao quarantine was not lossless/readiness-safe: %', result;
    end if;
end
$kakao_upgrade_explicit_quarantine$;
