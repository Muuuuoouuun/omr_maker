begin;

-- A cloned remote asset must reference an existing exam. Create a minimal,
-- operation-owned row before copying assets, without ever overwriting an
-- existing exam id.
create or replace function public.omr_create_exam_clone_target_v1(
    p_organization_id text,
    p_exam_id text,
    p_title text,
    p_actor_user_id text,
    p_operation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_now timestamptz := now();
    v_created boolean := false;
begin
    if nullif(btrim(p_organization_id), '') is null
       or nullif(btrim(p_exam_id), '') is null
       or nullif(btrim(p_title), '') is null
       or nullif(btrim(p_actor_user_id), '') is null
       or nullif(btrim(p_operation_id), '') is null then
        raise exception 'invalid exam clone target request';
    end if;

    insert into public.omr_exams (
        id, organization_id, title, payload, created_by_user_id,
        created_at, updated_at, archived
    ) values (
        btrim(p_exam_id),
        btrim(p_organization_id),
        btrim(p_title),
        jsonb_build_object(
            'id', btrim(p_exam_id),
            'organizationId', btrim(p_organization_id),
            'title', btrim(p_title),
            'questions', '[]'::jsonb,
            'createdAt', v_now,
            'updatedAt', v_now,
            'archived', false,
            'cloneState', 'provisional',
            'cloneOperationId', btrim(p_operation_id)
        ),
        btrim(p_actor_user_id),
        v_now,
        v_now,
        false
    )
    on conflict (id) do nothing;
    v_created := found;

    return jsonb_build_object('created', v_created);
end;
$$;

-- Cleanup is deliberately marker-scoped. A retry cannot delete an unrelated
-- collision or a target whose final canonical payload has already replaced
-- the provisional marker.
create or replace function public.omr_cleanup_exam_clone_target_v1(
    p_organization_id text,
    p_exam_id text,
    p_operation_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_deleted boolean := false;
begin
    if nullif(btrim(p_organization_id), '') is null
       or nullif(btrim(p_exam_id), '') is null
       or nullif(btrim(p_operation_id), '') is null then
        raise exception 'invalid exam clone cleanup request';
    end if;

    delete from public.omr_exams exam
     where exam.id = btrim(p_exam_id)
       and exam.organization_id = btrim(p_organization_id)
       and exam.payload ->> 'cloneState' = 'provisional'
       and exam.payload ->> 'cloneOperationId' = p_operation_id;
    v_deleted := found;

    return jsonb_build_object('deleted', v_deleted);
end;
$$;

revoke all on function public.omr_create_exam_clone_target_v1(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.omr_create_exam_clone_target_v1(text, text, text, text, text) to service_role;
revoke all on function public.omr_cleanup_exam_clone_target_v1(text, text, text) from public, anon, authenticated;
grant execute on function public.omr_cleanup_exam_clone_target_v1(text, text, text) to service_role;

commit;
