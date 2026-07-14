begin;

create or replace function public.omr_attach_attempt_handwriting_v1(
    p_ticket_id text,
    p_asset_id text,
    p_ref jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_attempt public.omr_attempts%rowtype;
begin
    if nullif(trim(p_ticket_id), '') is null
        or nullif(trim(p_asset_id), '') is null
        or jsonb_typeof(p_ref) <> 'object'
    then
        raise exception 'invalid handwriting attachment';
    end if;

    select * into v_attempt
      from public.omr_attempts
     where ticket_id = trim(p_ticket_id)
       and id = 'attempt_' || trim(p_ticket_id)
     for update;

    if not found then
        raise exception 'attempt ticket not found';
    end if;

    if not exists (
        select 1
          from public.omr_remote_assets asset
         where asset.id = trim(p_asset_id)
           and asset.organization_id = v_attempt.organization_id
           and asset.attempt_id = v_attempt.id
           and asset.kind = 'attempt_handwriting'
    ) then
        raise exception 'handwriting asset scope mismatch';
    end if;

    update public.omr_attempts
       set payload = jsonb_set(
           jsonb_set(payload, '{drawingsRef}', p_ref, true),
           '{handwritingArchived}', 'true'::jsonb, true
       )
     where id = v_attempt.id
     returning * into v_attempt;

    return v_attempt.payload;
end;
$$;

revoke all on function public.omr_attach_attempt_handwriting_v1(text, text, jsonb) from public;
revoke all on function public.omr_attach_attempt_handwriting_v1(text, text, jsonb) from anon;
revoke all on function public.omr_attach_attempt_handwriting_v1(text, text, jsonb) from authenticated;
grant execute on function public.omr_attach_attempt_handwriting_v1(text, text, jsonb) to service_role;

commit;
