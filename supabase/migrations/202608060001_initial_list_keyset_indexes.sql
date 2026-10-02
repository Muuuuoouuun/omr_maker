begin;

-- Bounded initial-list reads traverse immutable ids after equality scopes.
-- Keep the older finished_at indexes for latest-first analytics paths.
create index if not exists omr_attempts_org_id_idx
    on public.omr_attempts (organization_id, id);

create index if not exists omr_attempts_org_exam_id_idx
    on public.omr_attempts (organization_id, exam_id, id);

create index if not exists omr_attempts_owner_id_idx
    on public.omr_attempts (student_id, id);

create index if not exists omr_attempts_student_completed_id_idx
    on public.omr_attempts (organization_id, student_profile_id, student_id, id)
    where status = 'completed';

commit;
