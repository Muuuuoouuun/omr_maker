begin;

-- Canonical exams and grading rows contain answer keys and cross-student data.
-- They are reachable only through server-side service-role gateways. Browser
-- publishable-key clients must not be able to bypass the safe DTO projection.
alter table public.omr_exams enable row level security;
alter table public.omr_attempts enable row level security;
alter table public.omr_question_results enable row level security;

drop policy if exists "OMR exams are publicly readable" on public.omr_exams;
drop policy if exists "OMR exams are publicly writable" on public.omr_exams;
drop policy if exists "OMR attempts are publicly readable" on public.omr_attempts;
drop policy if exists "OMR attempts are publicly writable" on public.omr_attempts;
drop policy if exists "OMR question results are publicly readable" on public.omr_question_results;
drop policy if exists "OMR question results are publicly writable" on public.omr_question_results;

revoke all on table public.omr_exams from anon, authenticated;
revoke all on table public.omr_attempts from anon, authenticated;
revoke all on table public.omr_question_results from anon, authenticated;

grant all on table public.omr_exams to service_role;
grant all on table public.omr_attempts to service_role;
grant all on table public.omr_question_results to service_role;

commit;
