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
--   Do not uncomment/run PART 2 until PART 1 reports zero for every table.
--   Adding NOT NULL while rows are still null is not destructive (existing
--   rows aren't touched by ALTER ... SET NOT NULL unless you also backfill),
--   but it WILL start rejecting new inserts from any write path that still
--   sends null.
--
--   UPDATE 2026-07-29: the client-side Kakao gap this file used to warn about
--   is closed. It was real when written (2026-07-14 15:20) and was fixed four
--   hours later the same day, when actions/kakaoReview.ts started stamping
--   organization_id from the signed teacher session — so the warning below was
--   stale, not wrong. Every current write path scopes correctly; see the
--   "write paths" note under PART 1.
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

-- Write paths (verified 2026-07-29) — all organization-scoped, none send null:
--   omr_exams / omr_attempts / omr_question_results / omr_classes
--     src/lib/omrPersistence.ts, src/lib/rosterPersistence.ts — workspace context
--     applied at row-build time.
--   omr_kakao_candidate_reviews / omr_kakao_dispatch_logs
--     src/app/actions/kakaoReview.ts is the only writer, and it stamps
--     organization_id from the signed teacher session, overriding whatever the
--     caller sent. The client builders in
--     src/lib/kakaoCandidateReviewPersistence.ts no longer emit the column at
--     all (KakaoRowDraft<Row> = Omit<Row, "organization_id">), so there is no
--     placeholder value left to leak into a row.
--
-- What PART 1 can still find is HISTORY, not a live bug: rows written before
-- the fixes above may carry null. Those need a backfill, not a code change.
-- Backfill first, re-run PART 1, then consider PART 2.

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
