-- Keep teacher force-finish commits O(session): the caller proves which
-- immutable session revision it prepared, while PostgreSQL grades the answers
-- and snapshot that it holds under the same deterministic row locks.
-- The legacy omr_force_finish_attempt_sessions_v1 grading envelope remains
-- available for rollback compatibility.

begin;

create or replace function public.omr_prepare_teacher_force_finish_sessions_compact_v1(
    p_organization_id text,
    p_session_ids text[],
    p_actor_user_id text,
    p_member_role text
)
returns table (
    session_id text,
    organization_id text,
    revision bigint,
    grading_fingerprint text,
    status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_expected integer;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
       or p_session_ids is null
       or pg_catalog.cardinality(p_session_ids) not between 1 and 100
       or exists (
           select 1 from pg_catalog.unnest(p_session_ids) item
            where nullif(pg_catalog.btrim(item), '') is null
       ) then
        raise exception 'invalid compact teacher force finish prepare';
    end if;
    select count(distinct pg_catalog.btrim(item))::integer
      into v_expected
      from pg_catalog.unnest(p_session_ids) item;
    if v_expected is distinct from pg_catalog.cardinality(p_session_ids) then
        raise exception 'duplicate compact teacher force finish session';
    end if;
    if (
        select count(*)
          from public.omr_attempt_sessions attempt_session
          join public.omr_exams exam
            on exam.id = attempt_session.exam_id
           and exam.organization_id = attempt_session.organization_id
          left join public.omr_assignments assignment
            on assignment.id = attempt_session.assignment_id
           and assignment.organization_id = attempt_session.organization_id
         where attempt_session.id = any(p_session_ids)
           and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
           and attempt_session.status in ('in_progress', 'submitted')
           and public.omr_teacher_attempt_read_allowed_v1(
               p_organization_id,
               p_actor_user_id,
               p_member_role,
               coalesce(assignment.class_id, exam.class_id)
           )
    ) is distinct from v_expected then
        raise exception 'attempt class assignment denied';
    end if;

    return query
    select attempt_session.id,
           attempt_session.organization_id,
           attempt_session.revision,
           public.omr_teacher_force_finish_fingerprint_v1(
               attempt_session.revision,
               attempt_session.answers,
               attempt_session.sub_question_answers,
               attempt_session.allowed_question_ids,
               attempt_session.grading_snapshot
           ),
           attempt_session.status
      from pg_catalog.unnest(p_session_ids)
           with ordinality requested(session_id, position)
      join public.omr_attempt_sessions attempt_session
        on attempt_session.id = requested.session_id
     where attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.status in ('in_progress', 'submitted')
     order by requested.position;
end;
$$;

create or replace function public.omr_force_finish_attempt_sessions_compact_v1(
    p_organization_id text,
    p_session_ids text[],
    p_finished_at timestamptz,
    p_actor_user_id text,
    p_member_role text,
    p_actor_label text,
    p_expectations jsonb
)
returns table (payload jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_session public.omr_attempt_sessions%rowtype;
    v_class_id text;
    v_exam_class_id text;
    v_expected integer;
    v_found integer;
    v_joined record;
    v_expectation jsonb;
    v_snapshot_question_ids integer[];
    v_question_result_payloads jsonb;
    v_question_result_rows jsonb;
    v_score numeric;
    v_total_score numeric;
    v_finished_at_text text;
    v_started_at_text text;
    v_attempt_payload jsonb;
    v_attempt_row jsonb;
    v_submitted_payload jsonb;
begin
    if nullif(pg_catalog.btrim(p_organization_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_user_id), '') is null
       or nullif(pg_catalog.btrim(p_actor_label), '') is null
       or p_member_role not in ('owner', 'admin', 'teacher', 'assistant')
       or p_finished_at is null
       or p_finished_at > pg_catalog.clock_timestamp() + interval '5 minutes'
       or p_session_ids is null
       or pg_catalog.cardinality(p_session_ids) not between 1 and 100
       or pg_catalog.jsonb_typeof(p_expectations) is distinct from 'array'
       or pg_catalog.pg_column_size(p_expectations) > 262144
       or exists (
           select 1
             from pg_catalog.unnest(p_session_ids) item
            where nullif(pg_catalog.btrim(item), '') is null
       ) then
        raise exception 'invalid compact teacher force finish sessions';
    end if;

    select count(distinct pg_catalog.btrim(item))::integer
      into v_expected
      from pg_catalog.unnest(p_session_ids) item;
    if v_expected is distinct from pg_catalog.cardinality(p_session_ids)
       or pg_catalog.jsonb_array_length(p_expectations) is distinct from v_expected
       or (
           select count(distinct item ->> 'session_id')
             from pg_catalog.jsonb_array_elements(p_expectations) item
       ) is distinct from v_expected
       or exists (
           select 1
             from pg_catalog.jsonb_array_elements(p_expectations) item
            where pg_catalog.jsonb_typeof(item) is distinct from 'object'
               or not ((item ->> 'session_id') = any(p_session_ids))
               or coalesce(item ->> 'expected_revision', '') !~ '^[1-9][0-9]*$'
               or (item ->> 'expected_revision')::numeric > 9007199254740991
               or coalesce(item ->> 'expected_fingerprint', '') !~ '^[a-f0-9]{64}$'
       ) then
        raise exception 'invalid compact teacher force finish expectations';
    end if;

    -- Lock in a global order before checking scope or CAS. Every batch either
    -- commits in full or rolls back, and overlapping teacher requests cannot
    -- form a lock cycle by choosing different request order.
    for v_session in
        select attempt_session.*
          from public.omr_attempt_sessions attempt_session
         where attempt_session.id = any(p_session_ids)
         order by attempt_session.id
         for update
    loop null; end loop;

    select count(*)::integer
      into v_found
      from public.omr_attempt_sessions attempt_session
     where attempt_session.id = any(p_session_ids)
       and attempt_session.organization_id = pg_catalog.btrim(p_organization_id)
       and attempt_session.status in ('in_progress', 'submitted');
    if v_found is distinct from v_expected then
        raise exception 'attempt session organization mismatch';
    end if;

    for v_class_id in
        select distinct coalesce(assignment.class_id, exam.class_id)
          from public.omr_attempt_sessions attempt_session
          join public.omr_exams exam
            on exam.id = attempt_session.exam_id
           and exam.organization_id = attempt_session.organization_id
          left join public.omr_assignments assignment
            on assignment.id = attempt_session.assignment_id
           and assignment.organization_id = attempt_session.organization_id
         where attempt_session.id = any(p_session_ids)
         order by coalesce(assignment.class_id, exam.class_id)
    loop
        if not public.omr_teacher_attempt_write_allowed_v1(
            p_organization_id,
            p_actor_user_id,
            p_member_role,
            v_class_id
        ) then
            raise exception 'attempt class assignment denied';
        end if;
    end loop;

    for v_joined in
        with expectations as materialized (
            select item ->> 'session_id' as session_id, item
              from pg_catalog.jsonb_array_elements(p_expectations) item
        ), requested as materialized (
            select requested_item.session_id, requested_item.position
              from pg_catalog.unnest(p_session_ids)
                   with ordinality requested_item(session_id, position)
        )
        select attempt_session as session_row,
               coalesce(assignment.class_id, exam.class_id) as class_id,
               exam.class_id as exam_class_id,
               expectations.item as expectation
          from requested
          join public.omr_attempt_sessions attempt_session
            on attempt_session.id = requested.session_id
          join expectations
            on expectations.session_id = attempt_session.id
          join public.omr_exams exam
            on exam.id = attempt_session.exam_id
           and exam.organization_id = attempt_session.organization_id
          left join public.omr_assignments assignment
            on assignment.id = attempt_session.assignment_id
           and assignment.organization_id = attempt_session.organization_id
         order by requested.position
    loop
        v_session := v_joined.session_row;
        v_class_id := v_joined.class_id;
        v_exam_class_id := v_joined.exam_class_id;
        v_expectation := v_joined.expectation;

        if v_session.status = 'submitted' then
            if v_session.submitted_attempt_id is distinct from v_session.attempt_id
               or not exists (
                   select 1
                     from public.omr_attempts stored
                    where stored.id = v_session.attempt_id
                      and stored.organization_id = v_session.organization_id
                      and stored.status = 'completed'
               ) then
                raise exception 'submitted attempt session is incomplete';
            end if;
            continue;
        end if;
        if p_finished_at < v_session.started_at then
            raise exception 'finish time precedes attempt session start';
        end if;
        if v_session.revision is distinct from (v_expectation ->> 'expected_revision')::bigint
           or public.omr_teacher_force_finish_fingerprint_v1(
               v_session.revision,
               v_session.answers,
               v_session.sub_question_answers,
               v_session.allowed_question_ids,
               v_session.grading_snapshot
           ) is distinct from v_expectation ->> 'expected_fingerprint' then
            raise exception 'stale attempt session grading';
        end if;

        if pg_catalog.jsonb_typeof(v_session.grading_snapshot) is distinct from 'object'
           or pg_catalog.jsonb_typeof(v_session.grading_snapshot -> 'questions') is distinct from 'array'
           or v_session.grading_snapshot ->> 'id' is distinct from v_session.exam_id
           or v_session.grading_snapshot ->> 'organizationId' is distinct from v_session.organization_id
           or nullif(pg_catalog.btrim(v_session.grading_snapshot ->> 'title'), '') is null
           or (
               v_exam_class_id is not null
               and v_session.grading_snapshot ->> 'classId' is distinct from v_exam_class_id
           )
           or pg_catalog.cardinality(v_session.allowed_question_ids) not between 1 and 500
           or pg_catalog.jsonb_typeof(v_session.answers) is distinct from 'object'
           or pg_catalog.jsonb_typeof(v_session.sub_question_answers) is distinct from 'object'
           or exists (
               select 1
                 from pg_catalog.jsonb_array_elements(v_session.grading_snapshot -> 'questions') question
                where pg_catalog.jsonb_typeof(question) is distinct from 'object'
                   or coalesce(question ->> 'id', '') !~ '^[1-9][0-9]*$'
                   or (question ->> 'id')::numeric > 2147483647
                   or (
                       question ? 'number'
                       and coalesce(question ->> 'number', '') !~ '^[1-9][0-9]*$'
                   )
                   or (
                       question ? 'choices'
                       and coalesce(question ->> 'choices', '') not in ('4', '5')
                   )
                   or (
                       question ? 'answer'
                       and question -> 'answer' <> 'null'::jsonb
                       and (
                           pg_catalog.jsonb_typeof(question -> 'answer') is distinct from 'number'
                           or (question ->> 'answer')::numeric <> pg_catalog.trunc((question ->> 'answer')::numeric)
                           or (question ->> 'answer')::numeric < 1
                           or (question ->> 'answer')::numeric > case
                               when question ->> 'choices' = '4' then 4 else 5 end
                       )
                   )
                   or (
                       question ? 'score'
                       and question -> 'score' <> 'null'::jsonb
                       and pg_catalog.jsonb_typeof(question -> 'score') is distinct from 'number'
                   )
           ) then
            raise exception 'invalid locked grading snapshot';
        end if;

        select pg_catalog.array_agg((question ->> 'id')::integer order by (question ->> 'id')::integer)
          into v_snapshot_question_ids
          from pg_catalog.jsonb_array_elements(v_session.grading_snapshot -> 'questions') question
         where (question ->> 'id')::integer = any(v_session.allowed_question_ids);
        if v_snapshot_question_ids is distinct from v_session.allowed_question_ids then
            raise exception 'locked grading question scope mismatch';
        end if;

        if exists (
            select 1
              from pg_catalog.jsonb_each(v_session.answers) answer
              left join lateral (
                  select question
                    from pg_catalog.jsonb_array_elements(v_session.grading_snapshot -> 'questions') question
                   where question ->> 'id' = answer.key
                   limit 1
              ) canonical on true
             where answer.key !~ '^[1-9][0-9]*$'
                or answer.key::numeric > 2147483647
                or not (answer.key::integer = any(v_session.allowed_question_ids))
                or canonical.question is null
                or pg_catalog.jsonb_typeof(answer.value) is distinct from 'number'
                or (answer.value #>> '{}')::numeric <> pg_catalog.trunc((answer.value #>> '{}')::numeric)
                or (answer.value #>> '{}')::numeric < 1
                or (answer.value #>> '{}')::numeric > case
                    when canonical.question ->> 'choices' = '4' then 4 else 5 end
        ) then
            raise exception 'invalid locked grading answers';
        end if;

        v_finished_at_text := pg_catalog.to_char(
            p_finished_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );
        v_started_at_text := pg_catalog.to_char(
            v_session.started_at at time zone 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        );

        -- Both the embedded questionResults and normalized result rows are
        -- projected from this one materialized relation. Score/status/weight
        -- therefore cannot drift between the attempt and analytics tables.
        with canonical_questions as materialized (
            select source.position,
                   source.question,
                   (source.question ->> 'id')::integer as question_id,
                   coalesce((source.question ->> 'number')::integer,
                            (source.question ->> 'id')::integer) as question_number,
                   case
                       when source.question ? 'answer'
                        and source.question -> 'answer' <> 'null'::jsonb
                       then (source.question ->> 'answer')::integer
                       else null
                   end as correct_answer,
                   case
                       when pg_catalog.jsonb_typeof(source.question -> 'score') = 'number'
                        and (source.question ->> 'score')::numeric > 0
                       then (source.question ->> 'score')::numeric
                       else 100.0 / pg_catalog.cardinality(v_session.allowed_question_ids)
                   end as weight
              from pg_catalog.jsonb_array_elements(v_session.grading_snapshot -> 'questions')
                   with ordinality source(question, position)
             where (source.question ->> 'id')::integer = any(v_session.allowed_question_ids)
        ), grading_rows as materialized (
            select canonical_questions.*,
                   case
                       when v_session.answers ? question_id::text
                       then (v_session.answers ->> question_id::text)::integer
                       else null
                   end as selected_answer,
                   case
                       when correct_answer is null then 'ungraded'
                       when not (v_session.answers ? question_id::text) then 'unanswered'
                       when (v_session.answers ->> question_id::text)::integer = correct_answer then 'correct'
                       else 'wrong'
                   end as result_status
              from canonical_questions
        ), canonical_results as materialized (
            select grading_rows.position,
                   grading_rows.correct_answer,
                   grading_rows.weight,
                   grading_rows.result_status,
                   pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                       'schemaVersion', 1,
                       'attemptId', v_session.attempt_id,
                       'examId', v_session.exam_id,
                       'examTitle', v_session.grading_snapshot ->> 'title',
                       'organizationId', v_session.organization_id,
                       'classId', v_class_id,
                       'assignmentId', v_session.assignment_id,
                       'studentProfileId', case when v_session.identity_type = 'guest'
                           then null else v_session.owner_student_id end,
                       'studentName', v_session.student_name,
                       'studentId', v_session.owner_student_id,
                       'groupId', v_class_id,
                       'identityType', v_session.identity_type,
                       'questionId', grading_rows.question_id,
                       'questionNumber', grading_rows.question_number,
                       'canonicalQuestionId', v_session.exam_id || ':' || grading_rows.question_id::text,
                       'label', grading_rows.question ->> 'label',
                       'score', pg_catalog.round(grading_rows.weight, 2),
                       'earnedScore', case when grading_rows.result_status = 'correct'
                           then pg_catalog.round(grading_rows.weight, 2) else 0 end,
                       'selectedAnswer', grading_rows.selected_answer,
                       'correctAnswer', grading_rows.correct_answer,
                       'status', grading_rows.result_status,
                       'isCorrect', grading_rows.result_status = 'correct',
                       'isWrong', grading_rows.result_status = 'wrong',
                       'isUnanswered', grading_rows.result_status = 'unanswered',
                       'subject', grading_rows.question #>> '{tags,subject}',
                       'unit', grading_rows.question #>> '{tags,unit}',
                       'concept', grading_rows.question #>> '{tags,concept}',
                       'skill', grading_rows.question #>> '{tags,skill}',
                       'source', grading_rows.question #>> '{tags,source}',
                       'difficulty', grading_rows.question #>> '{tags,difficulty}',
                       'cognitiveLevel', grading_rows.question #>> '{tags,cognitiveLevel}',
                       'mistakeTypes', case
                           when pg_catalog.jsonb_typeof(grading_rows.question #> '{tags,mistakeTypes}') = 'array'
                           then grading_rows.question #> '{tags,mistakeTypes}' else null end,
                       'prerequisites', case
                           when pg_catalog.jsonb_typeof(grading_rows.question #> '{tags,prerequisites}') = 'array'
                           then grading_rows.question #> '{tags,prerequisites}' else null end,
                       'expectedTimeSec', grading_rows.question #> '{tags,expectedTimeSec}',
                       'pdfPage', coalesce(
                           grading_rows.question #> '{pdfRegion,page}',
                           grading_rows.question #> '{pdfLocation,page}'
                       ),
                       'pdfLocation', grading_rows.question -> 'pdfLocation',
                       'pdfRegion', grading_rows.question -> 'pdfRegion',
                       'passagePdfRegions', grading_rows.question -> 'passagePdfRegions',
                       'retakeSourceAttemptId', v_session.retake_source_attempt_id,
                       'retakeMode', v_session.retake_mode,
                       'finishedAt', v_finished_at_text
                   )) as result_payload,
                   pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                       'id', v_session.attempt_id || ':' || grading_rows.question_id::text,
                       'organization_id', v_session.organization_id,
                       'class_id', v_class_id,
                       'assignment_id', v_session.assignment_id,
                       'student_profile_id', case when v_session.identity_type = 'guest'
                           then null else v_session.owner_student_id end,
                       'attempt_id', v_session.attempt_id,
                       'exam_id', v_session.exam_id,
                       'student_name', v_session.student_name,
                       'student_id', v_session.owner_student_id,
                       'group_id', v_class_id,
                       'identity_type', v_session.identity_type,
                       'question_id', grading_rows.question_id,
                       'question_number', grading_rows.question_number,
                       'canonical_question_id', v_session.exam_id || ':' || grading_rows.question_id::text,
                       'label', grading_rows.question ->> 'label',
                       'subject', grading_rows.question #>> '{tags,subject}',
                       'unit', grading_rows.question #>> '{tags,unit}',
                       'concept', grading_rows.question #>> '{tags,concept}',
                       'skill', grading_rows.question #>> '{tags,skill}',
                       'source', grading_rows.question #>> '{tags,source}',
                       'difficulty', grading_rows.question #>> '{tags,difficulty}',
                       'cognitive_level', grading_rows.question #>> '{tags,cognitiveLevel}',
                       'mistake_types', case
                           when pg_catalog.jsonb_typeof(grading_rows.question #> '{tags,mistakeTypes}') = 'array'
                           then grading_rows.question #> '{tags,mistakeTypes}' else '[]'::jsonb end,
                       'prerequisites', case
                           when pg_catalog.jsonb_typeof(grading_rows.question #> '{tags,prerequisites}') = 'array'
                           then grading_rows.question #> '{tags,prerequisites}' else '[]'::jsonb end,
                       'expected_time_sec', grading_rows.question #> '{tags,expectedTimeSec}',
                       'selected_answer', grading_rows.selected_answer,
                       'correct_answer', grading_rows.correct_answer,
                       'status', grading_rows.result_status,
                       'is_correct', grading_rows.result_status = 'correct',
                       'is_wrong', grading_rows.result_status = 'wrong',
                       'is_unanswered', grading_rows.result_status = 'unanswered',
                       'score', pg_catalog.round(grading_rows.weight, 2),
                       'earned_score', case when grading_rows.result_status = 'correct'
                           then pg_catalog.round(grading_rows.weight, 2) else 0 end,
                       'pdf_page', coalesce(
                           grading_rows.question #> '{pdfRegion,page}',
                           grading_rows.question #> '{pdfLocation,page}'
                       ),
                       'pdf_location', grading_rows.question -> 'pdfLocation',
                       'pdf_region', grading_rows.question -> 'pdfRegion',
                       'retake_source_attempt_id', v_session.retake_source_attempt_id,
                       'retake_mode', v_session.retake_mode,
                       'finished_at', v_finished_at_text,
                       'payload', pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                           'schemaVersion', 1,
                           'attemptId', v_session.attempt_id,
                           'examId', v_session.exam_id,
                           'examTitle', v_session.grading_snapshot ->> 'title',
                           'organizationId', v_session.organization_id,
                           'classId', v_class_id,
                           'assignmentId', v_session.assignment_id,
                           'studentProfileId', case when v_session.identity_type = 'guest'
                               then null else v_session.owner_student_id end,
                           'studentName', v_session.student_name,
                           'studentId', v_session.owner_student_id,
                           'groupId', v_class_id,
                           'identityType', v_session.identity_type,
                           'questionId', grading_rows.question_id,
                           'questionNumber', grading_rows.question_number,
                           'canonicalQuestionId', v_session.exam_id || ':' || grading_rows.question_id::text,
                           'label', grading_rows.question ->> 'label',
                           'score', pg_catalog.round(grading_rows.weight, 2),
                           'earnedScore', case when grading_rows.result_status = 'correct'
                               then pg_catalog.round(grading_rows.weight, 2) else 0 end,
                           'selectedAnswer', grading_rows.selected_answer,
                           'correctAnswer', grading_rows.correct_answer,
                           'status', grading_rows.result_status,
                           'isCorrect', grading_rows.result_status = 'correct',
                           'isWrong', grading_rows.result_status = 'wrong',
                           'isUnanswered', grading_rows.result_status = 'unanswered',
                           'subject', grading_rows.question #>> '{tags,subject}',
                           'unit', grading_rows.question #>> '{tags,unit}',
                           'concept', grading_rows.question #>> '{tags,concept}',
                           'skill', grading_rows.question #>> '{tags,skill}',
                           'source', grading_rows.question #>> '{tags,source}',
                           'difficulty', grading_rows.question #>> '{tags,difficulty}',
                           'cognitiveLevel', grading_rows.question #>> '{tags,cognitiveLevel}',
                           'mistakeTypes', case
                               when pg_catalog.jsonb_typeof(grading_rows.question #> '{tags,mistakeTypes}') = 'array'
                               then grading_rows.question #> '{tags,mistakeTypes}' else null end,
                           'prerequisites', case
                               when pg_catalog.jsonb_typeof(grading_rows.question #> '{tags,prerequisites}') = 'array'
                               then grading_rows.question #> '{tags,prerequisites}' else null end,
                           'expectedTimeSec', grading_rows.question #> '{tags,expectedTimeSec}',
                           'pdfPage', coalesce(
                               grading_rows.question #> '{pdfRegion,page}',
                               grading_rows.question #> '{pdfLocation,page}'
                           ),
                           'pdfLocation', grading_rows.question -> 'pdfLocation',
                           'pdfRegion', grading_rows.question -> 'pdfRegion',
                           'passagePdfRegions', grading_rows.question -> 'passagePdfRegions',
                           'retakeSourceAttemptId', v_session.retake_source_attempt_id,
                           'retakeMode', v_session.retake_mode,
                           'finishedAt', v_finished_at_text
                       )),
                       'created_at', v_finished_at_text,
                       'updated_at', v_finished_at_text
                   )) as result_row
              from grading_rows
        )
        select pg_catalog.jsonb_agg(result_payload order by position),
               pg_catalog.jsonb_agg(result_row order by position),
               pg_catalog.round(coalesce(pg_catalog.sum(weight)
                   filter (where result_status = 'correct'), 0), 2),
               pg_catalog.round(coalesce(pg_catalog.sum(weight)
                   filter (where correct_answer is not null), 0), 2)
          into v_question_result_payloads, v_question_result_rows, v_score, v_total_score
          from canonical_results;

        if pg_catalog.jsonb_array_length(v_question_result_payloads)
             is distinct from pg_catalog.cardinality(v_session.allowed_question_ids)
           or pg_catalog.jsonb_array_length(v_question_result_rows)
             is distinct from pg_catalog.cardinality(v_session.allowed_question_ids) then
            raise exception 'canonical compact grading result mismatch';
        end if;

        v_attempt_payload := pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
            'id', v_session.attempt_id,
            'examId', v_session.exam_id,
            'examTitle', v_session.grading_snapshot ->> 'title',
            'organizationId', v_session.organization_id,
            'classId', v_class_id,
            'assignmentId', v_session.assignment_id,
            'studentProfileId', case when v_session.identity_type = 'registered'
                then v_session.owner_student_id else null end,
            'studentName', v_session.student_name,
            'studentId', v_session.owner_student_id,
            'groupId', v_class_id,
            'identityType', v_session.identity_type,
            'startedAt', v_started_at_text,
            'finishedAt', v_finished_at_text,
            'score', v_score,
            'totalScore', v_total_score,
            'answers', v_session.answers,
            'subQuestionAnswers', v_session.sub_question_answers,
            'status', 'completed',
            'autoSubmitted', true,
            'retake', case when v_session.retake_source_attempt_id is null then null
                else pg_catalog.jsonb_build_object(
                    'sourceAttemptId', v_session.retake_source_attempt_id,
                    'questionIds', pg_catalog.to_jsonb(v_session.allowed_question_ids),
                    'mode', v_session.retake_mode,
                    'createdAt', v_started_at_text
                ) end,
            'questionResults', v_question_result_payloads
        ));

        v_attempt_row := pg_catalog.jsonb_build_object(
            'id', v_session.attempt_id,
            'ticket_id', v_session.submission_id,
            'organization_id', v_session.organization_id,
            'class_id', v_class_id,
            'assignment_id', v_session.assignment_id,
            'student_profile_id', case when v_session.identity_type = 'guest'
                then null else v_session.owner_student_id end,
            'exam_id', v_session.exam_id,
            'student_name', v_session.student_name,
            'student_id', v_session.owner_student_id,
            'group_id', v_class_id,
            'identity_type', v_session.identity_type,
            'status', 'completed',
            'score', v_score,
            'total_score', v_total_score,
            'score_percent', case when v_total_score > 0
                then pg_catalog.round((v_score / v_total_score) * 100) else 0 end,
            'retake_source_attempt_id', v_session.retake_source_attempt_id,
            'retake_mode', v_session.retake_mode,
            'retake_question_ids', case when v_session.retake_source_attempt_id is null
                then '[]'::jsonb else pg_catalog.to_jsonb(v_session.allowed_question_ids) end,
            'payload', v_attempt_payload,
            'started_at', v_started_at_text,
            'finished_at', v_finished_at_text
        );

        select submitted.payload
          into v_submitted_payload
          from public.omr_submit_session_attempt_v1(
              v_attempt_row,
              v_question_result_rows
          ) submitted;
        if v_submitted_payload is null
           or v_submitted_payload ->> 'id' is distinct from v_session.attempt_id
           or v_submitted_payload ->> 'organizationId' is distinct from v_session.organization_id
           or v_submitted_payload ->> 'examId' is distinct from v_session.exam_id
           or v_submitted_payload ->> 'studentId' is distinct from v_session.owner_student_id
           or v_submitted_payload ->> 'status' is distinct from 'completed' then
            raise exception 'canonical compact force finish submission failed';
        end if;

        update public.omr_attempt_sessions
           set status = 'submitted',
               submitted_attempt_id = v_session.attempt_id,
               submitted_at = pg_catalog.clock_timestamp(),
               updated_at = pg_catalog.clock_timestamp()
         where id = v_session.id;
    end loop;

    return query
    select stored.payload
      from pg_catalog.unnest(p_session_ids)
           with ordinality requested(session_id, position)
      join public.omr_attempt_sessions attempt_session
        on attempt_session.id = requested.session_id
      join public.omr_attempts stored
        on stored.id = attempt_session.submitted_attempt_id
     order by requested.position;
end;
$$;

comment on function public.omr_force_finish_attempt_sessions_compact_v1(
    text,text[],timestamptz,text,text,text,jsonb
) is 'teacher-live-session-force-finish-compact:202608060024';

comment on function public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)
    is 'teacher-live-session-force-finish-compact-prepare:202608060024';

revoke all on function public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)
    from public, anon, authenticated;
grant execute on function public.omr_prepare_teacher_force_finish_sessions_compact_v1(text,text[],text,text)
    to service_role;

revoke all on function public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_force_finish_attempt_sessions_compact_v1(text,text[],timestamptz,text,text,text,jsonb)
    to service_role;

commit;
