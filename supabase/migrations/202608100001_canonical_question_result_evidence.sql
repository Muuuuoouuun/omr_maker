begin;

set local lock_timeout = '2s';
set local statement_timeout = '120s';

-- Runtime writers lock the durable session before inserting/updating the
-- parent attempt, which then materializes question-result children. Take the
-- cutover locks in that same global order so neither side can form a cycle.
lock table public.omr_attempt_sessions in access exclusive mode;
lock table public.omr_attempts in access exclusive mode;
lock table public.omr_question_results in access exclusive mode;

do $$
begin
    if pg_catalog.to_regprocedure('extensions.digest(text,text)') is null then
        raise exception 'canonical question-result evidence requires pgcrypto digest';
    end if;
end $$;

alter table public.omr_attempts
    add column if not exists question_results_question_count integer,
    add column if not exists question_results_definition_manifest_hash text,
    add column if not exists question_results_full_evidence_hash text;

alter table public.omr_question_results
    add column if not exists assignment_revision bigint;

alter table public.omr_attempts
    drop constraint if exists omr_attempts_question_result_evidence_shape;
alter table public.omr_attempts
    add constraint omr_attempts_question_result_evidence_shape check (
        (
            question_results_question_count is null
            and question_results_definition_manifest_hash is null
            and question_results_full_evidence_hash is null
        ) or (
            question_results_question_count between 1 and 500
            and question_results_definition_manifest_hash ~ '^sha256:[a-f0-9]{64}$'
            and question_results_full_evidence_hash ~ '^sha256:[a-f0-9]{64}$'
        )
    );

alter table public.omr_question_results
    drop constraint if exists omr_question_results_assignment_revision_positive;
alter table public.omr_question_results
    add constraint omr_question_results_assignment_revision_positive check (
        assignment_revision is null or assignment_revision > 0
    );

create or replace function public.omr_assert_canonical_question_result_json_v1(
    p_value jsonb,
    p_depth integer default 0
)
returns void
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
    v_child jsonb;
    v_type text := pg_catalog.jsonb_typeof(p_value);
begin
    if p_depth > 5 then
        raise exception 'canonical json depth exceeds 5';
    end if;
    if v_type = 'array' then
        if pg_catalog.jsonb_array_length(p_value) > 500 then
            raise exception 'canonical json array exceeds 500';
        end if;
        for v_child in select item.value from pg_catalog.jsonb_array_elements(p_value) item(value) loop
            perform public.omr_assert_canonical_question_result_json_v1(v_child,p_depth+1);
        end loop;
    elsif v_type = 'object' then
        for v_child in select item.value from pg_catalog.jsonb_each(p_value) item(key,value) loop
            perform public.omr_assert_canonical_question_result_json_v1(v_child,p_depth+1);
        end loop;
    end if;
end;
$$;

revoke all on function public.omr_assert_canonical_question_result_json_v1(jsonb,integer)
    from public, anon, authenticated;
grant execute on function public.omr_assert_canonical_question_result_json_v1(jsonb,integer) to service_role;

create or replace function public.omr_canonical_json_text_v1(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
    v_type text := pg_catalog.jsonb_typeof(p_value);
    v_result text;
    v_number numeric;
    v_micro_units numeric;
begin
    if v_type = 'null' then return 'null'; end if;
    if v_type = 'string' then return pg_catalog.to_jsonb(p_value #>> '{}')::text; end if;
    if v_type = 'boolean' then return p_value::text; end if;
    if v_type = 'number' then
        -- Cross-runtime numbers use one exact representation regardless of
        -- JSON decimal/exponent spelling: a tagged signed integer at 1e-6.
        v_number := (p_value #>> '{}')::numeric;
        if pg_catalog.abs(v_number) > 9000000000 then
            raise exception 'canonical number exceeds micro6 range';
        end if;
        if pg_catalog.round(v_number, 6) is distinct from v_number then
            raise exception 'canonical number exceeds micro6 precision';
        end if;
        v_micro_units := v_number * 1000000;
        return '["omr:canonical-number:micro6:v1",'
            || pg_catalog.to_jsonb(pg_catalog.trunc(v_micro_units)::text)::text || ']';
    end if;
    if v_type = 'array' then
        select '[' || coalesce(pg_catalog.string_agg(
            public.omr_canonical_json_text_v1(item.value), ',' order by item.ordinality
        ), '') || ']'
          into v_result
          from pg_catalog.jsonb_array_elements(p_value) with ordinality item(value, ordinality);
        return v_result;
    end if;
    if v_type = 'object' then
        select '{' || coalesce(pg_catalog.string_agg(
            pg_catalog.to_jsonb(item.key)::text || ':' || public.omr_canonical_json_text_v1(item.value),
            ',' order by item.key
        ), '') || '}'
          into v_result
          from pg_catalog.jsonb_each(p_value) item(key, value);
        return v_result;
    end if;
    raise exception 'unsupported canonical json type';
end;
$$;

revoke all on function public.omr_canonical_json_text_v1(jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_canonical_json_text_v1(jsonb) to service_role;

create or replace function public.omr_compute_canonical_question_result_evidence_v1(
    p_attempt jsonb,
    p_question_results jsonb
)
returns table(
    question_count integer,
    definition_manifest_hash text,
    full_evidence_hash text
)
language plpgsql
immutable
strict
set search_path = ''
as $$
declare
    v_rows jsonb := p_question_results;
    v_definitions jsonb;
    v_evidence_rows jsonb;
    v_scope jsonb;
begin
    if pg_catalog.jsonb_typeof(p_attempt) <> 'object'
       or pg_catalog.jsonb_typeof(v_rows) <> 'array'
       or pg_catalog.jsonb_array_length(v_rows) = 0
       or pg_catalog.jsonb_array_length(v_rows) > 500 then
        raise exception 'invalid canonical question-result evidence root';
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(v_rows) row(value)
         where pg_catalog.jsonb_typeof(row.value) <> 'object'
            or not (row.value ->> 'questionId' ~ '^[1-9][0-9]*$')
            or not (row.value ->> 'questionNumber' ~ '^[1-9][0-9]*$')
            or pg_catalog.jsonb_typeof(row.value -> 'score') <> 'number'
            or (row.value ->> 'score')::numeric < 0
            or (
                row.value ->> 'status' <> 'ungraded'
                and not coalesce(row.value ->> 'correctAnswer' ~ '^[1-9][0-9]*$', false)
            )
    ) then raise exception 'invalid canonical question-result row'; end if;
    if (
        select pg_catalog.count(distinct (row.value ->> 'questionId')::bigint)
          from pg_catalog.jsonb_array_elements(v_rows) row(value)
    ) <> pg_catalog.jsonb_array_length(v_rows) then
        raise exception 'duplicate canonical question-result question id';
    end if;

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               (row.value ->> 'questionId')::bigint,
               (row.value ->> 'questionNumber')::bigint,
               row.value -> 'score',
               coalesce(row.value -> 'correctAnswer', 'null'::jsonb)
           ) order by (row.value ->> 'questionId')::bigint)
      into v_definitions
      from pg_catalog.jsonb_array_elements(v_rows) row(value);

    select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
               row.value -> 'schemaVersion', row.value -> 'attemptId', row.value -> 'examId',
               row.value -> 'examTitle', row.value -> 'organizationId', row.value -> 'classId',
               row.value -> 'assignmentId', row.value -> 'assignmentRevision',
               row.value -> 'studentProfileId', row.value -> 'studentName', row.value -> 'studentId',
               row.value -> 'groupId', row.value -> 'groupName', row.value -> 'regionId',
               row.value -> 'regionName', row.value -> 'identityType', row.value -> 'questionId',
               row.value -> 'questionNumber', row.value -> 'canonicalQuestionId', row.value -> 'label',
               row.value -> 'score', row.value -> 'earnedScore', row.value -> 'selectedAnswer',
               row.value -> 'correctAnswer', row.value -> 'status', row.value -> 'isCorrect',
               row.value -> 'isWrong', row.value -> 'isUnanswered', row.value -> 'subject',
               row.value -> 'unit', row.value -> 'concept', row.value -> 'skill', row.value -> 'source',
               row.value -> 'difficulty', row.value -> 'cognitiveLevel', row.value -> 'mistakeTypes',
               row.value -> 'prerequisites', row.value -> 'expectedTimeSec', row.value -> 'pdfPage',
               row.value -> 'pdfLocation', row.value -> 'pdfRegion', row.value -> 'passagePdfRegions',
               row.value -> 'timeSec', row.value -> 'visitCount', row.value -> 'revisitCount',
               row.value -> 'answerChangeCount', row.value -> 'handwritingStrokeCount',
               row.value -> 'handwritingPage', row.value -> 'retakeSourceAttemptId',
               row.value -> 'retakeMode', row.value -> 'answeredAt', row.value -> 'finishedAt'
           ) order by (row.value ->> 'questionId')::bigint)
      into v_evidence_rows
      from pg_catalog.jsonb_array_elements(v_rows) row(value);

    v_scope := pg_catalog.jsonb_build_array(
        p_attempt -> 'id', p_attempt -> 'examId', p_attempt -> 'organizationId', p_attempt -> 'classId',
        p_attempt -> 'assignmentId', p_attempt -> 'assignmentRevision', p_attempt -> 'studentProfileId',
        p_attempt -> 'studentId', p_attempt -> 'identityType', p_attempt -> 'studentName',
        p_attempt -> 'groupId', p_attempt -> 'groupName', p_attempt -> 'regionId', p_attempt -> 'regionName',
        p_attempt -> 'startedAt', p_attempt -> 'finishedAt', p_attempt -> 'score', p_attempt -> 'totalScore',
        p_attempt -> 'status', p_attempt -> 'retake'
    );

    perform public.omr_assert_canonical_question_result_json_v1(v_definitions,0);
    perform public.omr_assert_canonical_question_result_json_v1(
        pg_catalog.jsonb_build_array(v_scope,v_evidence_rows),0
    );

    question_count := pg_catalog.jsonb_array_length(v_rows);
    definition_manifest_hash := 'sha256:' || pg_catalog.encode(extensions.digest(
        'omr:canonical-question-definition-manifest:v1' || chr(10)
        || public.omr_canonical_json_text_v1(v_definitions), 'sha256'
    ), 'hex');
    full_evidence_hash := 'sha256:' || pg_catalog.encode(extensions.digest(
        'omr:canonical-question-result-evidence:v1' || chr(10)
        || public.omr_canonical_json_text_v1(pg_catalog.jsonb_build_array(v_scope, v_evidence_rows)),
        'sha256'
    ), 'hex');
    return next;
end;
$$;

revoke all on function public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb)
    from public, anon, authenticated;
grant execute on function public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb) to service_role;

-- Task 6's compact writer predates the generation field in the embedded
-- payload. The existing assignment guard runs first and derives the scalar
-- revision from the locked durable session; this second insert guard copies
-- that exact value into the immutable attempt and result evidence before the
-- canonical digest trigger runs.
create or replace function public.omr_bind_attempt_evidence_generation_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_rows jsonb;
begin
    if new.assignment_id is null then return new; end if;
    if new.assignment_revision is null or new.assignment_revision <= 0 then
        raise exception 'attempt evidence assignment generation missing';
    end if;
    if new.payload ->> 'assignmentId' is distinct from new.assignment_id
       or (
           new.payload ? 'assignmentRevision'
           and new.payload ->> 'assignmentRevision' is distinct from new.assignment_revision::text
       ) then raise exception 'attempt evidence assignment generation mismatch'; end if;
    new.payload := pg_catalog.jsonb_set(
        new.payload,'{assignmentRevision}',pg_catalog.to_jsonb(new.assignment_revision),true
    );
    if pg_catalog.jsonb_typeof(new.payload -> 'questionResults') = 'array' then
        if exists (
            select 1 from pg_catalog.jsonb_array_elements(new.payload -> 'questionResults') result(value)
             where result.value ->> 'assignmentId' is distinct from new.assignment_id
                or (
                    result.value ? 'assignmentRevision'
                    and result.value ->> 'assignmentRevision' is distinct from new.assignment_revision::text
                )
        ) then raise exception 'attempt result evidence assignment generation mismatch'; end if;
        select pg_catalog.jsonb_agg(
                   result.value || pg_catalog.jsonb_build_object(
                       'assignmentRevision',new.assignment_revision
                   ) order by result.ordinality
               ) into v_rows
          from pg_catalog.jsonb_array_elements(new.payload -> 'questionResults')
               with ordinality result(value,ordinality);
        new.payload := pg_catalog.jsonb_set(new.payload,'{questionResults}',v_rows,false);
    end if;
    return new;
end;
$$;

revoke all on function public.omr_bind_attempt_evidence_generation_v1()
    from public,anon,authenticated,service_role;
drop trigger if exists omr_attempts_assignment_revision_payload_guard on public.omr_attempts;
create trigger omr_attempts_assignment_revision_payload_guard
before insert on public.omr_attempts
for each row execute function public.omr_bind_attempt_evidence_generation_v1();

create or replace function public.omr_guard_canonical_question_result_evidence_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_rows jsonb := new.payload -> 'questionResults';
    v_computed record;
    v_any_input boolean := new.question_results_question_count is not null
        or new.question_results_definition_manifest_hash is not null
        or new.question_results_full_evidence_hash is not null
        or nullif(new.payload ->> 'questionResultsQuestionCount','') is not null
        or nullif(new.payload ->> 'questionResultsDefinitionManifestHash','') is not null
        or nullif(new.payload ->> 'questionResultsFullEvidenceHash','') is not null;
begin
    if tg_op = 'UPDATE' and old.question_results_question_count is not null then
        if new.question_results_question_count is distinct from old.question_results_question_count
           or new.question_results_definition_manifest_hash is distinct from old.question_results_definition_manifest_hash
           or new.question_results_full_evidence_hash is distinct from old.question_results_full_evidence_hash then
            raise exception 'canonical question-result evidence is immutable';
        end if;
    elsif tg_op = 'UPDATE' and old.status = 'completed' and v_any_input then
        raise exception 'legacy completed evidence cannot be adopted as canonical';
    end if;

    if new.status <> 'completed' or pg_catalog.jsonb_typeof(v_rows) <> 'array' then
        if v_any_input then raise exception 'non-completed attempt cannot carry canonical evidence'; end if;
        return new;
    end if;
    if pg_catalog.jsonb_array_length(v_rows) = 0 or pg_catalog.jsonb_array_length(v_rows) > 500 then
        if v_any_input then raise exception 'invalid canonical question-result count'; end if;
        return new;
    end if;
    if exists (
        select 1 from pg_catalog.jsonb_array_elements(v_rows) row(value)
         where row.value ->> 'status' <> 'ungraded'
           and not coalesce(row.value ->> 'correctAnswer' ~ '^[1-9][0-9]*$', false)
    ) then
        if v_any_input then raise exception 'canonical evidence requires immutable answer keys'; end if;
        return new;
    end if;

    select * into v_computed
      from public.omr_compute_canonical_question_result_evidence_v1(new.payload, v_rows);
    if v_any_input and (
        coalesce(new.question_results_question_count, (new.payload ->> 'questionResultsQuestionCount')::integer)
            is distinct from v_computed.question_count
        or coalesce(new.question_results_definition_manifest_hash, new.payload ->> 'questionResultsDefinitionManifestHash')
            is distinct from v_computed.definition_manifest_hash
        or coalesce(new.question_results_full_evidence_hash, new.payload ->> 'questionResultsFullEvidenceHash')
            is distinct from v_computed.full_evidence_hash
    ) then raise exception 'canonical question-result evidence mismatch'; end if;

    new.question_results_question_count := v_computed.question_count;
    new.question_results_definition_manifest_hash := v_computed.definition_manifest_hash;
    new.question_results_full_evidence_hash := v_computed.full_evidence_hash;
    new.payload := new.payload || pg_catalog.jsonb_build_object(
        'questionResultsQuestionCount', v_computed.question_count,
        'questionResultsDefinitionManifestHash', v_computed.definition_manifest_hash,
        'questionResultsFullEvidenceHash', v_computed.full_evidence_hash
    );
    return new;
end;
$$;

revoke all on function public.omr_guard_canonical_question_result_evidence_v1()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_attempts_canonical_question_result_evidence_guard on public.omr_attempts;
create trigger omr_attempts_canonical_question_result_evidence_guard
before insert or update of status,payload,question_results_question_count,
    question_results_definition_manifest_hash,question_results_full_evidence_hash
on public.omr_attempts
for each row execute function public.omr_guard_canonical_question_result_evidence_v1();

create or replace function public.omr_question_result_assignment_generation_guard_v2()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_parent record;
begin
    if tg_op = 'UPDATE' and old.assignment_id is null and new.assignment_id is not null then
        -- The legacy retake writer still issues an adoption UPDATE, but Task 6
        -- deliberately keeps that completed source in its historical scope.
        -- Returning OLD makes the obsolete write a no-op without weakening the
        -- immutable generation pair for any canonical child row.
        return old;
    end if;
    if tg_op = 'UPDATE' and (
        new.assignment_id is distinct from old.assignment_id
        or new.assignment_revision is distinct from old.assignment_revision
    ) then raise exception 'question-result assignment generation is immutable'; end if;
    if tg_op = 'INSERT' then
        select attempt.assignment_id,attempt.assignment_revision
          into v_parent from public.omr_attempts attempt
         where attempt.id=new.attempt_id for share;
        if not found
           or v_parent.assignment_id is distinct from new.assignment_id then
            raise exception 'question-result parent assignment generation mismatch';
        end if;
        if v_parent.assignment_id is not null and new.assignment_revision is null then
            new.assignment_revision := v_parent.assignment_revision;
        end if;
        if v_parent.assignment_revision is distinct from new.assignment_revision
           or (new.assignment_id is null) <> (new.assignment_revision is null)
           or (new.assignment_revision is not null and new.assignment_revision <= 0) then
            raise exception 'question-result assignment generation pair required';
        end if;
        if new.assignment_id is not null then
            if pg_catalog.jsonb_typeof(new.payload) <> 'object'
               or new.payload ->> 'assignmentId' is distinct from new.assignment_id
               or (
                   new.payload ? 'assignmentRevision'
                   and new.payload ->> 'assignmentRevision' is distinct from new.assignment_revision::text
               ) then raise exception 'question-result payload assignment generation mismatch'; end if;
            new.payload := new.payload || pg_catalog.jsonb_build_object(
                'assignmentRevision',new.assignment_revision
            );
        end if;
    end if;
    return new;
end;
$$;

revoke all on function public.omr_question_result_assignment_generation_guard_v2()
    from public, anon, authenticated, service_role;
drop trigger if exists omr_question_results_assignment_generation_guard_v2 on public.omr_question_results;
create trigger omr_question_results_assignment_generation_guard_v2
before insert or update of assignment_id,assignment_revision on public.omr_question_results
for each row execute function public.omr_question_result_assignment_generation_guard_v2();

create or replace function public.omr_canonical_attempt_child_evidence_matches_v1(p_attempt_id text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_attempt record;
    v_rows jsonb;
begin
    select attempt.* into v_attempt
      from public.omr_attempts attempt where attempt.id=p_attempt_id;
    if not found then return true; end if;
    if v_attempt.status <> 'completed'
       or v_attempt.question_results_question_count is null then return true; end if;
    v_rows := v_attempt.payload -> 'questionResults';
    if pg_catalog.jsonb_typeof(v_rows) <> 'array'
       or pg_catalog.jsonb_array_length(v_rows) is distinct from v_attempt.question_results_question_count
       or (select pg_catalog.count(*) from public.omr_question_results child
            where child.attempt_id=p_attempt_id) is distinct from v_attempt.question_results_question_count::bigint
       or exists (
            select 1 from public.omr_question_results child
             where child.attempt_id=p_attempt_id
               and not exists (
                    select 1 from pg_catalog.jsonb_array_elements(v_rows) embedded(value)
                     where (embedded.value ->> 'questionId')::integer=child.question_id
                       and child.payload is not distinct from embedded.value
               )
       )
       or exists (
            select 1 from pg_catalog.jsonb_array_elements(v_rows) embedded(value)
             where not exists (
                    select 1 from public.omr_question_results child
                     where child.attempt_id=p_attempt_id
                       and child.question_id=(embedded.value ->> 'questionId')::integer
                       and child.payload is not distinct from embedded.value
             )
       )
       or exists (
            select 1 from public.omr_question_results child
             where child.attempt_id=p_attempt_id and (
                    child.attempt_id is distinct from child.payload ->> 'attemptId'
                    or child.exam_id is distinct from child.payload ->> 'examId'
                    or child.organization_id is distinct from nullif(child.payload ->> 'organizationId','')
                    or child.class_id is distinct from nullif(child.payload ->> 'classId','')
                    or child.assignment_id is distinct from nullif(child.payload ->> 'assignmentId','')
                    or child.assignment_revision is distinct from (child.payload ->> 'assignmentRevision')::bigint
                    or child.student_profile_id is distinct from nullif(child.payload ->> 'studentProfileId','')
                    or child.student_name is distinct from child.payload ->> 'studentName'
                    or child.student_id is distinct from nullif(child.payload ->> 'studentId','')
                    or child.group_id is distinct from nullif(child.payload ->> 'groupId','')
                    or child.group_name is distinct from nullif(child.payload ->> 'groupName','')
                    or child.region_id is distinct from nullif(child.payload ->> 'regionId','')
                    or child.region_name is distinct from nullif(child.payload ->> 'regionName','')
                    or child.identity_type is distinct from nullif(child.payload ->> 'identityType','')
                    or child.question_id is distinct from (child.payload ->> 'questionId')::integer
                    or child.question_number is distinct from (child.payload ->> 'questionNumber')::integer
                    or child.canonical_question_id is distinct from nullif(child.payload ->> 'canonicalQuestionId','')
                    or child.label is distinct from nullif(child.payload ->> 'label','')
                    or child.subject is distinct from nullif(child.payload ->> 'subject','')
                    or child.unit is distinct from nullif(child.payload ->> 'unit','')
                    or child.concept is distinct from nullif(child.payload ->> 'concept','')
                    or child.skill is distinct from nullif(child.payload ->> 'skill','')
                    or child.source is distinct from nullif(child.payload ->> 'source','')
                    or child.difficulty is distinct from nullif(child.payload ->> 'difficulty','')
                    or child.cognitive_level is distinct from nullif(child.payload ->> 'cognitiveLevel','')
                    or to_jsonb(child.mistake_types) is distinct from coalesce(child.payload -> 'mistakeTypes','[]'::jsonb)
                    or to_jsonb(child.prerequisites) is distinct from coalesce(child.payload -> 'prerequisites','[]'::jsonb)
                    or child.expected_time_sec is distinct from (child.payload ->> 'expectedTimeSec')::integer
                    or child.selected_answer is distinct from (child.payload ->> 'selectedAnswer')::integer
                    or child.correct_answer is distinct from (child.payload ->> 'correctAnswer')::integer
                    or child.status is distinct from child.payload ->> 'status'
                    or child.is_correct is distinct from (child.payload ->> 'isCorrect')::boolean
                    or child.is_wrong is distinct from (child.payload ->> 'isWrong')::boolean
                    or child.is_unanswered is distinct from (child.payload ->> 'isUnanswered')::boolean
                    or child.score is distinct from (child.payload ->> 'score')::numeric
                    or child.earned_score is distinct from (child.payload ->> 'earnedScore')::numeric
                    or child.pdf_page is distinct from (child.payload ->> 'pdfPage')::integer
                    or child.pdf_location is distinct from child.payload -> 'pdfLocation'
                    or child.pdf_region is distinct from child.payload -> 'pdfRegion'
                    or child.time_sec is distinct from (child.payload ->> 'timeSec')::integer
                    or child.visit_count is distinct from (child.payload ->> 'visitCount')::integer
                    or child.revisit_count is distinct from (child.payload ->> 'revisitCount')::integer
                    or child.answer_change_count is distinct from (child.payload ->> 'answerChangeCount')::integer
                    or child.handwriting_stroke_count is distinct from (child.payload ->> 'handwritingStrokeCount')::integer
                    or child.handwriting_page is distinct from (child.payload ->> 'handwritingPage')::integer
                    or child.retake_source_attempt_id is distinct from nullif(child.payload ->> 'retakeSourceAttemptId','')
                    or child.retake_mode is distinct from nullif(child.payload ->> 'retakeMode','')
                    or child.answered_at is distinct from (child.payload ->> 'answeredAt')::timestamptz
                    or child.finished_at is distinct from (child.payload ->> 'finishedAt')::timestamptz
             )
       ) then return false; end if;
    return true;
exception when others then return false;
end;
$$;

revoke all on function public.omr_canonical_attempt_child_evidence_matches_v1(text)
    from public,anon,authenticated,service_role;

create or replace function public.omr_assert_canonical_attempt_child_evidence_v1(p_attempt_id text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
    if not public.omr_canonical_attempt_child_evidence_matches_v1(p_attempt_id) then
        raise exception 'canonical attempt child evidence mismatch';
    end if;
end;
$$;

revoke all on function public.omr_assert_canonical_attempt_child_evidence_v1(text)
    from public,anon,authenticated,service_role;

-- Transition-table statement triggers enqueue each affected parent at most once
-- per transaction. A single deferred queue-row trigger validates the complete
-- child set after every writer has finished, avoiding 500 full parent scans.
create schema if not exists omr_internal;
revoke all on schema omr_internal from public,anon,authenticated,service_role;
create table if not exists omr_internal.canonical_evidence_dirty_attempts(
    transaction_id bigint not null,
    attempt_id text not null,
    primary key(transaction_id,attempt_id)
);
revoke all on table omr_internal.canonical_evidence_dirty_attempts
    from public,anon,authenticated,service_role;

create or replace function public.omr_mark_canonical_attempt_evidence_dirty_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    if tg_table_name='omr_question_results' and tg_op='INSERT' then
        insert into omr_internal.canonical_evidence_dirty_attempts(transaction_id,attempt_id)
        select pg_catalog.txid_current(),row.attempt_id from canonical_new_rows row
        where row.attempt_id is not null group by row.attempt_id on conflict do nothing;
    elsif tg_table_name='omr_question_results' and tg_op='UPDATE' then
        insert into omr_internal.canonical_evidence_dirty_attempts(transaction_id,attempt_id)
        select pg_catalog.txid_current(),affected.attempt_id from (
            select row.attempt_id from canonical_new_rows row
            union select row.attempt_id from canonical_old_rows row
        ) affected where affected.attempt_id is not null group by affected.attempt_id on conflict do nothing;
    elsif tg_table_name='omr_question_results' and tg_op='DELETE' then
        insert into omr_internal.canonical_evidence_dirty_attempts(transaction_id,attempt_id)
        select pg_catalog.txid_current(),row.attempt_id from canonical_old_rows row
        where row.attempt_id is not null group by row.attempt_id on conflict do nothing;
    elsif tg_table_name='omr_attempts' and tg_op='INSERT' then
        insert into omr_internal.canonical_evidence_dirty_attempts(transaction_id,attempt_id)
        select pg_catalog.txid_current(),row.id from canonical_new_rows row
        where row.question_results_question_count is not null group by row.id on conflict do nothing;
    elsif tg_table_name='omr_attempts' and tg_op='UPDATE' then
        insert into omr_internal.canonical_evidence_dirty_attempts(transaction_id,attempt_id)
        select pg_catalog.txid_current(),affected.id from (
            select row.id from canonical_new_rows row where row.question_results_question_count is not null
            union select row.id from canonical_old_rows row where row.question_results_question_count is not null
        ) affected group by affected.id on conflict do nothing;
    end if;
    return null;
end;
$$;

revoke all on function public.omr_mark_canonical_attempt_evidence_dirty_v1()
    from public,anon,authenticated,service_role;

create or replace function public.omr_finalize_canonical_attempt_evidence_dirty_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
    perform public.omr_assert_canonical_attempt_child_evidence_v1(new.attempt_id);
    delete from omr_internal.canonical_evidence_dirty_attempts
     where transaction_id=new.transaction_id and attempt_id=new.attempt_id;
    return null;
end;
$$;

revoke all on function public.omr_finalize_canonical_attempt_evidence_dirty_v1()
    from public,anon,authenticated,service_role;

drop trigger if exists omr_attempts_deferred_canonical_child_evidence_guard_v1 on public.omr_attempts;
drop trigger if exists omr_question_results_deferred_canonical_evidence_guard_v1 on public.omr_question_results;
drop trigger if exists omr_question_results_canonical_dirty_insert_v1 on public.omr_question_results;
drop trigger if exists omr_question_results_canonical_dirty_update_v1 on public.omr_question_results;
drop trigger if exists omr_question_results_canonical_dirty_delete_v1 on public.omr_question_results;
drop trigger if exists omr_attempts_canonical_dirty_insert_v1 on public.omr_attempts;
drop trigger if exists omr_attempts_canonical_dirty_update_v1 on public.omr_attempts;
drop trigger if exists omr_canonical_evidence_dirty_attempt_finalize_v1 on omr_internal.canonical_evidence_dirty_attempts;

create trigger omr_question_results_canonical_dirty_insert_v1
after insert on public.omr_question_results
referencing new table as canonical_new_rows
for each statement execute function public.omr_mark_canonical_attempt_evidence_dirty_v1();
create trigger omr_question_results_canonical_dirty_update_v1
after update on public.omr_question_results
referencing new table as canonical_new_rows old table as canonical_old_rows
for each statement execute function public.omr_mark_canonical_attempt_evidence_dirty_v1();
create trigger omr_question_results_canonical_dirty_delete_v1
after delete on public.omr_question_results
referencing old table as canonical_old_rows
for each statement execute function public.omr_mark_canonical_attempt_evidence_dirty_v1();
create trigger omr_attempts_canonical_dirty_insert_v1
after insert on public.omr_attempts
referencing new table as canonical_new_rows
for each statement execute function public.omr_mark_canonical_attempt_evidence_dirty_v1();
create trigger omr_attempts_canonical_dirty_update_v1
after update on public.omr_attempts
referencing new table as canonical_new_rows old table as canonical_old_rows
for each statement execute function public.omr_mark_canonical_attempt_evidence_dirty_v1();

create constraint trigger omr_canonical_evidence_dirty_attempt_finalize_v1
after insert on omr_internal.canonical_evidence_dirty_attempts
deferrable initially deferred
for each row execute function public.omr_finalize_canonical_attempt_evidence_dirty_v1();

create or replace function public.omr_guard_completed_question_result_grading_immutability_v1()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_is_canonical boolean;
begin
    select exists (
        select 1 from public.omr_attempts attempt
         where attempt.id=old.attempt_id and attempt.status='completed'
           and attempt.question_results_question_count is not null
    ) into v_is_canonical;
    if v_is_canonical
       and to_jsonb(new) - 'updated_at' is distinct from to_jsonb(old) - 'updated_at' then
        raise exception 'canonical question-result grading fields are immutable';
    end if;
    return new;
end;
$$;

revoke all on function public.omr_guard_completed_question_result_grading_immutability_v1()
    from public,anon,authenticated,service_role;
drop trigger if exists omr_question_results_completed_grading_immutability_v1 on public.omr_question_results;
create trigger omr_question_results_completed_grading_immutability_v1
before update on public.omr_question_results
for each row execute function public.omr_guard_completed_question_result_grading_immutability_v1();

create index if not exists omr_question_results_assignment_generation_attempt_idx
    on public.omr_question_results(assignment_id,assignment_revision,attempt_id)
    where assignment_id is not null and assignment_revision is not null;
create index if not exists omr_question_results_attempt_question_number_idx
    on public.omr_question_results(attempt_id,question_id,question_number);
create index if not exists omr_attempts_canonical_definition_generation_idx
    on public.omr_attempts(exam_id,question_results_definition_manifest_hash,assignment_id,assignment_revision)
    where question_results_definition_manifest_hash is not null;

do $$
begin
    if pg_catalog.to_regprocedure(
        'public.omr_force_finish_attempt_sessions_compact_pre_canonical_v2(text,text[],timestamptz,text,text,text,jsonb)'
    ) is null then
        alter function public.omr_force_finish_attempt_sessions_compact_v2(
            text,text[],timestamptz,text,text,text,jsonb
        ) rename to omr_force_finish_attempt_sessions_compact_pre_canonical_v2;
    end if;
end $$;

create or replace function public.omr_force_finish_attempt_sessions_compact_v2(
    p_organization_id text,p_session_ids text[],p_finished_at timestamptz,
    p_actor_user_id text,p_member_role text,p_actor_label text,p_expectations jsonb
)
returns table(payload jsonb)
language plpgsql
security definer
set search_path = ''
set statement_timeout = '15s'
set lock_timeout = '3s'
as $$
declare
    v_payloads jsonb;
    v_count integer;
begin
    select coalesce(pg_catalog.jsonb_agg(result.payload),'[]'::jsonb),count(*)::integer
      into v_payloads,v_count
      from public.omr_force_finish_attempt_sessions_compact_pre_canonical_v2(
          p_organization_id,p_session_ids,p_finished_at,p_actor_user_id,
          p_member_role,p_actor_label,p_expectations
      ) result;
    if v_count is distinct from pg_catalog.cardinality(p_session_ids)
       or exists (
           select 1
             from pg_catalog.unnest(p_session_ids) requested(session_id)
             join public.omr_attempt_sessions session on session.id=requested.session_id
             join public.omr_attempts attempt on attempt.id=session.attempt_id
            where attempt.question_results_question_count is null
               or attempt.question_results_definition_manifest_hash is null
               or attempt.question_results_full_evidence_hash is null
               or pg_catalog.jsonb_typeof(attempt.payload -> 'questionResults') <> 'array'
               or attempt.question_results_question_count is distinct from
                    pg_catalog.jsonb_array_length(attempt.payload -> 'questionResults')
               or attempt.payload ->> 'questionResultsDefinitionManifestHash'
                    is distinct from attempt.question_results_definition_manifest_hash
               or attempt.payload ->> 'questionResultsFullEvidenceHash'
                    is distinct from attempt.question_results_full_evidence_hash
               or attempt.payload ->> 'assignmentRevision'
                    is distinct from session.assignment_revision::text
               or (select pg_catalog.count(*) from public.omr_question_results result
                    where result.attempt_id=attempt.id)
                    is distinct from attempt.question_results_question_count::bigint
               or exists (
                    select 1 from public.omr_question_results result
                     where result.attempt_id=attempt.id
                       and (
                           result.assignment_id is distinct from session.assignment_id
                           or result.assignment_revision is distinct from session.assignment_revision
                           or result.payload ->> 'assignmentRevision'
                                is distinct from session.assignment_revision::text
                       )
               )
               or not public.omr_canonical_attempt_child_evidence_matches_v1(attempt.id)
       ) then raise exception 'compact force canonical evidence postcondition failed'; end if;
    return query select item.value from pg_catalog.jsonb_array_elements(v_payloads) item(value);
end;
$$;

comment on function public.omr_force_finish_attempt_sessions_compact_v2(
    text,text[],timestamptz,text,text,text,jsonb
) is 'canonical-evidence:202608100001; compact force rows carry exact generation and atomic dual digests';
revoke all on function public.omr_force_finish_attempt_sessions_compact_v2(
    text,text[],timestamptz,text,text,text,jsonb
) from public,anon,authenticated;
grant execute on function public.omr_force_finish_attempt_sessions_compact_v2(
    text,text[],timestamptz,text,text,text,jsonb
) to service_role;

create or replace function public.omr_canonical_question_result_evidence_ready_v1()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select
        pg_catalog.to_regprocedure('public.omr_canonical_json_text_v1(jsonb)') is not null
        and pg_catalog.to_regprocedure('public.omr_assert_canonical_question_result_json_v1(jsonb,integer)') is not null
        and pg_catalog.to_regprocedure('public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb)') is not null
        and exists (
            select 1 from pg_catalog.pg_attribute attribute
             where attribute.attrelid='public.omr_attempts'::pg_catalog.regclass
               and attribute.attname='question_results_question_count' and not attribute.attisdropped
        )
        and exists (
            select 1 from pg_catalog.pg_attribute attribute
             where attribute.attrelid='public.omr_attempts'::pg_catalog.regclass
               and attribute.attname='question_results_definition_manifest_hash' and not attribute.attisdropped
        )
        and exists (
            select 1 from pg_catalog.pg_attribute attribute
             where attribute.attrelid='public.omr_attempts'::pg_catalog.regclass
               and attribute.attname='question_results_full_evidence_hash' and not attribute.attisdropped
        )
        and exists (
            select 1 from pg_catalog.pg_attribute attribute
             where attribute.attrelid='public.omr_question_results'::pg_catalog.regclass
               and attribute.attname='assignment_revision' and not attribute.attisdropped
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid='public.omr_attempts'::pg_catalog.regclass
               and trigger_row.tgname='omr_attempts_assignment_revision_payload_guard'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid='public.omr_attempts'::pg_catalog.regclass
               and trigger_row.tgname='omr_attempts_canonical_question_result_evidence_guard'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid='public.omr_question_results'::pg_catalog.regclass
               and trigger_row.tgname='omr_question_results_assignment_generation_guard_v2'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid='omr_internal.canonical_evidence_dirty_attempts'::pg_catalog.regclass
               and trigger_row.tgname='omr_canonical_evidence_dirty_attempt_finalize_v1'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid='public.omr_question_results'::pg_catalog.regclass
               and trigger_row.tgname='omr_question_results_canonical_dirty_update_v1'
               and not trigger_row.tgisinternal
        )
        and exists (
            select 1 from pg_catalog.pg_trigger trigger_row
             where trigger_row.tgrelid='public.omr_question_results'::pg_catalog.regclass
               and trigger_row.tgname='omr_question_results_completed_grading_immutability_v1'
               and not trigger_row.tgisinternal
        )
        and pg_catalog.has_function_privilege(
            'service_role','public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb)','EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
            'authenticated','public.omr_compute_canonical_question_result_evidence_v1(jsonb,jsonb)','EXECUTE'
        )
        and pg_catalog.obj_description(
            'public.omr_force_finish_attempt_sessions_compact_v2(text,text[],timestamptz,text,text,text,jsonb)'::pg_catalog.regprocedure,
            'pg_proc'
        ) is not distinct from
            'canonical-evidence:202608100001; compact force rows carry exact generation and atomic dual digests';
$$;

revoke all on function public.omr_canonical_question_result_evidence_ready_v1()
    from public, anon, authenticated;
grant execute on function public.omr_canonical_question_result_evidence_ready_v1() to service_role;

do $$
begin
    if pg_catalog.to_regprocedure('public.omr_service_readiness_pre_canonical_v1()') is null then
        alter function public.omr_service_readiness_v1() rename to omr_service_readiness_pre_canonical_v1;
    end if;
end $$;

create or replace function public.omr_service_readiness_v1()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    v_previous jsonb := public.omr_service_readiness_pre_canonical_v1();
    v_canonical boolean := public.omr_canonical_question_result_evidence_ready_v1();
begin
    return v_previous || pg_catalog.jsonb_build_object(
        'canonicalQuestionResultEvidenceReady',v_canonical,
        'serverGatewayCapabilitiesReady',coalesce((v_previous->>'serverGatewayCapabilitiesReady')::boolean,false) and v_canonical,
        'ready',coalesce((v_previous->>'ready')::boolean,false) and v_canonical
    );
end;
$$;

revoke all on function public.omr_service_readiness_v1() from public, anon, authenticated;
grant execute on function public.omr_service_readiness_v1() to service_role;

commit;
