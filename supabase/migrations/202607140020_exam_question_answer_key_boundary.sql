begin;

-- Relational question rows contain answer keys. The canonical exam gateway
-- stores and reads them with the service role, so browser clients must not be
-- able to query or mutate this table directly.
alter table public.omr_exam_questions enable row level security;
alter table public.omr_exam_questions force row level security;

drop policy if exists "OMR exam questions are publicly writable"
    on public.omr_exam_questions;

revoke all on table public.omr_exam_questions from anon, authenticated;
grant all on table public.omr_exam_questions to service_role;

commit;
