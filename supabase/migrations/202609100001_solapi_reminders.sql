begin;

create table public.omr_reminder_settings (
    exam_id text primary key references public.omr_exams(id) on delete cascade,
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    enabled boolean not null default false,
    channel text not null default 'kakao' check (channel in ('kakao', 'sms')),
    before_minutes integer not null default 60 check (before_minutes between 5 and 10080),
    overdue_minutes integer default 60 check (overdue_minutes between 0 and 10080),
    quiet_start integer not null default 21 check (quiet_start between 0 and 23),
    quiet_end integer not null default 8 check (quiet_end between 0 and 23),
    session_authority text not null check (session_authority in ('account', 'legacy_account')),
    account_id text not null,
    session_generation bigint not null,
    actor_user_id text not null,
    updated_at timestamptz not null default now()
);
create index omr_reminder_settings_org_idx on public.omr_reminder_settings(organization_id, exam_id);

create table public.omr_reminder_contacts (
    organization_id text not null,
    student_profile_id text not null,
    phone text not null check (phone ~ '^010[0-9]{8}$'),
    enabled boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (organization_id, student_profile_id),
    foreign key (organization_id, student_profile_id)
        references public.omr_student_profiles(organization_id, id) on delete cascade
);

create table public.omr_reminder_deliveries (
    id uuid primary key default gen_random_uuid(),
    organization_id text not null references public.omr_organizations(id) on delete cascade,
    exam_id text not null references public.omr_exams(id) on delete cascade,
    student_profile_id text not null,
    assignment_id text not null default '',
    assignment_revision bigint not null default 0,
    deadline timestamptz not null,
    kind text not null check (kind in ('before_deadline', 'overdue')),
    mode text not null check (mode in ('dry_run', 'live')),
    channel text not null check (channel in ('kakao', 'sms')),
    phone_last4 text not null,
    status text not null check (status in ('preview', 'sending', 'accepted', 'failed', 'unknown')),
    provider_group_id text,
    error_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    foreign key (organization_id, student_profile_id)
        references public.omr_student_profiles(organization_id, id) on delete cascade,
    unique (organization_id, exam_id, student_profile_id, assignment_id, assignment_revision, deadline, kind, mode)
);
create index omr_reminder_deliveries_history_idx on public.omr_reminder_deliveries(organization_id, created_at desc);
create index omr_reminder_deliveries_sending_idx on public.omr_reminder_deliveries(updated_at) where status = 'sending';
create index if not exists omr_attempts_reminder_submission_idx
    on public.omr_attempts(organization_id, exam_id, student_profile_id, assignment_id, assignment_revision)
    where status = 'completed';

alter table public.omr_reminder_settings enable row level security;
alter table public.omr_reminder_settings force row level security;
alter table public.omr_reminder_contacts enable row level security;
alter table public.omr_reminder_contacts force row level security;
alter table public.omr_reminder_deliveries enable row level security;
alter table public.omr_reminder_deliveries force row level security;
revoke all on public.omr_reminder_settings, public.omr_reminder_contacts, public.omr_reminder_deliveries from public, anon, authenticated;
grant all on public.omr_reminder_settings, public.omr_reminder_contacts, public.omr_reminder_deliveries to service_role;

-- A malformed legacy date excludes the exam instead of breaking every scheduled run.
create function public.omr_reminder_timestamp_v1(p_value text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
    if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}T' then return null; end if;
    return p_value::timestamptz;
exception when others then return null;
end;
$$;

-- Authoritative roster/assignment selection shared by preview and the last-moment claim.
create function public.omr_reminder_candidates_v1(p_organization_id text, p_exam_id text, p_due_only boolean)
returns table (candidate jsonb)
language sql security definer set search_path = '' set statement_timeout = '5s' as $$
with targets as (
    select e.id exam_id, e.organization_id, e.title, s.id student_id, s.display_name,
           c.phone, cfg.channel, cfg.before_minutes, cfg.overdue_minutes, cfg.enabled,
           cfg.quiet_start, cfg.quiet_end,
           public.omr_reminder_timestamp_v1(e.payload ->> 'endAt') deadline,
           public.omr_reminder_timestamp_v1(e.payload ->> 'startAt') starts_at,
           ''::text assignment_id, 0::bigint assignment_revision
      from public.omr_reminder_settings cfg
      join public.omr_exams e on e.id = cfg.exam_id and e.organization_id = cfg.organization_id
      join public.omr_student_profiles s on s.organization_id = e.organization_id and s.status = 'active'
      join public.omr_reminder_contacts c on c.organization_id = s.organization_id and c.student_profile_id = s.id and c.enabled
     where e.organization_id = p_organization_id and (p_exam_id is null or e.id = p_exam_id)
       and not e.archived and coalesce(e.payload ->> 'archived', 'false') <> 'true'
       and e.payload #>> '{accessConfig,type}' = 'group'
       and (nullif(e.payload ->> 'startAt', '') is null or public.omr_reminder_timestamp_v1(e.payload ->> 'startAt') is not null)
       and exists (
           select 1 from public.omr_class_students cs
           join public.omr_classes cl on cl.id = cs.class_id and cl.organization_id = cs.organization_id and cl.status = 'active'
           where cs.organization_id = e.organization_id and cs.student_profile_id = s.id and cs.enrollment_status = 'active'
             and ((e.payload #> '{accessConfig,groupIds}') ? cl.id or (e.payload #> '{accessConfig,groupIds}') ? cl.name)
       )
    union all
    select e.id, e.organization_id, e.title, s.id, s.display_name, c.phone,
           cfg.channel, cfg.before_minutes, cfg.overdue_minutes, cfg.enabled, cfg.quiet_start, cfg.quiet_end,
           coalesce(a.due_at, a.closes_at, public.omr_reminder_timestamp_v1(e.payload ->> 'endAt')),
           coalesce(a.opens_at, public.omr_reminder_timestamp_v1(e.payload ->> 'startAt')),
           a.id, a.revision
      from public.omr_reminder_settings cfg
      join public.omr_exams e on e.id = cfg.exam_id and e.organization_id = cfg.organization_id
      join public.omr_assignments a on a.exam_id = e.id and a.organization_id = e.organization_id
          and a.access_mode = 'targeted' and a.status in ('scheduled', 'open', 'closed')
      join public.omr_assignment_targets t on t.assignment_id = a.id and t.organization_id = a.organization_id
          and t.target_type = 'student' and t.status = 'active'
      join public.omr_student_profiles s on s.id = t.student_profile_id and s.organization_id = e.organization_id and s.status = 'active'
      join public.omr_reminder_contacts c on c.organization_id = s.organization_id and c.student_profile_id = s.id and c.enabled
     where e.organization_id = p_organization_id and (p_exam_id is null or e.id = p_exam_id)
       and not e.archived and coalesce(e.payload ->> 'archived', 'false') <> 'true'
       and e.payload #>> '{accessConfig,type}' = 'targeted'
       and (a.status <> 'closed' or coalesce(a.due_at, a.closes_at, public.omr_reminder_timestamp_v1(e.payload ->> 'endAt')) <= now())
), missing as (
    select t.* from targets t
     where t.deadline is not null and (t.starts_at is null or t.starts_at < t.deadline)
       and not exists (
           select 1 from public.omr_attempts a
            where a.organization_id = t.organization_id and a.exam_id = t.exam_id and a.status = 'completed'
              and coalesce(a.student_profile_id, a.student_id) = t.student_id
              and ((t.assignment_id = '' and a.retake_source_attempt_id is null)
                   or (a.assignment_id = t.assignment_id and a.assignment_revision = t.assignment_revision))
       )
), events as (
    select t.*, 'before_deadline'::text kind, t.deadline - make_interval(mins => t.before_minutes) due_at,
           t.deadline expires_at from missing t
    union all
    select t.*, 'overdue', t.deadline + make_interval(mins => t.overdue_minutes),
           t.deadline + make_interval(mins => t.overdue_minutes) + interval '24 hours'
      from missing t where t.overdue_minutes is not null
)
select jsonb_build_object(
    'organizationId', organization_id, 'examId', exam_id, 'studentId', student_id,
    'studentName', display_name, 'examTitle', title, 'phone', phone, 'channel', channel,
    'kind', kind, 'deadline', deadline, 'dueAt', due_at, 'assignmentId', assignment_id,
    'assignmentRevision', assignment_revision, 'beforeMinutes', before_minutes
)
from events
where not p_due_only or (
    enabled and due_at <= now() and now() < expires_at and (starts_at is null or starts_at <= now())
    and not (
        case when quiet_start < quiet_end then
            extract(hour from now() at time zone 'Asia/Seoul') >= quiet_start and extract(hour from now() at time zone 'Asia/Seoul') < quiet_end
        when quiet_start > quiet_end then
            extract(hour from now() at time zone 'Asia/Seoul') >= quiet_start or extract(hour from now() at time zone 'Asia/Seoul') < quiet_end
        else false end
    )
)
order by due_at, exam_id, student_id, assignment_id;
$$;

create function public.omr_manage_reminders_v1(
    p_session_authority text, p_account_id text, p_session_generation bigint,
    p_organization_id text, p_actor_user_id text, p_command jsonb
) returns jsonb language plpgsql security definer set search_path = ''
set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare
    identity jsonb; effective jsonb; op text := p_command ->> 'op';
    exam public.omr_exams%rowtype; v_settings jsonb := p_command -> 'settings'; result jsonb;
begin
    identity := public.omr_lock_teacher_mutation_identity_v1(p_session_authority, p_account_id, p_session_generation, p_organization_id, p_actor_user_id);
    if identity is null or identity ->> 'organizationId' is distinct from p_organization_id
       or coalesce(identity ->> 'memberRole', '') not in ('owner', 'admin', 'teacher', 'assistant') then
        return jsonb_build_object('status', 'unauthorized');
    end if;
    if op = 'save_settings' then
        select * into exam from public.omr_exams where id = v_settings ->> 'examId' and organization_id = p_organization_id for update;
        if not found then return jsonb_build_object('status', 'not_found'); end if;
        if jsonb_typeof(v_settings -> 'enabled') is distinct from 'boolean'
           or coalesce(v_settings ->> 'channel', '') not in ('kakao', 'sms')
           or coalesce(v_settings ->> 'beforeMinutes', '') !~ '^[0-9]{1,5}$'
           or coalesce(v_settings ->> 'quietStart', '') !~ '^[0-9]{1,2}$'
           or coalesce(v_settings ->> 'quietEnd', '') !~ '^[0-9]{1,2}$'
           or (v_settings -> 'overdueMinutes' is distinct from 'null'::jsonb and coalesce(v_settings ->> 'overdueMinutes', '') !~ '^[0-9]{1,5}$') then
            return jsonb_build_object('status', 'invalid_request');
        end if;
        if (v_settings ->> 'enabled')::boolean then
            effective := public.omr_read_teacher_mutation_plan_v1(p_session_authority, p_account_id, p_organization_id, p_actor_user_id);
            if coalesce(effective ->> 'plan', '') not in ('pro', 'academy') then return jsonb_build_object('status', 'plan_denied'); end if;
            if exam.archived or coalesce(exam.payload #>> '{accessConfig,type}', '') not in ('group', 'targeted') then
                return jsonb_build_object('status', 'invalid_request');
            end if;
        end if;
        insert into public.omr_reminder_settings (exam_id, organization_id, enabled, channel, before_minutes, overdue_minutes,
            quiet_start, quiet_end, session_authority, account_id, session_generation, actor_user_id)
        values (exam.id, p_organization_id, (v_settings ->> 'enabled')::boolean, v_settings ->> 'channel',
            (v_settings ->> 'beforeMinutes')::integer, (v_settings ->> 'overdueMinutes')::integer,
            (v_settings ->> 'quietStart')::integer, (v_settings ->> 'quietEnd')::integer,
            p_session_authority, p_account_id, p_session_generation, p_actor_user_id)
        on conflict (exam_id) do update set enabled = excluded.enabled, channel = excluded.channel,
            before_minutes = excluded.before_minutes, overdue_minutes = excluded.overdue_minutes,
            quiet_start = excluded.quiet_start, quiet_end = excluded.quiet_end,
            session_authority = excluded.session_authority, account_id = excluded.account_id,
            session_generation = excluded.session_generation, actor_user_id = excluded.actor_user_id, updated_at = now();
        return jsonb_build_object('status', 'saved');
    elsif op = 'save_contact' then
        if not exists (select 1 from public.omr_student_profiles where id = p_command ->> 'studentId' and organization_id = p_organization_id)
           or coalesce(p_command ->> 'phone', '') !~ '^010[0-9]{8}$'
           or jsonb_typeof(p_command -> 'enabled') is distinct from 'boolean' then
            return jsonb_build_object('status', 'invalid_request');
        end if;
        insert into public.omr_reminder_contacts (organization_id, student_profile_id, phone, enabled)
        values (p_organization_id, p_command ->> 'studentId', p_command ->> 'phone', (p_command ->> 'enabled')::boolean)
        on conflict (organization_id, student_profile_id) do update
            set phone = excluded.phone, enabled = excluded.enabled, updated_at = now();
        return jsonb_build_object('status', 'saved');
    elsif op = 'preview' then
        if not exists (select 1 from public.omr_exams where id = p_command ->> 'examId' and organization_id = p_organization_id) then
            return jsonb_build_object('status', 'not_found');
        end if;
        select jsonb_build_object('status', 'loaded', 'total', count(*), 'candidates',
            coalesce(jsonb_agg(candidate) filter (where ordinal <= 100), '[]'::jsonb)) into result
        from (select candidate, row_number() over () ordinal from public.omr_reminder_candidates_v1(p_organization_id, p_command ->> 'examId', false)) rows;
        return result;
    elsif op <> 'load' or op is null then return jsonb_build_object('status', 'invalid_request'); end if;

    -- Match the application's bounded initial-operation roster rather than silently omitting students.
    if (select count(*) from public.omr_student_profiles where organization_id = p_organization_id and status = 'active') > 1000 then
        return jsonb_build_object('status', 'capacity_exceeded');
    end if;
    return jsonb_build_object('status', 'loaded', 'dashboard', jsonb_build_object(
        'exams', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'title', title, 'accessType', coalesce(payload #>> '{accessConfig,type}', 'public'), 'endAt', payload ->> 'endAt') order by updated_at desc)
            from public.omr_exams where organization_id = p_organization_id and not archived), '[]'::jsonb),
        'settings', coalesce((select jsonb_agg(jsonb_build_object('examId', exam_id, 'enabled', enabled, 'channel', channel,
            'beforeMinutes', before_minutes, 'overdueMinutes', overdue_minutes, 'quietStart', quiet_start, 'quietEnd', quiet_end))
            from public.omr_reminder_settings where organization_id = p_organization_id), '[]'::jsonb),
        'contacts', coalesce((select jsonb_agg(jsonb_build_object('studentId', s.id, 'name', s.display_name,
            'group', coalesce(s.metadata ->> 'group', ''), 'phone', coalesce(c.phone, ''), 'enabled', coalesce(c.enabled, false)) order by s.display_name, s.id)
            from public.omr_student_profiles s left join public.omr_reminder_contacts c on c.organization_id = s.organization_id and c.student_profile_id = s.id
            where s.organization_id = p_organization_id and s.status = 'active'), '[]'::jsonb),
        'deliveries', coalesce((select jsonb_agg(row_data) from (
            select jsonb_build_object('id', d.id, 'examTitle', e.title, 'studentName', s.display_name, 'phoneLast4', d.phone_last4,
                'kind', d.kind, 'status', d.status, 'createdAt', d.created_at, 'providerGroupId', d.provider_group_id) row_data
            from public.omr_reminder_deliveries d join public.omr_exams e on e.id = d.exam_id
            join public.omr_student_profiles s on s.id = d.student_profile_id and s.organization_id = d.organization_id
            where d.organization_id = p_organization_id order by d.created_at desc limit 100
        ) history), '[]'::jsonb)
    ));
exception when check_violation or invalid_text_representation or numeric_value_out_of_range then
    return jsonb_build_object('status', 'invalid_request');
end;
$$;

create function public.omr_claim_reminder_v1(p_organization_id text, p_mode text, p_channels text[])
returns jsonb language plpgsql security definer set search_path = ''
set statement_timeout = '5s' set lock_timeout = '2s' as $$
declare item jsonb; cfg public.omr_reminder_settings%rowtype; identity jsonb; effective jsonb; delivery_id uuid;
begin
    if p_mode not in ('dry_run', 'live') or p_mode is null or p_organization_id is null then return null; end if;
    -- Serializes claims for this organization's single SOLAPI account. No lease can trigger a repeat POST.
    if not pg_try_advisory_xact_lock(hashtextextended('omr_solapi:' || p_organization_id, 0)) then return null; end if;
    update public.omr_reminder_deliveries set status = 'unknown', error_code = 'worker_interrupted', updated_at = now()
        where organization_id = p_organization_id and status = 'sending' and updated_at < now() - interval '2 minutes';
    for item in select candidate from public.omr_reminder_candidates_v1(p_organization_id, null, true) c
        where candidate ->> 'channel' = any(p_channels)
        and not exists (select 1 from public.omr_reminder_deliveries d where d.organization_id = p_organization_id
            and d.exam_id = candidate ->> 'examId' and d.student_profile_id = candidate ->> 'studentId'
            and d.assignment_id = candidate ->> 'assignmentId' and d.assignment_revision = (candidate ->> 'assignmentRevision')::bigint
            and d.deadline = (candidate ->> 'deadline')::timestamptz and d.kind = candidate ->> 'kind' and d.mode = p_mode)
        limit 100
    loop
        select * into cfg from public.omr_reminder_settings where exam_id = item ->> 'examId';
        identity := public.omr_lock_teacher_mutation_identity_v1(cfg.session_authority, cfg.account_id, cfg.session_generation, p_organization_id, cfg.actor_user_id);
        if identity is null or coalesce(identity ->> 'memberRole', '') not in ('owner', 'admin', 'teacher', 'assistant') then
            update public.omr_reminder_settings set enabled = false, updated_at = now() where exam_id = cfg.exam_id;
            continue;
        end if;
        effective := public.omr_read_teacher_mutation_plan_v1(cfg.session_authority, cfg.account_id, p_organization_id, cfg.actor_user_id);
        if coalesce(effective ->> 'plan', '') not in ('pro', 'academy') then
            update public.omr_reminder_settings set enabled = false, updated_at = now() where exam_id = cfg.exam_id;
            continue;
        end if;
        -- Identity/plan locking can wait. Re-read eligibility after it, immediately before admission.
        if not exists (select 1 from public.omr_reminder_candidates_v1(p_organization_id, item ->> 'examId', true) current_candidate
            where current_candidate.candidate = item) then continue; end if;
        insert into public.omr_reminder_deliveries (organization_id, exam_id, student_profile_id, assignment_id, assignment_revision,
            deadline, kind, mode, channel, phone_last4, status)
        values (p_organization_id, item ->> 'examId', item ->> 'studentId', item ->> 'assignmentId', (item ->> 'assignmentRevision')::bigint,
            (item ->> 'deadline')::timestamptz, item ->> 'kind', p_mode, item ->> 'channel', right(item ->> 'phone', 4),
            case when p_mode = 'dry_run' then 'preview' else 'sending' end)
        on conflict do nothing returning id into delivery_id;
        if delivery_id is not null then return jsonb_build_object('id', delivery_id, 'candidate', item); end if;
    end loop;
    return null;
end;
$$;

create function public.omr_finish_reminder_v1(p_organization_id text, p_id uuid, p_status text, p_provider_group_id text, p_error_code text)
returns boolean language plpgsql security definer set search_path = '' set statement_timeout = '5s' as $$
begin
    if p_status not in ('accepted', 'failed', 'unknown') or p_status is null then return false; end if;
    update public.omr_reminder_deliveries set status = p_status, provider_group_id = left(p_provider_group_id, 128),
        error_code = left(p_error_code, 80), updated_at = now()
    where id = p_id and organization_id = p_organization_id and status = 'sending';
    return found;
end;
$$;

revoke all on function public.omr_reminder_timestamp_v1(text), public.omr_reminder_candidates_v1(text,text,boolean),
    public.omr_manage_reminders_v1(text,text,bigint,text,text,jsonb), public.omr_claim_reminder_v1(text,text,text[]),
    public.omr_finish_reminder_v1(text,uuid,text,text,text) from public, anon, authenticated;
grant execute on function public.omr_reminder_timestamp_v1(text), public.omr_reminder_candidates_v1(text,text,boolean),
    public.omr_manage_reminders_v1(text,text,bigint,text,text,jsonb), public.omr_claim_reminder_v1(text,text,text[]),
    public.omr_finish_reminder_v1(text,uuid,text,text,text) to service_role;

commit;
