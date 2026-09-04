# Database Convergence and Performance Design

**Date:** 2026-09-04  
**Status:** Approved design; pending written-spec review  
**Target:** The Supabase project configured by `.env.local` and the repository's PostgreSQL 17 contract

## 1. Purpose

Bring the connected Supabase database into exact compatibility with the current application before
making evidence-backed query-path improvements. The work treats schema drift as the first production
incident: the application expects the `202608090001` readiness contract, while the connected database
reports `202607140018` and is missing required RPCs and tables.

The result must be recoverable, tenant-safe, and measurable. No production DDL is allowed through a
service-role HTTP key. Database changes require the migration-owner PostgreSQL connection, a verified
backup, an isolated restore rehearsal, and explicit preflight evidence.

## 2. Audit evidence

The 2026-09-04 read-only audit established the following baseline:

- The connected database reports readiness version `202607140018` with 21 boolean checks.
- The repository requires readiness version `202608090001` with 52 boolean checks.
- `omr_load_roster_v2(text)` returns PostgREST error `PGRST202`, so the current application roster
  gateway cannot operate against the connected database.
- Sixteen of the repository's 43 canonical tables are absent from the connected database.
- Representative connected API reads have median client-observed latency of approximately 56–144 ms.
  That sample is useful as a post-change comparison, but it is not a substitute for server execution
  statistics.
- The configured service-role key permits bounded read-only API diagnostics. The configured direct
  database URLs/password are placeholders and cannot authenticate as the migration owner.
- A clean PostgreSQL 17 run of schema, sorted migrations, production boundary, rollback, boundary
  reapplication, live assertions, and 19 release proofs passes.
- The final local schema contains 43 canonical tables, 181 canonical indexes, and 194 canonical
  functions, with no exact duplicate indexes.
- Eighteen foreign keys have no index whose leading columns match the referencing columns. Every one
  participates in `CASCADE`, `SET NULL`, or `RESTRICT` parent-row handling.
- The application pages general attempt lists by
  `(organization_id, finished_at DESC, id DESC)`, but the existing general indexes end in `id ASC`.
  On a 10,000-attempt synthetic PostgreSQL 17 fixture, the planner chose the global `finished_at`
  index plus an incremental sort instead of the organization-scoped index. The exact completed,
  exam-scoped partial index used an index scan directly.

## 3. Selected approach

Use a **convergence-first, two-gate rollout**.

1. Build read-only drift and performance evidence without changing the connected database.
2. Require a real non-pooling migration-owner connection and create a restorable backup.
3. Restore the backup into an isolated PostgreSQL/Supabase-compatible target.
4. Prove the connected database's exact starting generation, then apply only the ordered migration
   suffix after `202607140018`.
5. Apply the production server boundary and run the complete PostgreSQL release contract on the
   restored target.
6. Apply a separate, idempotent performance-index migration and rerun correctness and plan checks.
7. Repeat the rehearsed sequence on the configured Supabase project during a maintenance window.
8. Reload the PostgREST schema cache, verify readiness `202608090001`, and exercise the teacher and
   student server-gateway smoke paths before reopening writes.

This separates compatibility recovery from optional physical optimization. A failed compatibility
gate therefore stops before new performance indexes are introduced.

### Alternatives rejected

**One-shot convergence and optimization** is faster but makes it difficult to distinguish a data,
permission, migration, or index failure and expands the rollback surface.

**Performance-only code changes** leave the application pointed at a database that cannot satisfy its
required RPC contract. Faster queries cannot repair the current hard incompatibility.

**Blindly replaying every historical migration** is unsafe because the project has been managed
manually and has no trustworthy migration ledger for this target. The rollout must first attest the
known `202607140018` shape and reject partial or unexpected later objects.

## 4. Components

### 4.1 Read-only database audit

Add a bounded diagnostic command that accepts the existing PostgreSQL connection variables and runs
with `default_transaction_read_only=on`, a statement timeout, and a lock timeout. It reports only:

- server/readiness generation and canonical object counts;
- missing or unexpected canonical tables and required RPC signatures;
- invalid, not-ready, exact-duplicate, and unused-index candidates;
- foreign keys without a leading supporting index;
- table/index sizes, live/dead tuple estimates, sequential/index scan counts, and autovacuum times;
- normalized `pg_stat_statements` query identifiers and aggregate timings when the extension is
  available; and
- `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` output for a fixed allowlist of read-only query templates.

The command must never print connection strings, credentials, raw row values, organization IDs,
student identifiers, names, emails, answers, or unnormalized SQL literals. It must fail closed when
the connection is a placeholder, is not read-only, or lacks the required catalog privileges.

### 4.2 Starting-state attestation

Before any migration, a SQL preflight asserts all of the following:

- readiness version is exactly `202607140018`;
- the 27 expected canonical tables for that generation exist and the 16 later tables do not;
- the expected early gateway signatures exist;
- no known later-generation gateway signature is partially installed;
- organization-integrity checks for null scope, orphan rows, cross-organization rows, and students
  without credentials are bounded and return zero; and
- the session user is the PostgreSQL migration owner, not `service_role`, `anon`, or
  `authenticated`.

Any mismatch stops the rollout and produces a redacted inventory for review. The migration suffix is
never inferred from a single version string alone.

### 4.3 Compatibility convergence

After the attestation passes, apply migrations in filename order beginning with
`202607140019_service_role_rls_hardening.sql` and ending with
`202608100003_assignment_generation_alias_fix.sql`. Apply
`production-server-boundary.sql` only after the migration suffix succeeds and its preflight returns
all-zero integrity counts.

The server boundary remains the authoritative security profile. `production-rls.sql` is not applied.
The application build is not promoted before the database contract is ready. PostgREST receives a
schema reload notification after all committed DDL.

### 4.4 Query-path index migration

Create an idempotent, non-transactional migration suitable for concurrent index creation. It adds two
exact mixed-direction indexes without dropping the existing indexes during this rollout:

- `omr_attempts (organization_id, finished_at DESC, id DESC)`;
- `omr_attempts (organization_id, exam_id, finished_at DESC, id DESC)`.

Keeping the old `id ASC` variants makes the first rollout additive and recoverable. They become drop
candidates only after production `pg_stat_user_indexes` evidence covers a representative usage
window.

The same migration adds leading indexes for the 18 currently uncovered foreign keys:

- assignments: `class_id`, `exam_id`;
- assignment targets: `class_id`, `student_profile_id`;
- assignment submissions: `attempt_id`, `exam_id`, `organization_id`;
- attempt feedback: `exam_id`;
- Kakao dispatch logs: `organization_id`;
- comments: `organization_id`, `student_profile_id`;
- remote assets: `attempt_id`, `exam_id`, `handwriting_reservation_grant_id`;
- attempt sessions: `exam_id`, `retake_source_attempt_id`, `submitted_attempt_id`;
- exam mutations: `exam_id`.

These indexes protect parent update/delete enforcement from full scans. They do not change logical
results, RLS, grants, RPC signatures, or the readiness version. Index creation is individually
idempotent so an interrupted concurrent build can be inspected, removed if invalid, and resumed.

### 4.5 Contract and plan assertions

Extend the live PostgreSQL contract to verify that every new index:

- exists on the intended table;
- is valid and ready;
- has the exact access method, leading column order, sort direction, and predicate;
- is not satisfied by a wrong-table or expression-index impostor; and
- is usable by the representative organization, organization/exam, roster, and parent-delete query
  shapes.

Planner tests use deterministic synthetic fixtures at the supported operating ceiling and a larger
growth fixture. Timing is recorded for comparison, but assertions use plan shape and bounded work
rather than fragile wall-clock thresholds.

## 5. Data and control flow

The rollout flow is:

`read-only audit → owner credential check → backup → isolated restore → starting-state attestation →`
`migration suffix → production boundary → compatibility verification → index migration → plan/load`
`verification → maintenance mode → production replay → schema-cache reload → smoke tests → reopen`.

Application data continues to flow through existing Next.js server gateways and purpose-scoped RPCs.
No browser data path or response schema changes. The physical indexes are invisible to callers.

## 6. Failure handling and rollback

- A missing migration-owner credential blocks external DDL but does not block repository
  implementation or local verification.
- A failed backup, restore, starting-state attestation, integrity preflight, or compatibility test
  stops before production changes.
- A failed migration file stops the ordered suffix. Do not skip the file or continue to the boundary.
- A failed concurrent index build is detected through `pg_index.indisvalid/indisready`; remove only
  the named invalid index and rerun the idempotent index migration.
- If compatibility changes fail before writes reopen, use the already verified
  `production-server-boundary-rollback.sql` where the failure is limited to the boundary. Use the
  pre-change database backup for schema/data failures outside that boundary.
- If post-open smoke tests fail, return to maintenance mode before rollback or restore. Never run the
  old application against a partially converged database.

No automated rollback deletes or rewrites production data. Recovery remains an explicit operator
action against the exact recorded target and backup.

## 7. Verification and success criteria

Repository verification must pass:

- focused SQL/source contract tests for the new audit command and migration;
- the complete Vitest suite;
- lint and TypeScript/build checks required by the repository;
- `npm run test:supabase:live` on PostgreSQL 17;
- starting-state rejection fixtures for partial and unexpected database generations;
- deterministic planner fixtures for both attempt list paths and all foreign-key support checks; and
- backup/restore qualification using the existing operational scripts.

Connected-target success requires:

- a recorded, restorable pre-change backup;
- 43/43 canonical tables and no unexpected canonical relation types;
- readiness version `202608090001`, all 52 required checks true, and database-declared readiness true;
- `omr_load_roster_v2`, attempt reporting, student session, notification, and assignment-generation
  gateways available through the exact required signatures;
- production browser privileges denied and service-role server journeys passing;
- every new index valid and ready;
- representative API latency no worse than the pre-change sample, with no hard 404/contract errors;
  and
- recorded commit SHA, schema/boundary hashes, target identity, operator, timestamps, test evidence,
  and rollback reference.

## 8. Scope boundaries

This work does not add a new datastore, ORM, cache, queue, analytics warehouse, billing model, product
feature, or unbounded administrative endpoint. It does not remove existing indexes based only on a
synthetic fixture. It does not deploy application code or reopen production writes unless the exact
database contract and smoke gates pass.

The first implementation milestone is repository-complete and locally verified. Applying changes to
the connected Supabase project is a separate execution milestone that begins only when the real
non-pooling migration-owner credential and backup destination are available.
