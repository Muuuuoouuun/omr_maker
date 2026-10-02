\set ON_ERROR_STOP on

insert into public.omr_organizations (id, name, plan) values
    ('cas-pro-org', 'CAS Pro Org', 'pro'),
    ('cas-free-org', 'CAS Free Org', 'free')
on conflict (id) do update set plan = excluded.plan;

insert into public.omr_organization_members (organization_id, user_id, role, status)
values ('cas-pro-org', 'cas-teacher', 'teacher', 'active')
on conflict (organization_id, user_id) do update
set role = excluded.role, status = excluded.status;

-- Prepare and finalize a real PDF intent in its own transaction, matching the
-- first browser request before the canonical exam save promotes the intent.
do $$
declare
    v_prepared jsonb;
    v_finalized jsonb;
begin
    v_prepared := public.omr_prepare_teacher_asset_upload_v1(
        pg_catalog.jsonb_build_object(
            'id', 'cas-response-loss-asset',
            'organization_id', 'cas-pro-org',
            'exam_id', 'cas-response-loss-exam',
            'kind', 'problem_pdf',
            'created_by_user_id', 'cas-teacher',
            'idempotency_key', 'cas-same-upload-nonce-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/cas-pro-org/exams/cas-response-loss-exam/problem/cas-response-loss-asset.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('7', 64),
            'original_name', 'problem.pdf',
            'expires_at', now() + interval '90 minutes'
        )
    );
    v_finalized := public.omr_finalize_teacher_asset_upload_v1(
        'cas-pro-org', 'cas-response-loss-asset', 'cas-teacher',
        pg_catalog.jsonb_build_object(
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/cas-pro-org/exams/cas-response-loss-exam/problem/cas-response-loss-asset.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('7', 64)
        )
    );
    if v_prepared ->> 'id' is distinct from 'cas-response-loss-asset'
       or v_finalized ->> 'status' is distinct from 'uploaded' then
        raise exception 'response-loss PDF intent did not prepare/finalize';
    end if;
end;
$$;

-- Save with the upload-finalize timestamp. The save promotes the intent and
-- advances its metadata timestamp after this request payload was constructed.
do $$
declare
    v_ref_updated_at text;
    v_created jsonb;
begin
    select pg_catalog.to_char(
        intent.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) into v_ref_updated_at
      from public.omr_remote_asset_upload_intents intent
     where intent.id = 'cas-response-loss-asset';

    v_created := public.omr_save_exam_v2(
        pg_catalog.jsonb_build_object(
            'id', 'cas-response-loss-exam',
            'organization_id', 'cas-pro-org',
            'title', 'CAS response loss PDF',
            'created_by_user_id', 'cas-teacher',
            'created_at', '2026-08-06T00:00:00.000Z',
            'updated_at', '2026-08-06T00:00:00.000Z',
            'archived', false,
            'payload', pg_catalog.jsonb_build_object(
                'id', 'cas-response-loss-exam',
                'title', 'CAS response loss PDF',
                'questions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                    'id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5
                )),
                'pdfDataRef', pg_catalog.jsonb_build_object(
                    'store', 'remote', 'key', 'cas-response-loss-asset',
                    'organizationId', 'cas-pro-org', 'examId', 'cas-response-loss-exam',
                    'kind', 'problem_pdf', 'mimeType', 'application/pdf',
                    'size', 123, 'updatedAt', v_ref_updated_at
                ),
                'createdAt', '2026-08-06T00:00:00.000Z',
                'updatedAt', '2026-08-06T00:00:00.000Z'
            )
        ),
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'id', 'cas-response-loss-exam:q:1', 'organization_id', 'cas-pro-org',
            'exam_id', 'cas-response-loss-exam', 'question_id', 1, 'question_number', 1,
            'canonical_question_id', 'cas-response-loss-exam:q:1', 'choices', 5,
            'correct_answer', 2, 'score', 5,
            'payload', pg_catalog.jsonb_build_object(
                'id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5
            )
        )),
        pg_catalog.jsonb_build_array('cas-response-loss-asset'),
        'cas-teacher', 0, 'cas-response-loss-save-1'
    );
    if v_created ->> 'status' is distinct from 'saved'
       or v_created ->> 'revision' is distinct from '1' then
        raise exception 'response-loss PDF exam did not commit: %', v_created;
    end if;
end;
$$;

-- A same-nonce retry returns the now-finalized intent with its promoted
-- updated_at. That metadata-only change must still replay the save receipt.
do $$
declare
    v_reprepared jsonb;
    v_ref_updated_at text;
    v_replayed jsonb;
    v_receipt jsonb;
begin
    v_reprepared := public.omr_prepare_teacher_asset_upload_v1(
        pg_catalog.jsonb_build_object(
            'id', 'cas-response-loss-asset',
            'organization_id', 'cas-pro-org',
            'exam_id', 'cas-response-loss-exam',
            'kind', 'problem_pdf',
            'created_by_user_id', 'cas-teacher',
            'idempotency_key', 'cas-same-upload-nonce-0001',
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/cas-pro-org/exams/cas-response-loss-exam/problem/cas-response-loss-asset.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('7', 64),
            'original_name', 'problem.pdf',
            'expires_at', now() + interval '90 minutes'
        )
    );
    perform public.omr_finalize_teacher_asset_upload_v1(
        'cas-pro-org', 'cas-response-loss-asset', 'cas-teacher',
        pg_catalog.jsonb_build_object(
            'storage_bucket', 'omr-private-assets',
            'object_path', 'organizations/cas-pro-org/exams/cas-response-loss-exam/problem/cas-response-loss-asset.pdf',
            'mime_type', 'application/pdf',
            'byte_size', 123,
            'sha256_hex', repeat('7', 64)
        )
    );
    select pg_catalog.to_char(
        intent.updated_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
    ) into v_ref_updated_at
      from public.omr_remote_asset_upload_intents intent
     where intent.id = 'cas-response-loss-asset';

    v_replayed := public.omr_save_exam_v2(
        pg_catalog.jsonb_build_object(
            'id', 'cas-response-loss-exam',
            'organization_id', 'cas-pro-org',
            'title', 'CAS response loss PDF',
            'created_by_user_id', 'cas-teacher',
            'created_at', '2099-01-01T00:00:00.000Z',
            'updated_at', '2099-01-01T00:00:00.000Z',
            'archived', false,
            'payload', pg_catalog.jsonb_build_object(
                'id', 'cas-response-loss-exam',
                'title', 'CAS response loss PDF',
                'questions', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                    'id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5
                )),
                'pdfDataRef', pg_catalog.jsonb_build_object(
                    'store', 'remote', 'key', 'cas-response-loss-asset',
                    'organizationId', 'cas-pro-org', 'examId', 'cas-response-loss-exam',
                    'kind', 'problem_pdf', 'mimeType', 'application/pdf',
                    'size', 123, 'updatedAt', v_ref_updated_at
                ),
                'createdAt', '2099-01-01T00:00:00.000Z',
                'updatedAt', '2099-01-01T00:00:00.000Z'
            )
        ),
        pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'id', 'cas-response-loss-exam:q:1', 'organization_id', 'cas-pro-org',
            'exam_id', 'cas-response-loss-exam', 'question_id', 1, 'question_number', 1,
            'canonical_question_id', 'cas-response-loss-exam:q:1', 'choices', 5,
            'correct_answer', 2, 'score', 5,
            'payload', pg_catalog.jsonb_build_object(
                'id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5
            )
        )),
        pg_catalog.jsonb_build_array('cas-response-loss-asset'),
        'cas-teacher', 0, 'cas-response-loss-save-1'
    );
    select mutation.result into v_receipt
      from public.omr_exam_mutations mutation
     where mutation.organization_id = 'cas-pro-org'
       and mutation.exam_id = 'cas-response-loss-exam'
       and mutation.mutation_id = 'cas-response-loss-save-1';
    if v_reprepared ->> 'status' is distinct from 'finalized'
       or v_replayed is distinct from v_receipt
       or (select revision from public.omr_exams where id = 'cas-response-loss-exam') <> 1 then
        raise exception 'same-nonce promoted PDF save did not replay: %', v_replayed;
    end if;
end;
$$;

do $$
declare
    v_created jsonb;
    v_replayed jsonb;
    v_conflict jsonb;
    v_edited jsonb;
    v_released boolean;
    v_used integer;
    v_old_count integer;
    v_recent_count integer;
begin
    v_created := public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-exam', 'organization_id', 'cas-pro-org',
            'title', 'CAS original', 'created_by_user_id', 'cas-teacher',
            'created_at', '2026-08-01T00:00:00.000Z',
            'updated_at', '2026-08-01T00:00:00.000Z',
            'archived', false,
            'payload', jsonb_build_object(
                'id', 'cas-exam', 'title', 'CAS original',
                'questions', jsonb_build_array(jsonb_build_object(
                    'id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5
                )),
                'createdAt', '2026-08-01T00:00:00.000Z',
                'updatedAt', '2026-08-01T00:00:00.000Z'
            )
        ),
        jsonb_build_array(jsonb_build_object(
            'id', 'cas-exam:q:1', 'organization_id', 'cas-pro-org',
            'exam_id', 'cas-exam', 'question_id', 1, 'question_number', 1,
            'canonical_question_id', 'cas-exam:q:1', 'choices', 5,
            'correct_answer', 2, 'score', 5,
            'payload', jsonb_build_object('id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5),
            'created_at', '2026-08-01T00:00:00.000Z',
            'updated_at', '2026-08-01T00:00:00.000Z'
        )),
        '[]'::jsonb, 'cas-teacher', 0, 'create-1'
    );
    if v_created ->> 'status' <> 'saved'
       or (v_created ->> 'revision')::bigint <> 1
       or v_created #>> '{exam,revision}' <> '1'
       or v_created #>> '{exam,updatedAt}' is distinct from v_created ->> 'updatedAt' then
        raise exception 'CAS create did not return canonical revision/server timestamp: %', v_created;
    end if;

    -- Retry the same semantic draft with fresh client timestamps. The exact
    -- committed receipt must be replayed without incrementing revision.
    v_replayed := public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-exam', 'organization_id', 'cas-pro-org',
            'title', 'CAS original', 'created_by_user_id', 'cas-teacher',
            'created_at', '2099-01-01T00:00:00.000Z',
            'updated_at', '2099-01-01T00:00:00.000Z',
            'archived', false,
            'payload', jsonb_build_object(
                'id', 'cas-exam', 'title', 'CAS original',
                'questions', jsonb_build_array(jsonb_build_object(
                    'id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5
                )),
                'createdAt', '2099-01-01T00:00:00.000Z',
                'updatedAt', '2099-01-01T00:00:00.000Z'
            )
        ),
        jsonb_build_array(jsonb_build_object(
            'id', 'cas-exam:q:1', 'organization_id', 'cas-pro-org',
            'exam_id', 'cas-exam', 'question_id', 1, 'question_number', 1,
            'canonical_question_id', 'cas-exam:q:1', 'choices', 5,
            'correct_answer', 2, 'score', 5,
            'payload', jsonb_build_object('id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5),
            'created_at', '2099-01-01T00:00:00.000Z',
            'updated_at', '2099-01-01T00:00:00.000Z'
        )),
        '[]'::jsonb, 'cas-teacher', 0, 'create-1'
    );
    if v_replayed is distinct from v_created
       or (select revision from public.omr_exams where id = 'cas-exam') <> 1 then
        raise exception 'identical mutation did not replay the committed receipt';
    end if;

    v_conflict := public.omr_save_exam_v2(
        jsonb_set(
            jsonb_set(
                jsonb_build_object(
                    'id', 'cas-exam', 'organization_id', 'cas-pro-org',
                    'title', 'mutation id reused', 'created_by_user_id', 'cas-teacher',
                    'created_at', now(), 'updated_at', now(), 'archived', false,
                    'payload', v_created -> 'exam'
                ),
                '{payload,title}', '"mutation id reused"'::jsonb
            ),
            '{payload,revision}', '0'::jsonb
        ),
        '[]'::jsonb, '[]'::jsonb, 'cas-teacher', 0, 'create-1'
    );
    if v_conflict ->> 'status' <> 'mutation_conflict' then
        raise exception 'mutation id reuse was not rejected: %', v_conflict;
    end if;

    v_conflict := public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-exam', 'organization_id', 'cas-pro-org',
            'title', 'stale create', 'created_by_user_id', 'cas-teacher',
            'created_at', now(), 'updated_at', now(), 'archived', false,
            'payload', v_created -> 'exam'
        ),
        '[]'::jsonb, '[]'::jsonb, 'cas-teacher', 0, 'stale-create'
    );
    if v_conflict ->> 'status' <> 'revision_conflict'
       or (v_conflict ->> 'currentRevision')::bigint <> 1 then
        raise exception 'expectedRevision=0 was not insert-only: %', v_conflict;
    end if;

    v_edited := public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-exam', 'organization_id', 'cas-pro-org',
            'title', 'CAS edited', 'created_by_user_id', 'cas-teacher',
            'created_at', '2026-08-01T00:00:00.000Z',
            'updated_at', '1999-01-01T00:00:00.000Z',
            'archived', false,
            'payload', jsonb_set(v_created -> 'exam', '{title}', '"CAS edited"'::jsonb)
        ),
        jsonb_build_array(jsonb_build_object(
            'id', 'cas-exam:q:1', 'organization_id', 'cas-pro-org',
            'exam_id', 'cas-exam', 'question_id', 1, 'question_number', 1,
            'canonical_question_id', 'cas-exam:q:1', 'choices', 5,
            'correct_answer', 2, 'score', 5,
            'payload', jsonb_build_object('id', 1, 'number', 1, 'answer', 2, 'score', 5, 'choices', 5)
        )),
        '[]'::jsonb, 'cas-teacher', 1, 'edit-1'
    );
    if v_edited ->> 'status' <> 'saved'
       or (v_edited ->> 'revision')::bigint <> 2
       or v_edited #>> '{exam,title}' <> 'CAS edited'
       or v_edited ->> 'updatedAt' like '1999-%' then
        raise exception 'CAS edit/server timestamp failed: %', v_edited;
    end if;

    v_conflict := public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-exam', 'organization_id', 'cas-pro-org',
            'title', 'stale edit', 'created_by_user_id', 'cas-teacher',
            'created_at', now(), 'updated_at', now(), 'archived', false,
            'payload', jsonb_set(v_created -> 'exam', '{title}', '"stale edit"'::jsonb)
        ),
        '[]'::jsonb, '[]'::jsonb, 'cas-teacher', 1, 'stale-edit'
    );
    if v_conflict ->> 'status' <> 'revision_conflict'
       or (v_conflict ->> 'currentRevision')::bigint <> 2
       or (select title from public.omr_exams where id = 'cas-exam') <> 'CAS edited' then
        raise exception 'stale edit mutated canonical state: %', v_conflict;
    end if;

    -- A committed free-plan create owns durable usage. A response-loss
    -- compensation must not refund its reservation.
    perform public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-free-exam', 'organization_id', 'cas-free-org',
            'title', 'Free CAS', 'created_by_user_id', 'cas-teacher',
            'created_at', now(), 'updated_at', now(), 'archived', false,
            'payload', jsonb_build_object(
                'id', 'cas-free-exam', 'title', 'Free CAS',
                'questions', jsonb_build_array(jsonb_build_object(
                    'id', 1, 'number', 1, 'answer', 1, 'score', 1, 'choices', 5
                )), 'createdAt', now()
            )
        ),
        jsonb_build_array(jsonb_build_object(
            'id', 'cas-free-exam:q:1', 'organization_id', 'cas-free-org',
            'exam_id', 'cas-free-exam', 'question_id', 1, 'question_number', 1,
            'canonical_question_id', 'cas-free-exam:q:1', 'choices', 5,
            'correct_answer', 1, 'score', 1,
            'payload', jsonb_build_object('id', 1, 'number', 1, 'answer', 1, 'score', 1, 'choices', 5)
        )),
        '[]'::jsonb, 'cas-teacher', 0, 'free-create'
    );
    select release_result.released, release_result.used
      into v_released, v_used
      from public.omr_release_plan_usage(
          'cas-free-org', 'exams',
          date_trunc('month', timezone('Asia/Seoul', now()))::date,
          'exam:cas-free-exam'
      ) release_result;
    if v_released or v_used <> 1 or not exists (
        select 1 from public.omr_plan_usage_reservations reservation
         where reservation.organization_id = 'cas-free-org'
           and reservation.resource_key = 'exam:cas-free-exam'
    ) then
        raise exception 'response-loss compensation refunded a committed exam';
    end if;

    insert into public.omr_exam_mutations (
        organization_id, exam_id, mutation_id, request_hash,
        expected_revision, committed_revision, result, created_at
    )
    select 'cas-pro-org', 'cas-exam', 'old-' || sequence_number,
           md5(sequence_number::text), 1, 2,
           jsonb_build_object('status', 'saved', 'revision', 2),
           now() - interval '91 days'
      from generate_series(1, 101) sequence_number;
    insert into public.omr_exam_mutations (
        organization_id, exam_id, mutation_id, request_hash,
        expected_revision, committed_revision, result, created_at
    ) values (
        'cas-pro-org', 'cas-exam', 'recent-replay', md5('recent'), 2, 3,
        jsonb_build_object('status', 'saved', 'revision', 3), now()
    );

    perform public.omr_save_exam_v2(
        jsonb_build_object(
            'id', 'cas-exam', 'organization_id', 'cas-pro-org',
            'title', 'CAS pruned', 'created_by_user_id', 'cas-teacher',
            'created_at', now(), 'updated_at', now(), 'archived', false,
            'payload', jsonb_set(v_edited -> 'exam', '{title}', '"CAS pruned"'::jsonb)
        ),
        '[]'::jsonb, '[]'::jsonb, 'cas-teacher', 2, 'edit-prune'
    );
    select count(*)::integer into v_old_count
      from public.omr_exam_mutations mutation
     where mutation.mutation_id like 'old-%';
    select count(*)::integer into v_recent_count
      from public.omr_exam_mutations mutation
     where mutation.mutation_id in ('recent-replay', 'edit-prune');
    if v_old_count <> 1 or v_recent_count <> 2 then
        raise exception 'bounded prune removed the wrong receipts: old %, recent %', v_old_count, v_recent_count;
    end if;

    begin
        perform public.omr_save_exam_v1('{}', '[]', '[]', null);
        raise exception 'legacy blind save unexpectedly executed';
    exception when others then
        if sqlerrm <> 'exam save protocol upgrade required' then raise; end if;
    end;
end;
$$;

set role service_role;
do $$
begin
    begin
        perform public.omr_release_plan_usage(
            'cas-free-org', 'aiRecognition',
            date_trunc('month', timezone('Asia/Seoul', now()))::date,
            'ai:missing-release-probe'
        );
        raise exception 'service role executed retired caller-trusting release';
    exception
        when insufficient_privilege then null;
    end;
end;
$$;
reset role;

do $$
begin
    if pg_catalog.has_function_privilege(
        'anon',
        'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'authenticated',
        'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_exam_v2(jsonb,jsonb,jsonb,text,bigint,text)',
        'EXECUTE'
    ) or not pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_exam_v3(text,text,bigint,text,jsonb,jsonb,jsonb,bigint,text)',
        'EXECUTE'
    ) or pg_catalog.has_function_privilege(
        'service_role',
        'public.omr_save_exam_v10_snapshot(jsonb,jsonb,jsonb,text)',
        'EXECUTE'
    ) then
        raise exception 'teacher exam CAS function privileges are unsafe';
    end if;
end;
$$;
