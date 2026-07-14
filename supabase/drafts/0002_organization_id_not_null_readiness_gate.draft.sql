-- DRAFT — NOT YET APPLIED. See supabase/drafts/README.md.
--
-- supabase/production-rls.sql's own header already says to apply it only
-- after "every production row has a non-null organization_id where the
-- table supports it" — but nothing in this repo actually checks or enforces
-- that today. This file is that check, split into two parts:
--
--   PART 1 (safe to run any time, read-only): reports how many rows in each
--   organization-scoped table currently have organization_id IS NULL.
--
--   PART 2 (commented out on purpose): the NOT NULL constraints themselves.
--   Do not uncomment/run PART 2 until PART 1 reports zero for every table
--   AND the known client-side gap below is fixed — adding NOT NULL while
--   rows are still null, or before the write path is fixed, will not error
--   destructively (existing rows aren't touched by ALTER ... SET NOT NULL
--   unless you also backfill), but it WILL start rejecting new inserts from
--   the one write path that is known to violate it today.
--
-- ---------------------------------------------------------------------------
-- PART 1 — verification (read-only, safe to run against production now)
-- ---------------------------------------------------------------------------

select
    'omr_classes' as table_name, count(*) as null_organization_id_rows
from public.omr_classes where organization_id is null
union all
select 'omr_exams', count(*) from public.omr_exams where organization_id is null
union all
select 'omr_attempts', count(*) from public.omr_attempts where organization_id is null
union all
select 'omr_question_results', count(*) from public.omr_question_results where organization_id is null
union all
select 'omr_kakao_candidate_reviews', count(*) from public.omr_kakao_candidate_reviews where organization_id is null
union all
select 'omr_kakao_dispatch_logs', count(*) from public.omr_kakao_dispatch_logs where organization_id is null
union all
select 'omr_audit_logs', count(*) from public.omr_audit_logs where organization_id is null;

-- omr_exam_questions is deliberately excluded above: production-rls.sql
-- already has a null-safe fallback for it (omr_can_read_exam_by_id /
-- omr_can_write_exam_by_id derive access from exam_id when organization_id
-- is null), so a null there does not lock rows out the way it does for the
-- tables listed above.

-- Known client-side gap that will keep PART 1's omr_kakao_* counts nonzero
-- until fixed (out of scope for this migration — application code, not SQL):
-- src/lib/kakaoCandidateReviewPersistence.ts hardcodes `organization_id: null`
-- on every row it builds (kakaoCandidateReviewToSupabaseRow /
-- kakaoDispatchLogToSupabaseRow), so every write through that module violates
-- the constraint below today. Route it through the same workspace-context
-- scoping src/lib/omrPersistence.ts and src/lib/rosterPersistence.ts already
-- use before enabling NOT NULL on these two tables.

-- ---------------------------------------------------------------------------
-- PART 2 — enforcement (DO NOT RUN until PART 1 is all zeros and the Kakao
-- client gap above is fixed). Left commented out intentionally.
-- ---------------------------------------------------------------------------

-- begin;
--
-- alter table public.omr_classes alter column organization_id set not null;
-- alter table public.omr_exams alter column organization_id set not null;
-- alter table public.omr_attempts alter column organization_id set not null;
-- alter table public.omr_question_results alter column organization_id set not null;
-- alter table public.omr_kakao_candidate_reviews alter column organization_id set not null;
-- alter table public.omr_kakao_dispatch_logs alter column organization_id set not null;
-- alter table public.omr_audit_logs alter column organization_id set not null;
--
-- commit;
