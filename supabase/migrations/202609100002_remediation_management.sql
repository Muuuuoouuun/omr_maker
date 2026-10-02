begin;

create table public.omr_remediation_cases (
    source_attempt_id text primary key references public.omr_attempts(id) on delete cascade,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    class_id text not null references public.omr_classes(id) on delete cascade,
    student_profile_id text not null references public.omr_student_profiles(id) on delete cascade,
    assigned_by text not null,
    due_at timestamptz not null,
    state text not null default 'open' check (state in ('open','paused','confirmed')),
    note text not null default '' check (length(note) <= 500),
    confirmed_evidence_key text,
    revision bigint not null default 1 check (revision between 1 and 9007199254740991),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index omr_remediation_cases_org_due_idx on public.omr_remediation_cases(organization_id,due_at,source_attempt_id);
create index omr_remediation_cases_student_idx on public.omr_remediation_cases(organization_id,student_profile_id);
create index omr_remediation_cases_class_idx on public.omr_remediation_cases(class_id);
create index omr_remediation_retakes_idx on public.omr_attempts(organization_id,retake_source_attempt_id,finished_at desc,id)
    where status='completed' and retake_source_attempt_id is not null;
alter table public.omr_remediation_cases enable row level security;
alter table public.omr_remediation_cases force row level security;
revoke all on table public.omr_remediation_cases from public,anon,authenticated,service_role;
grant select on table public.omr_remediation_cases to service_role;

-- Action + current role + exact class relationship. Role comes from the
-- database identity lock, never from the submitted command or browser cache.
create function public.omr_remediation_allowed_v1(p_org text,p_actor text,p_role text,p_class text,p_write boolean)
returns boolean language sql stable security definer set search_path='' as $$
    select case
        when p_role in ('owner','admin') then true
        when p_role='teacher' or (p_role='assistant' and not p_write) then exists (
            select 1 from public.omr_class_teachers ct
            where ct.organization_id=p_org and ct.class_id=p_class and ct.teacher_user_id=p_actor
              and (ct.class_role in ('lead','co_teacher') or (ct.class_role='grader' and not p_write))
        ) else false end;
$$;

-- Latest evidence PER question: an earlier correct answer cannot hide a later
-- wrong answer. Compare the immutable submitted definition, not current exam edits.
create function public.omr_remediation_progress_v1(p_source text)
returns jsonb language sql stable security definer set search_path='' as $$
    with source as (
        select * from public.omr_attempts where id=p_source and status='completed'
          and question_results_question_count is not null and retake_source_attempt_id is null
    ), targets as (
        select q.* from public.omr_question_results q join source s on s.id=q.attempt_id
        where q.status in ('wrong','unanswered')
    ), evidence as (
        select q.question_id, latest.id, latest.status, latest.evidence_hash
        from targets q join source s on true
        left join lateral (
            select r.id, answer.status, r.question_results_full_evidence_hash evidence_hash
            from public.omr_attempts r join public.omr_question_results answer on answer.attempt_id=r.id
            where r.retake_source_attempt_id=s.id and r.organization_id=s.organization_id
              and r.student_id=s.student_id and r.student_profile_id=s.student_profile_id
              and r.identity_type=s.identity_type and r.exam_id=s.exam_id
              and r.status='completed' and r.question_results_question_count is not null
              and r.finished_at>=s.finished_at and answer.question_id=q.question_id
              and q.question_id=any(r.retake_question_ids)
              and answer.question_number=q.question_number and answer.score=q.score
              and answer.correct_answer is not distinct from q.correct_answer
              and answer.canonical_question_id is not distinct from q.canonical_question_id
            order by r.finished_at desc,r.id desc limit 1
        ) latest on true
    ) select jsonb_build_object(
        'targetCount',count(*), 'correctedCount',count(*) filter(where status='correct'),
        'submittedCount',count(*) filter(where id is not null),
        'evidenceKey',md5(coalesce(string_agg(question_id::text||':'||coalesce(id,'')||':'||coalesce(status,'')||':'||coalesce(evidence_hash,''),',' order by question_id),''))
    ) from evidence;
$$;

create function public.omr_remediation_case_view_v1(p_case public.omr_remediation_cases,p_actor text,p_role text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare progress jsonb; source public.omr_attempts%rowtype; class_name text; actor_name text; display_state text; active boolean;
begin
    select * into source from public.omr_attempts where id=p_case.source_attempt_id;
    select name into class_name from public.omr_classes where id=p_case.class_id;
    select display_name into actor_name from public.omr_organization_members where organization_id=p_case.organization_id and user_id=p_case.assigned_by;
    progress:=public.omr_remediation_progress_v1(source.id);
    active:=exists(select 1 from public.omr_class_students e
        join public.omr_student_profiles s on s.id=e.student_profile_id and s.organization_id=e.organization_id
        join public.omr_classes c on c.id=e.class_id and c.organization_id=e.organization_id
        where e.organization_id=p_case.organization_id and e.class_id=p_case.class_id and e.student_profile_id=p_case.student_profile_id
          and e.enrollment_status='active' and s.status='active' and c.status='active')
        and exists(select 1 from public.omr_organization_members m where m.organization_id=p_case.organization_id
            and m.user_id=p_case.assigned_by and m.status='active'
            and public.omr_remediation_allowed_v1(m.organization_id,m.user_id,m.role,p_case.class_id,true));
    display_state:=case
        when not active then 'handoff'
        when p_case.state='paused' then 'paused'
        when p_case.state='confirmed' and p_case.confirmed_evidence_key=progress->>'evidenceKey' then 'confirmed'
        when (progress->>'targetCount')::integer>0 and progress->>'correctedCount'=progress->>'targetCount' then 'awaiting_review'
        when (progress->>'submittedCount')::integer>(progress->>'correctedCount')::integer then 'recheck'
        when p_case.due_at<=now() then 'overdue' else 'assigned' end;
    return progress||jsonb_build_object(
        'sourceAttemptId',source.id,'examId',source.exam_id,'examTitle',coalesce(source.payload->>'examTitle','시험'),
        'studentName',source.student_name,'className',coalesce(class_name,''),'assigneeName',coalesce(actor_name,'담당 확인 필요'),
        'dueAt',p_case.due_at,'revision',p_case.revision,'state',display_state,'note',p_case.note,
        'canManage',active and public.omr_remediation_allowed_v1(p_case.organization_id,p_actor,p_role,p_case.class_id,true)
    );
end;
$$;

create function public.omr_manage_remediation_v1(
    p_session_authority text,p_account_id text,p_session_generation bigint,p_organization_id text,p_actor_user_id text,p_command jsonb
) returns jsonb language plpgsql security definer set search_path='' set statement_timeout='5s' set lock_timeout='2s' as $$
declare identity jsonb; plan jsonb; role_name text; operation text:=p_command->>'op'; source public.omr_attempts%rowtype;
    item public.omr_remediation_cases%rowtype; views jsonb; candidates jsonb; snapshot jsonb; ids text[]; source_id text;
    deadline timestamptz; memo text; expected bigint; changed boolean; plan_enabled boolean; page_number integer;
begin
    identity:=public.omr_lock_teacher_mutation_identity_v1(p_session_authority,p_account_id,p_session_generation,p_organization_id,p_actor_user_id);
    if identity is null then return jsonb_build_object('status','unauthorized'); end if;
    role_name:=identity->>'memberRole';
    plan:=public.omr_read_teacher_mutation_plan_v1(p_session_authority,p_account_id,p_organization_id,p_actor_user_id);
    plan_enabled:=coalesce(plan->>'plan' in ('pro','academy'),false);
    if operation not in ('load','assign','confirm','pause','resume') or operation is null then return jsonb_build_object('status','invalid_request'); end if;
    -- Hold class grants through the transaction so revocation cannot race a save.
    perform 1 from public.omr_class_teachers where organization_id=p_organization_id and teacher_user_id=p_actor_user_id order by class_id for share;
    if operation='load' then
        if coalesce(p_command->>'page','0') !~ '^[0-9]{1,5}$' then return jsonb_build_object('status','invalid_request'); end if;
        page_number:=coalesce(p_command->>'page','0')::integer;
        if page_number>10000 then return jsonb_build_object('status','invalid_request'); end if;
        with visible as materialized (
            select public.omr_remediation_case_view_v1(c,p_actor_user_id,role_name) view_row,c.due_at,c.source_attempt_id
            from public.omr_remediation_cases c where c.organization_id=p_organization_id
              and public.omr_remediation_allowed_v1(p_organization_id,p_actor_user_id,role_name,c.class_id,false)
        ), ranked as (
            select *,case view_row->>'state' when 'recheck' then 0 when 'overdue' then 1 when 'awaiting_review' then 2
                when 'handoff' then 3 when 'assigned' then 4 when 'paused' then 5 else 6 end priority from visible
        ) select coalesce(jsonb_agg(view_row order by priority,due_at,source_attempt_id),'[]'::jsonb) into views from (
            select * from ranked order by priority,due_at,source_attempt_id offset page_number*50 limit 51
        ) listed;
        select coalesce(jsonb_agg(jsonb_build_object('sourceAttemptId',a.id,'examTitle',coalesce(a.payload->>'examTitle','시험'),
            'studentName',a.student_name,'className',c.name,'wrongCount',q.wrong_count) order by a.finished_at desc,a.id),'[]'::jsonb)
        into candidates from (
            select a.* from public.omr_attempts a
            where a.organization_id=p_organization_id and a.status='completed' and a.retake_source_attempt_id is null
              and a.question_results_question_count is not null and a.identity_type='registered'
              and not exists(select 1 from public.omr_remediation_cases r where r.source_attempt_id=a.id)
              and exists(select 1 from public.omr_question_results q where q.attempt_id=a.id and q.status in ('wrong','unanswered'))
              and exists(select 1 from public.omr_classes c where c.id=a.class_id and c.organization_id=p_organization_id and c.status='active')
              and public.omr_remediation_allowed_v1(p_organization_id,p_actor_user_id,role_name,a.class_id,true)
              and exists(select 1 from public.omr_class_students e join public.omr_student_profiles s on s.id=e.student_profile_id
                  where e.organization_id=p_organization_id and e.class_id=a.class_id and e.student_profile_id=a.student_profile_id and e.enrollment_status='active' and s.status='active')
            order by a.finished_at desc,a.id limit 50
        ) a join public.omr_classes c on c.id=a.class_id and c.organization_id=p_organization_id and c.status='active'
        cross join lateral (select count(*) wrong_count from public.omr_question_results q where q.attempt_id=a.id and q.status in ('wrong','unanswered')) q
        where q.wrong_count>0;
        return jsonb_build_object('status','loaded','dashboard',jsonb_build_object(
            'cases',(select coalesce(jsonb_agg(value),'[]'::jsonb) from (select value from jsonb_array_elements(views) limit 50) v),
            'candidates',(select coalesce(jsonb_agg(value),'[]'::jsonb) from (select value from jsonb_array_elements(candidates) limit 50) v),
            'hasMore',jsonb_array_length(views)>50,
            'canAssign',role_name in ('owner','admin','teacher'),'planEnabled',plan_enabled));
    end if;
    if not plan_enabled then return jsonb_build_object('status','plan_denied'); end if;
    if role_name not in ('owner','admin','teacher') then return jsonb_build_object('status','unauthorized'); end if;

    -- An exception rolls back the whole batch, including earlier insertions.
    begin
        if operation='assign' then
            if jsonb_typeof(p_command->'sourceAttemptIds') is distinct from 'array' then raise exception using errcode='P0001',message='invalid_request'; end if;
            select array_agg(value order by value) into ids from jsonb_array_elements_text(p_command->'sourceAttemptIds');
            deadline:=(p_command->>'dueAt')::timestamptz;
            if coalesce(cardinality(ids),0) not between 1 and 20 or deadline is null or deadline<=now() or deadline>now()+interval '90 days'
                or exists(select 1 from unnest(ids) id where id is null or length(id) not between 1 and 256)
                or cardinality(ids)<>(select count(distinct id) from unnest(ids) id) then raise exception using errcode='P0001',message='invalid_request'; end if;
            foreach source_id in array ids loop
                select * into source from public.omr_attempts where id=source_id and organization_id=p_organization_id for share;
                if not found or source.status<>'completed' or source.retake_source_attempt_id is not null
                    or source.question_results_question_count is null or source.identity_type<>'registered'
                    or not public.omr_remediation_allowed_v1(p_organization_id,p_actor_user_id,role_name,source.class_id,true)
                    then raise exception using errcode='P0001',message='unauthorized'; end if;
                perform 1 from public.omr_class_students e join public.omr_student_profiles s on s.id=e.student_profile_id and s.organization_id=e.organization_id
                    join public.omr_classes c on c.id=e.class_id and c.organization_id=e.organization_id
                    where e.organization_id=p_organization_id and e.class_id=source.class_id and e.student_profile_id=source.student_profile_id
                      and e.enrollment_status='active' and s.status='active' and c.status='active' for share of e,s,c;
                if not found then raise exception using errcode='P0001',message='handoff'; end if;
                if (public.omr_remediation_progress_v1(source.id)->>'targetCount')::integer=0 then raise exception using errcode='P0001',message='invalid_request'; end if;
                insert into public.omr_remediation_cases(source_attempt_id,organization_id,class_id,student_profile_id,assigned_by,due_at)
                    values(source.id,p_organization_id,source.class_id,source.student_profile_id,p_actor_user_id,deadline) on conflict do nothing;
                changed:=found;
                if changed then insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata)
                    values(gen_random_uuid()::text,p_organization_id,p_actor_user_id,'remediation.assign','remediation',source.id,jsonb_build_object('dueAt',deadline,'revision',1)); end if;
            end loop;
        else
            select * into item from public.omr_remediation_cases where source_attempt_id=p_command->>'sourceAttemptId' and organization_id=p_organization_id for update;
            if not found or not public.omr_remediation_allowed_v1(p_organization_id,p_actor_user_id,role_name,item.class_id,true)
                then raise exception using errcode='P0001',message='unauthorized'; end if;
            expected:=(p_command->>'expectedRevision')::bigint;
            if expected is distinct from item.revision then raise exception using errcode='P0001',message='conflict'; end if;
            perform 1 from public.omr_class_students e join public.omr_student_profiles s on s.id=e.student_profile_id
                join public.omr_classes c on c.id=e.class_id
                where e.organization_id=p_organization_id and e.class_id=item.class_id and e.student_profile_id=item.student_profile_id
                for share of e,s,c;
            perform 1 from public.omr_organization_members where organization_id=p_organization_id and user_id=item.assigned_by for share;
            perform 1 from public.omr_class_teachers where organization_id=p_organization_id and teacher_user_id=item.assigned_by and class_id=item.class_id for share;
            snapshot:=public.omr_remediation_case_view_v1(item,p_actor_user_id,role_name);
            if snapshot->>'evidenceKey' is distinct from p_command->>'evidenceKey' then raise exception using errcode='P0001',message='conflict'; end if;
            if snapshot->>'state'='handoff' and operation<>'pause' then raise exception using errcode='P0001',message='handoff'; end if;
            memo:=btrim(coalesce(p_command->>'note',''));
            if length(memo)>500 or (operation in ('confirm','pause') and length(memo)<5) then raise exception using errcode='P0001',message='invalid_request'; end if;
            if operation='confirm' and snapshot->>'state'<>'awaiting_review' then raise exception using errcode='P0001',message='not_ready'; end if;
            if operation='resume' and item.state<>'paused' then raise exception using errcode='P0001',message='invalid_request'; end if;
            update public.omr_remediation_cases set state=case operation when 'confirm' then 'confirmed' when 'pause' then 'paused' else 'open' end,
                note=memo, confirmed_evidence_key=case when operation='confirm' then snapshot->>'evidenceKey' else null end,
                revision=revision+1,updated_at=now() where source_attempt_id=item.source_attempt_id;
            insert into public.omr_audit_logs(id,organization_id,actor_user_id,action,entity_type,entity_id,metadata)
                values(gen_random_uuid()::text,p_organization_id,p_actor_user_id,'remediation.'||operation,'remediation',item.source_attempt_id,
                    jsonb_build_object('revision',item.revision+1,'note',memo,'evidenceKey',snapshot->>'evidenceKey'));
        end if;
    exception when sqlstate 'P0001' then return jsonb_build_object('status',sqlerrm);
        when invalid_text_representation or datetime_field_overflow then return jsonb_build_object('status','invalid_request');
    end;
    return jsonb_build_object('status','saved');
end;
$$;

-- Called only after server-cookie/credential-generation validation. Return no
-- answer keys, internal teacher notes, or data belonging to another student.
create function public.omr_student_remediation_v1(p_org text,p_student text)
returns jsonb language sql stable security definer set search_path='' set statement_timeout='5s' as $$
    with visible as materialized (
        select public.omr_remediation_case_view_v1(c,'','') view_row,c.due_at,c.source_attempt_id
        from public.omr_remediation_cases c join public.omr_attempts a on a.id=c.source_attempt_id
        where c.organization_id=p_org and a.organization_id=p_org and a.student_id=p_student and a.identity_type='registered'
    ), ranked as (
        select *,case view_row->>'state' when 'recheck' then 0 when 'overdue' then 1 when 'awaiting_review' then 2
            when 'handoff' then 3 when 'assigned' then 4 when 'paused' then 5 else 6 end priority from visible
    ) select coalesce(jsonb_agg(jsonb_build_object(
        'sourceAttemptId',source_attempt_id,'examId',view_row->>'examId','examTitle',view_row->>'examTitle',
        'dueAt',due_at,'state',view_row->>'state','correctedCount',(view_row->>'correctedCount')::integer,
        'targetCount',(view_row->>'targetCount')::integer
    ) order by priority,due_at,source_attempt_id),'[]'::jsonb)
    from (select * from ranked order by priority,due_at,source_attempt_id limit 50) listed;
$$;

revoke all on function public.omr_remediation_allowed_v1(text,text,text,text,boolean) from public,anon,authenticated,service_role;
revoke all on function public.omr_remediation_progress_v1(text) from public,anon,authenticated,service_role;
revoke all on function public.omr_remediation_case_view_v1(public.omr_remediation_cases,text,text) from public,anon,authenticated,service_role;
revoke all on function public.omr_manage_remediation_v1(text,text,bigint,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.omr_student_remediation_v1(text,text) from public,anon,authenticated;
grant execute on function public.omr_manage_remediation_v1(text,text,bigint,text,text,jsonb) to service_role;
grant execute on function public.omr_student_remediation_v1(text,text) to service_role;
commit;
