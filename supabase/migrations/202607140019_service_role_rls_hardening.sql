begin;

-- Canonical grading data is only accessed through trusted service-role
-- gateways. FORCE RLS prevents table-owner code paths from accidentally
-- bypassing that boundary while service_role keeps its PostgreSQL BYPASSRLS
-- behavior.
alter table public.omr_exams enable row level security;
alter table public.omr_exams force row level security;
alter table public.omr_attempts enable row level security;
alter table public.omr_attempts force row level security;
alter table public.omr_question_results enable row level security;
alter table public.omr_question_results force row level security;
alter table public.omr_attempt_feedback enable row level security;
alter table public.omr_attempt_feedback force row level security;

-- Feedback was introduced after the original student-attempt hardening and
-- still inherited the alpha-era public policy. Keep it behind the server
-- gateway just like attempts and question results.
drop policy if exists "OMR attempt feedback is publicly writable"
    on public.omr_attempt_feedback;

revoke all on table public.omr_attempt_feedback from anon, authenticated;
grant all on table public.omr_attempt_feedback to service_role;

commit;
