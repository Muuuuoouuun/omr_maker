\set ON_ERROR_STOP on

create function public.omr_save_kakao_candidate_review_v1(p_probe text)
returns jsonb
language sql
as $$ select pg_catalog.jsonb_build_object('status', 'impostor') $$;

create procedure public.omr_save_kakao_simulation_dispatch_v1(p_probe text)
language plpgsql
as $$ begin perform p_probe; end $$;

create function public.omr_kakao_reminder_legacy_inventory_v1(p_probe text)
returns jsonb
language sql
as $$ select pg_catalog.jsonb_build_object('status', p_probe) $$;

create function public.omr_kakao_reminder_entitlement_ready_v1(p_probe text)
returns boolean
language sql
as $$ select p_probe is not null $$;

create procedure public.omr_quarantine_kakao_reminder_legacy_v1(
    p_confirmation text,
    p_probe text
)
language plpgsql
as $$ begin perform p_confirmation, p_probe; end $$;

grant execute on function public.omr_save_kakao_candidate_review_v1(text)
    to public, anon, authenticated, service_role;
grant execute on procedure public.omr_save_kakao_simulation_dispatch_v1(text)
    to public, anon, authenticated, service_role;
grant execute on function public.omr_kakao_reminder_legacy_inventory_v1(text)
    to public, anon, authenticated, service_role;
grant execute on function public.omr_kakao_reminder_entitlement_ready_v1(text)
    to public, anon, authenticated, service_role;
grant execute on procedure public.omr_quarantine_kakao_reminder_legacy_v1(text,text)
    to public, anon, authenticated, service_role;
