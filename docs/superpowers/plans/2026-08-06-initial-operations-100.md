# Initial Operations for 100 Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the payment-excluded first release operationally safe and diagnosable for at most 100 active users while making the student and teacher core journeys genuinely continuous across fresh browser/device contexts.

**Architecture:** Keep the existing Next.js Server Action and Supabase service-role boundary. Add explicit initial-capacity limits, bounded backend timeouts, authenticated readiness probes, direct-to-Storage uploads for large PDFs, and a Postgres-backed cross-instance abuse limiter. Preserve local/offline fallbacks only outside production and keep the existing payment adapter blocked but connection-ready.

**Tech Stack:** Next.js 16 Server Actions and route handlers, React 19, TypeScript, Supabase/PostgreSQL 17, Vitest, Playwright.

---

## Release rubric

Every dimension must score at least 8.4 and the weighted mean must be at least 8.9. A score is evidence-based: a passing unit/contract/E2E test or a verified production probe is required for every claim. Any open P0 below caps the release below 8.4 regardless of the arithmetic result.

| Dimension | Weight | Required evidence |
|---|---:|---|
| Student core journey | 20% | login/guest, fresh-device share return, server autosave/resume, exactly-once submit, history/review/retake tests |
| Teacher core journey | 20% | login, cross-device draft/create/publish/distribute, live progress, roster, results/core feedback/statistics/CSV tests |
| Data integrity and tenant isolation | 20% | PostgreSQL live contract, atomic RPC and cross-tenant denial tests |
| Operational stability | 15% | bounded timeouts, authenticated readiness, fail-closed production behavior |
| Capacity and performance | 15% | bounded/paged reads, direct PDF upload, 100-user smoke budget |
| Observability and recovery | 10% | structured redacted errors, request correlation, backup/rollback runbook |

### Audit-driven hard gates

- [ ] Authenticated student work is persisted server-side with revision-aware reconciliation; guest mode is explicitly device-only.
- [ ] Opening and answering an exam produces a real server draft/heartbeat visible to the teacher, and force-finish closes exactly one canonical attempt.
- [ ] A copied group-share URL carries opaque workspace context through fresh-device login and returns to the exact exam.
- [ ] Teacher drafts are server-owned and separate from publishing; unpublished exams are never discoverable by students.
- [x] Plain-text feedback and read receipt are core/free; premium gating applies only to markup/PDF features.
- [ ] Canonical list reads are scoped and bounded, notification/list DTOs do not move full markup/PDF-shaped payloads, and overflow is explicit.
- [ ] Large PDFs upload browser-to-private-Storage with idempotent finalize and orphan cleanup; binary bodies do not cross Server Actions.
- [ ] Public login, student start-code, exam PIN, AI, and readiness abuse controls share a durable cross-instance budget.
- [ ] Hosted Supabase boundary, negative access tests, error sink/alerts, backup restore drill, and retry queues have dated evidence before real data.

## Task 1: Initial-capacity policy and bounded Supabase transport

**Files:**
- Create: `src/lib/initialOperationsPolicy.ts`
- Create: `src/lib/initialOperationsPolicy.test.ts`
- Modify: `src/lib/supabaseServerAdmin.ts`
- Modify: `src/lib/supabaseServerAdmin.test.ts`

- [ ] **Step 1: Write failing policy tests**

```ts
expect(INITIAL_OPERATIONS_LIMITS.activeStudents).toBe(100);
expect(INITIAL_OPERATIONS_LIMITS.teacherAttempts).toBeGreaterThanOrEqual(1000);
expect(normalizeBackendTimeoutMs("1")).toBe(3_000);
expect(normalizeBackendTimeoutMs("9000")).toBe(9_000);
expect(normalizeBackendTimeoutMs("999999")).toBe(20_000);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx vitest run src/lib/initialOperationsPolicy.test.ts src/lib/supabaseServerAdmin.test.ts`

Expected: FAIL because the policy and timeout-aware fetch do not exist.

- [ ] **Step 3: Implement explicit limits and an AbortController-backed fetch**

The policy must expose the 100-user contract, defensive list ceilings, page size, default timeout, and timeout clamp. `createSupabaseAdminClient` must pass a custom fetch that aborts every Supabase HTTP request at the configured deadline without automatically retrying mutations.

- [ ] **Step 4: Verify GREEN**

Run: `npx vitest run src/lib/initialOperationsPolicy.test.ts src/lib/supabaseServerAdmin.test.ts`

Expected: all focused tests pass with no unhandled rejection.

## Task 2: Bound every first-release canonical list read

**Files:**
- Modify: `src/lib/teacherExamGateway.ts`
- Modify: `src/lib/teacherExamGateway.test.ts`
- Modify: `src/lib/teacherAttemptGateway.ts`
- Modify: `src/lib/teacherAttemptGateway.test.ts`
- Modify: `src/lib/teacherRosterGateway.ts`
- Modify: `src/lib/teacherRosterGateway.test.ts`
- Modify: `src/lib/studentAttemptReadGateway.ts`
- Modify: `src/lib/studentAttemptReadGateway.test.ts`
- Modify: `src/lib/supabaseServerAdmin.ts`
- Modify: `src/lib/supabaseServerAdmin.test.ts`

- [ ] **Step 1: Write failing query-bound tests**

Each list-query mock records `.limit()` or `.range()` calls. Tests must prove organization/owner filters are applied before the bound and must prove an over-cap response fails loudly instead of returning silently incomplete analytics.

```ts
expect(queryCalls).toContainEqual(["limit", INITIAL_OPERATIONS_LIMITS.teacherExams + 1]);
expect(result).toMatchObject({ status: "service_unavailable", error: "initial_capacity_exceeded" });
```

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/lib/teacherExamGateway.test.ts src/lib/teacherAttemptGateway.test.ts src/lib/teacherRosterGateway.test.ts src/lib/studentAttemptReadGateway.test.ts src/lib/supabaseServerAdmin.test.ts`

Expected: FAIL because current queries are unbounded in application code.

- [ ] **Step 3: Add bounded reads**

Use `limit + 1` for exams, classes, students, enrollments and invites so the application detects capacity overflow. Use deterministic `.range()` paging for attempt history because Supabase may cap a response at 1,000 rows. Preserve sort order and tenant/owner filters on every page. Return the existing service-unavailable shape with the stable code `initial_capacity_exceeded` when a ceiling is crossed.

- [ ] **Step 4: Verify GREEN and SQL index alignment**

Run the focused tests, then `npm run test:supabase:live`.

Expected: all focused tests and the PostgreSQL 17 contract pass.

## Task 3: Authenticated liveness/readiness and structured redacted errors

**Files:**
- Create: `src/lib/operationsHealth.ts`
- Create: `src/lib/operationsHealth.test.ts`
- Create: `src/app/api/healthz/route.ts`
- Create: `src/app/api/readyz/route.ts`
- Modify: `src/lib/reportError.ts`
- Create: `src/lib/reportError.test.ts`
- Modify: `docs/production-readiness.md`

- [ ] **Step 1: Write failing health and logging tests**

```ts
expect(buildLivenessPayload(env)).toMatchObject({ status: "alive" });
expect(authorizeReadinessRequest(new Headers(), env)).toBe(false);
expect(redactOperationalError({ password: "secret", studentName: "Kim" }))
  .not.toContain("secret");
```

Tests must also cover missing readiness token, malformed bearer header, missing Supabase config, probe timeout, failed DB checks, `Cache-Control: no-store`, and 200/401/503 status selection.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/lib/operationsHealth.test.ts src/lib/reportError.test.ts`

Expected: FAIL because the operational health contract and redaction do not exist.

- [ ] **Step 3: Implement minimal operational endpoints**

`/api/healthz` exposes only liveness, build SHA and timestamp. `/api/readyz` requires `OMR_READINESS_TOKEN`, uses timing-safe token comparison, calls the existing service-role readiness probe, and never returns database samples or secret values. `reportError` emits one-line JSON with a stable event name and correlation id while redacting credential, token, cookie, student name/email and raw payload fields.

- [ ] **Step 4: Verify GREEN**

Run focused tests and `npm run build`. Use `curl` against `next start` to verify 200 liveness, 401 readiness without the token, and fail-closed 503 when the backend is not configured.

## Task 4: Direct-to-private-Storage teacher PDF upload

**Files:**
- Modify: `src/lib/remoteAssetContract.server.ts`
- Modify: `src/lib/remoteAssetContract.server.test.ts`
- Modify: `src/lib/remoteAssetGateway.server.ts`
- Modify: `src/lib/remoteAssetGateway.server.test.ts`
- Modify: `src/app/actions/remoteAssets.ts`
- Create: `src/lib/remoteAssetUploadClient.ts`
- Create: `src/lib/remoteAssetUploadClient.test.ts`
- Modify: `src/app/create/page.tsx`
- Modify: `src/app/create/page.test.ts`
- Modify: `next.config.ts`

- [ ] **Step 1: Write failing prepare/upload/finalize tests**

Cover same-origin and signed-teacher authorization, owner-exam checks, safe path generation, size/MIME rejection, one-time signed upload preparation, browser upload error, Storage object info verification, metadata finalization, and object cleanup when finalization fails.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run src/lib/remoteAssetContract.server.test.ts src/lib/remoteAssetGateway.server.test.ts src/lib/remoteAssetUploadClient.test.ts src/app/create/page.test.ts`

Expected: FAIL because only server-buffered FormData upload exists.

- [ ] **Step 3: Implement the three-stage upload**

The Server Action prepares an organization/exam-scoped signed upload URL. The browser uploads the `File` directly to `omr-private-assets` with the public Supabase key and returned token. A second Server Action verifies object path, byte size and MIME through the service role before saving metadata. Keep the current local IndexedDB fallback in non-production only. Remove the 52 MB Server Action allowance once teacher PDFs no longer traverse the action body.

- [ ] **Step 4: Verify GREEN and browser behavior**

Run focused tests, build, then a Playwright create-page upload test proving no PDF bytes are posted to a Next Server Action.

## Task 5: Durable cross-instance abuse controls

**Files:**
- Create: `supabase/migrations/202608060001_durable_rate_limits.sql`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `supabase/migrations/202607280003_service_readiness_probe_v4.sql`
- Create: `src/lib/durableRateLimit.ts`
- Create: `src/lib/durableRateLimit.test.ts`
- Modify: `src/app/actions/auth.ts`
- Modify: `src/app/actions/studentSession.ts`
- Modify: `src/app/actions/studentExam.ts`
- Modify: `src/app/actions/ai.ts`

- [ ] **Step 1: Write failing SQL and TypeScript contract tests**

Tests cover atomic counters, window expiry, lockout, cross-instance visibility, hashed keys only, bounded cleanup, service-role-only grants and fail-closed production behavior. No raw identifier, IP, email, exam id or student id may be stored.

- [ ] **Step 2: Verify RED**

Run the focused Vitest file and `npm run test:supabase:live`.

Expected: FAIL because the durable rate-limit table/RPC and gateway do not exist.

- [ ] **Step 3: Implement Postgres-backed limits**

Reuse existing per-identity and global policies but store only SHA-256 keys. Keep in-memory injectable stores for deterministic unit tests and local development. Production teacher login, student login, exam PIN and AI actions must fail closed when the durable limiter is unavailable.

- [ ] **Step 4: Verify GREEN**

Run focused tests and the live PostgreSQL contract, including two independent clients observing the same lockout.

## Task 6: Server-owned student draft, heartbeat and exactly-once closure

**Files:**
- Create: `supabase/migrations/202608060002_student_attempt_drafts.sql`
- Create: `src/lib/studentAttemptDraftGateway.server.ts`
- Create: `src/lib/studentAttemptDraftGateway.server.test.ts`
- Modify: `src/app/actions/studentExam.ts`
- Modify: `src/app/solve/[id]/page.tsx`
- Modify: `src/app/teacher/live/page.tsx`
- Modify: `supabase/live-test-assertions.sql`

- [ ] Write RED tests for opening, revisioned save, heartbeat, two-device resume, conflict resolution, force-finish and atomic final closure.
- [ ] Store answers/progress/timing using owner-bound draft IDs. Do not store raw guest drafts server-side without a signed owner identity.
- [ ] Reconcile local and server state deterministically; explain device-only recovery in guest UI.
- [ ] Prove two concurrent submissions close one draft and create one attempt/result set.

## Task 7: Server teacher drafts and fresh-device share context

**Files:**
- Create: `supabase/migrations/202608060003_exam_lifecycle_and_share_context.sql`
- Modify: `src/lib/teacherExamGateway.ts`
- Modify: `src/app/actions/teacherExam.ts`
- Modify: `src/app/create/page.tsx`
- Modify: `src/lib/shareLink.ts`
- Modify: `src/app/student/login/page.tsx`
- Modify: `src/app/actions/studentSession.ts`

- [ ] Write RED tests for `draft | published | archived`, cross-device resume, student invisibility before publish, and a fresh-context copied share URL.
- [ ] Persist an opaque workspace/invite slug through login and validated return-to-exam redirects; never expose organization IDs directly.
- [ ] Keep server draft save independent from publish and preserve existing canonical publish idempotency.

## Task 8: Core feedback, lightweight notifications and roster concurrency

**Files:**
- Create: `supabase/migrations/202608060004_feedback_summary_and_roster_revision.sql`
- Modify: `src/lib/feedbackServerGateway.ts`
- Modify: `src/lib/feedbackServerGateway.test.ts`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`
- Modify: `src/components/NotificationBell.tsx`
- Modify: `src/lib/teacherRosterGateway.ts`
- Modify: `src/app/actions/teacherRoster.ts`

- [x] Write RED tests proving plain-text feedback/return/read receipt works without premium markup entitlement.
- [ ] Add feedback summary projections/caps that exclude `markup_drawings`; load drawings only on detail and enforce a serialized markup size guard.
- [ ] Make notification counts server-sourced with `asOf`, source and stale/error state; local cache is a visibly stale fallback only.
- [ ] Add expected roster revision/CAS so concurrent whole-snapshot edits conflict visibly instead of overwriting silently.

## Task 9: Secret/session hardening and retry scheduling

**Files:**
- Create: `src/lib/productionSecretPolicy.ts`
- Modify: `src/lib/teacherServerSession.ts`
- Modify: `src/lib/studentServerSession.ts`
- Modify: `src/lib/studentAttemptTicket.ts`
- Modify: `src/lib/teacherAuth.ts`
- Modify: `src/lib/studentAttemptReceipt.ts`
- Modify: `src/lib/studentSubmissionFlush.ts`
- Modify: `src/components/SyncFlusher.tsx`
- Modify: `src/lib/studentQuestionOutbox.ts`

- [ ] Write RED tests for 32-byte secret quality, key IDs/rotation grace, session future skew/maximum TTL and constant-work unknown teacher verification.
- [ ] Production plaintext passwords fail readiness. Short-lived/versioned sessions must support revocation.
- [ ] Persist retry count, next retry time and sanitized failure category; schedule capped exponential backoff with jitter and alert on stuck queues.

## Task 10: Hosted handoff, error sink and backup/restore evidence

**Files:**
- Create: `scripts/verify-production-deployment.mjs`
- Create: `.github/workflows/production-readiness.yml`
- Create: `docs/operations/release-evidence-template.md`
- Create: `docs/operations/backup-restore-runbook.md`
- Create: `scripts/verify-restored-environment.mjs`
- Modify: `src/lib/reportError.ts`
- Create: `src/instrumentation.ts`
- Create: `src/instrumentation-client.ts`
- Modify: `docs/production-readiness.md`

- [ ] Verify the target hosted project, runtime probe version, anon/authenticated denials and service-role journeys; environment flags alone never count as proof.
- [ ] Emit redacted structured events with correlation/deployment IDs and stable public error codes. Configure a real provider via environment adapter and fail readiness when production alert delivery is absent.
- [ ] Define RPO/RTO, database/private-asset/secrets recovery, owners and rollback; execute and retain a staging restore-smoke artifact.
- [ ] Remove active instructions that recommend the obsolete authenticated-browser RLS profile.

## Task 11: Initial-load gate and multi-context core browser proof

**Files:**
- Create: `scripts/verify-initial-operations.mjs`
- Create: `scripts/verify-initial-operations.test.ts`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Create: `docs/initial-operations-runbook.md`
- Modify: `docs/production-readiness.md`
- Create: `e2e/initial-core-journeys.spec.ts`
- Create: `e2e/initial-cross-device.spec.ts`

- [ ] **Step 1: Write failing verifier tests**

The verifier must enforce: health/readiness status, p95 public-route budget, bounded concurrent read budget, no 5xx, production security headers, and explicit skip/failure when required credentials are missing. It must never create production student/exam data.

- [ ] **Step 2: Verify RED**

Run: `npx vitest run scripts/verify-initial-operations.test.ts`

Expected: FAIL because the verifier does not exist.

- [ ] **Step 3: Implement the verifier, runbook and E2E proof**

Add `npm run test:ops:initial`. The runbook defines deploy, readiness, backup, rollback, incident triage, restore drill, capacity alarm and secret rotation. Browser proof uses two fresh contexts and live disposable data: teacher draft/publish/distribute/live/results/feedback/statistics/CSV and student share-login-or-guest/open/server-autosave/cross-device-resume/submit/history/review/retake.

The repeatable load gate runs 100 mixed virtual users, including 10 live teacher pollers, 80 concurrent idempotent submissions and 10 concurrent maximum-size direct uploads. Budgets: no 5xx, p95 gateway reads under 750 ms, submit RPC under 1.5 s excluding client upload, stable application RSS, list responses under 5 MiB and no query over 500 ms. Missing hosted credentials produces an explicit unverified failure, never a pass.

- [ ] **Step 4: Final verification**

Run:

```bash
npm test
npm run lint
npx tsc --noEmit
npm run test:supabase:live
npm run build
npm run test:e2e -- --project=chromium e2e/initial-core-journeys.spec.ts
npm run test:ops:initial
npm audit --omit=dev --audit-level=high
```

Expected: every command exits 0; the scoring report shows no dimension below 8.4 and a weighted mean at or above 8.9.

## Explicitly not in this release

- Live payment checkout, webhook and refund processing. Existing provider boundaries remain blocked and connection-ready.
- Real Kakao/Web Push delivery. Candidate review and truthful simulation remain; provider delivery is a later integration.
- Multi-teacher workspace, SSO, public API, custom domain, organization dashboard and contract/SLA features.
- Scale claims above 100 active users. Crossing the initial capacity contract requires query aggregation, queue workers and a new load test.
