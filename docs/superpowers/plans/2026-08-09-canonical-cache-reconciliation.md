# Canonical Cache and Assignment Lifecycle Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task with a fresh implementer, specification review, and code-quality review for each task.

**Goal:** Eliminate cross-tenant degraded-cache disclosure and stale assignment UI while preserving the strict canonical load-state and read-only degradation contracts already qualified on `codex/initial-ops-100`.

**Architecture:** Server actions and clients return exact collection metadata; a new tenant-scoped cache module stores bounded redacted projections only. Teacher screens retain rich fresh data but materialize summaries from cache during outages, guarded by an identity fence and a child-level read-only capability. Student assignment rows use the same server timestamp used for classification and a monotonic boundary clock.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Playwright, PostgreSQL 17 contract tests, localStorage with strict JSON codecs.

---

## Task 1: Make remote collection reads exact and side-effect-free

**Files:**
- Modify: `src/app/actions/teacherExam.ts`
- Modify: `src/app/actions/teacherAttempts.ts`
- Modify: `src/app/actions/teacherRoster.ts`
- Modify: `src/lib/teacherExamGateway.ts`
- Modify: `src/lib/teacherAttemptGateway.ts`
- Modify: `src/lib/teacherRosterGateway.ts`
- Modify: `src/lib/teacherExamClient.ts`
- Modify: `src/lib/teacherAttemptClient.ts`
- Modify: `src/lib/teacherRosterClient.ts`
- Test: `src/lib/teacherExamGateway.test.ts`
- Test: `src/lib/teacherAttemptGateway.test.ts`
- Test: `src/lib/teacherRosterGateway.test.ts`
- Test: `src/lib/teacherExamClient.test.ts`
- Test: `src/lib/teacherAttemptClient.test.ts`
- Test: `src/lib/teacherRosterClient.test.ts`
- Create: `src/lib/canonicalReadActionContract.test.ts`

- [ ] **Step 1: Add failing metadata and all-or-none tests**

Add RED cases requiring successful collection responses to include this exact metadata:

```ts
type CanonicalCollectionMeta = {
  organizationId: string;
  loadedAt: string;
  rawCount: number;
  parsedCount: number;
};
```

Cover wrong-organization rows, one malformed row among valid rows, partial/has-more pages, noncanonical UTC timestamps, and `rawCount !== parsedCount`. Assert zero usable rows on every invalid response.

- [ ] **Step 2: Prove roster reads have no storage side effect**

Add a client test with a throwing `setItem`. `loadTeacherRosterSnapshot` must return a remote candidate without calling `setItem`; a separate `persistTeacherRosterCandidate` call may write only after caller authorization.

- [ ] **Step 3: Run the focused RED suite**

Run:

```bash
npx vitest run src/lib/teacherExamGateway.test.ts src/lib/teacherAttemptGateway.test.ts src/lib/teacherRosterGateway.test.ts src/lib/teacherExamClient.test.ts src/lib/teacherAttemptClient.test.ts src/lib/teacherRosterClient.test.ts src/lib/canonicalReadActionContract.test.ts
```

Expected: new exact-metadata and side-effect tests fail for missing production behavior.

- [ ] **Step 4: Implement exact parsing and stable public errors**

Parse each row once, retain the raw row count, reject rather than `flatMap`/filter malformed values, and validate every row's organization against the authorized context. Set `loadedAt` once on the server after a complete read. Return stable status codes/messages; route raw exceptions through the existing allowlisted server reporter only.

- [ ] **Step 5: Split roster read from persistence**

Return a typed remote candidate containing snapshot, revision, and metadata. Keep local fallback reads available, but move `writeLocalRosterSnapshot`, tombstone reset, and revision writes behind an explicit post-fence persistence function.

- [ ] **Step 6: Verify and commit Task 1**

Run the focused command, `npx tsc --noEmit`, scoped ESLint, and `git diff --check`. Commit only Task 1 files:

```bash
git commit -m "fix(data): make canonical collection reads exact"
```

## Task 2: Implement the tenant-scoped bounded cache core

**Files:**
- Create: `src/lib/canonicalSurfaceCache.ts`
- Create: `src/lib/canonicalSurfaceCache.test.ts`
- Modify: `src/lib/teacherSession.ts`
- Modify: `src/lib/teacherSession.test.ts`

- [ ] **Step 1: Write the cache contract RED tests**

Require exact envelope keys and identity:

```ts
type CanonicalSurfaceCacheEnvelope<T> = {
  schemaVersion: 1;
  surface: "teacher_dashboard" | "teacher_roster";
  organizationId: string;
  accountId: string;
  sessionGeneration: number;
  staleAt: string;
  data: T;
};
```

Cover wrong surface/org/account/generation, extra keys, non-UTC/future timestamp, accessors, proxies, cycles, sparse arrays, non-finite numbers, mutation during validation, and oversized UTF-8 payloads.

- [ ] **Step 2: Add maximum round-trip and secret-scan RED tests**

Construct a 2,000-attempt dashboard projection and 100-student roster projection at allowed field bounds. Require successful write/read within 2 MiB and 1 MiB respectively. Scan serialized bytes and reject disallowed keys such as `questions`, `answers`, `inviteUrl`, `startCode`, `credential`, `bearer`, and feedback bodies.

- [ ] **Step 3: Run the cache RED suite**

```bash
npx vitest run src/lib/canonicalSurfaceCache.test.ts src/lib/teacherSession.test.ts
```

- [ ] **Step 4: Implement stable snapshot, write, read, and purge APIs**

Use own data descriptors, bounded recursion, dense arrays, canonical ISO validation, `TextEncoder` byte counts, serialize→parse→revalidate round trips, and domain-separated storage keys. Catch proxy/accessor/storage failures and return a stable typed miss/failure without throwing into UI.

- [ ] **Step 5: Purge legacy/global evidence at identity boundaries**

On logout and teacher identity replacement, delete the legacy global dashboard/roster stale markers and remove cache entries belonging to the previous exact identity. Never clear unrelated browser storage.

- [ ] **Step 6: Verify and commit Task 2**

Run focused tests, TypeScript, scoped ESLint, and diff-check. Commit:

```bash
git commit -m "feat(cache): add tenant-scoped canonical surfaces"
```

## Task 3: Separate rich fresh dashboard data from redacted cached data

**Files:**
- Create: `src/lib/teacherDashboardCanonicalCache.ts`
- Create: `src/lib/teacherDashboardCanonicalCache.test.ts`
- Modify: `src/app/teacher/dashboard/page.tsx`
- Test: `src/lib/canonicalLoadStateSurface.test.ts`
- Test: `src/lib/teacherDashboardDetailCacheSurface.test.ts`
- Test: `src/lib/persistenceIntegration.test.ts`

- [ ] **Step 1: Add fresh-versus-cache RED tests**

Assert fresh successful loads retain original question-rich `Exam[]` and complete attempts in memory, while `toTeacherDashboardCacheProjection` emits redacted summaries. A cache serialization failure must still publish fresh data.

- [ ] **Step 2: Add identity-fence RED tests**

Model organization A and B with identical array sizes and timestamps. Resolve A after B starts and require A to publish no state or storage. Repeat for account ID, session generation, request generation, and a detailed-attempt request.

- [ ] **Step 3: Implement pure projection/materialization helpers**

Keep conversion outside React. The cache projection stores only exam summary fields and analytics-safe attempt summary fields. Materialization produces a distinct degraded view type and cannot be passed to edit/detail APIs expecting rich records.

- [ ] **Step 4: Wire the dashboard state machine**

Capture `{organizationId, accountId, sessionGeneration, requestGeneration}` before starting loaders. Recheck after every await and before every cache write. On identity change immediately clear old visible data and cached detail state. Resolve degraded state only from an exact scoped cache.

- [ ] **Step 5: Verify and commit Task 3**

```bash
npx vitest run src/lib/teacherDashboardCanonicalCache.test.ts src/lib/canonicalLoadStateSurface.test.ts src/lib/teacherDashboardDetailCacheSurface.test.ts src/lib/persistenceIntegration.test.ts
npx tsc --noEmit
npx eslint src/lib/teacherDashboardCanonicalCache.ts src/app/teacher/dashboard/page.tsx
git diff --check
git commit -m "fix(dashboard): fence canonical cached data"
```

## Task 4: Enforce degraded read-only capability through dashboard children

**Files:**
- Modify: `src/components/dashboard/tabs/OverviewTab.tsx`
- Modify: `src/app/teacher/dashboard/page.tsx`
- Test: `src/lib/teacherExamMutationSurface.test.ts`
- Test: `src/lib/teacherDashboardDetailCacheSurface.test.ts`
- Test: `src/components/dashboard/tabs/ExamAnalyticsReportOverview.test.tsx`
- Modify: `e2e/teacher-canonical-load-state.spec.ts`

- [ ] **Step 1: Add RED callback-absence tests**

Render `OverviewTab` with `capability="degraded_read_only"`. Require no archive, delete, edit, repair, CSV/export, or detailed-attempt invocation. Verify identity-only rows and the persistent stale timestamp/retry UI remain.

- [ ] **Step 2: Add a runtime browser RED case**

Seed a valid scoped cache, force the remote read to fail, and assert every mutation/export/detail control is absent or disabled. Count intercepted mutation/detail action requests and require zero.

- [ ] **Step 3: Implement a shared child capability prop**

Use:

```ts
type TeacherDataCapability = "fresh_mutable" | "degraded_read_only" | "unavailable";
```

Do not merely hide the parent tab. Guard event handlers before side effects, and do not construct mutation callbacks in degraded mode.

- [ ] **Step 4: Verify and commit Task 4**

Run focused Vitest, the Chromium teacher canonical load spec with one worker/no retries, TypeScript, ESLint, and diff-check. Commit:

```bash
git commit -m "fix(ui): enforce degraded dashboard read-only"
```

## Task 5: Wire scoped roster cache into users and distribution surfaces

**Files:**
- Create: `src/lib/teacherRosterCanonicalCache.ts`
- Create: `src/lib/teacherRosterCanonicalCache.test.ts`
- Modify: `src/app/teacher/users/page.tsx`
- Modify: `src/components/DistributeModal.tsx`
- Test: `src/lib/teacherRosterSurface.test.ts`
- Test: `src/lib/persistenceIntegration.test.ts`
- Test: `src/lib/canonicalLoadStateSurface.test.ts`
- Modify: `e2e/teacher-canonical-load-state.spec.ts`

- [ ] **Step 1: Add RED cache codec and stale-response tests**

Require bounded group/student/invite metadata, no raw invite link/bearer/credential, exact org identity, and 100-row maximum round trip. Simulate an organization A response arriving after organization B becomes current and require zero local roster writes.

- [ ] **Step 2: Add RED UI capability tests**

In degraded users/distribution surfaces, retain read-only identity/group membership but disable add/edit/delete/import/invite/revoke/distribute operations and analytics exports. Error-without-cache blocks onboarding mutations and exposes retry.

- [ ] **Step 3: Implement post-fence roster persistence and scoped cache wiring**

Call the Task 1 side-effect-free read, validate the complete identity fence, then persist canonical roster/revision and the redacted scoped cache. Do not reuse the legacy global timestamp as evidence.

- [ ] **Step 4: Verify and commit Task 5**

Run focused tests and the full teacher canonical Chromium spec, then TypeScript, scoped ESLint, and diff-check. Commit:

```bash
git commit -m "fix(roster): scope degraded cache by teacher identity"
```

## Task 6: Reconcile exact assignment scope and monotonic lifecycle time

**Files:**
- Modify: `src/app/actions/studentExam.ts`
- Modify: `src/lib/studentExamClient.ts`
- Modify: `src/app/student/dashboard/page.tsx`
- Modify: `src/components/dashboard/AssignmentBlock.tsx`
- Modify: `src/lib/studentAssignmentClassification.ts`
- Test: `src/lib/studentExamClient.test.ts`
- Test: `src/lib/studentAssignmentClassification.test.ts`
- Test: `src/lib/assignmentLifecycleSurface.test.ts`
- Test: `src/lib/studentDashboardLoadState.test.ts`
- Modify: `e2e/student-assignment-lifecycle.spec.ts`

- [ ] **Step 1: Add exact-assignment RED tests**

Require an `in_progress` attempt to produce “continue” only when its `assignmentId` matches the displayed assignment. A new assignment for the same exam must retain the older completed assignment as review-only while keeping the new solve card separate.

- [ ] **Step 2: Add authoritative-time RED tests**

Return the exact `serverNow` used by the gateway from `listMyAssignments`. Pass it through the client unchanged. With fake timers require scheduled→open→closed transitions and prove browser clock rollback or an older server refresh cannot reverse a later observed lifecycle.

- [ ] **Step 3: Implement the scoped classifiers**

Add a shared exact-scope matcher for completed and in-progress attempts. Preserve root behavior for retakes, stable tie-breaking, `invalid` lifecycle, `readOnly`, and `remoteFailed`; do not copy the weaker core-branch load resolver.

- [ ] **Step 4: Implement the monotonic boundary clock**

Anchor elapsed client time to the most recent authoritative server instant, retain the greatest observed authoritative time, schedule only the next start/end boundary, and clear timers on unmount. The solve server action remains the final authorization check.

- [ ] **Step 5: Verify and commit Task 6**

```bash
npx vitest run src/lib/studentExamClient.test.ts src/lib/studentAssignmentClassification.test.ts src/lib/assignmentLifecycleSurface.test.ts src/lib/studentDashboardLoadState.test.ts
CI=1 npx playwright test e2e/student-assignment-lifecycle.spec.ts --project=chromium --workers=1 --retries=0
npx tsc --noEmit
npm run lint
git diff --check
git commit -m "fix(assignments): keep lifecycle scope authoritative"
```

## Task 7: Run the full stabilization matrix and independent review

**Files:**
- Modify only if a newly reproduced regression requires a TDD fix.

- [ ] **Step 1: Run the focused cross-surface suite**

```bash
npx vitest run src/lib/canonicalLoadState.test.ts src/lib/canonicalSurfaceCache.test.ts src/lib/canonicalReadActionContract.test.ts src/lib/teacherDashboardCanonicalCache.test.ts src/lib/teacherRosterCanonicalCache.test.ts src/lib/studentAssignmentClassification.test.ts src/lib/assignmentLifecycleSurface.test.ts src/lib/persistenceIntegration.test.ts
```

- [ ] **Step 2: Run deterministic browser acceptance**

```bash
CI=1 npx playwright test e2e/student-assignment-lifecycle.spec.ts e2e/teacher-canonical-load-state.spec.ts --project=chromium --workers=1 --retries=0
CI=1 PLAYWRIGHT_ENABLE_WEBKIT=1 npx playwright test e2e/student-assignment-lifecycle.spec.ts e2e/teacher-canonical-load-state.spec.ts --project=webkit --workers=1 --retries=0
```

- [ ] **Step 3: Run repository-wide local gates**

```bash
npm test -- --reporter=dot
npx tsc --noEmit
npm run lint
npm run build
OMR_SUPABASE_LIVE_BACKEND=local npm run test:supabase:live
CI=1 npm run test:e2e:prod -- --retries=0
git diff --check
```

Use the exact production-safe environment bindings required by the existing contract. Missing external hosted credentials remain `UNVERIFIED`; do not substitute local evidence.

- [ ] **Step 4: Request independent specification and security review**

Require zero unresolved Critical/Important findings for tenant isolation, collection completeness, read-only degradation, lifecycle monotonicity, and secret-free cache bytes.

- [ ] **Step 5: Reconcile the branch without touching the dirty legacy worktree**

Fast-forward or merge `codex/canonical-cache-reconciliation` into `codex/initial-ops-100` only after all local gates and review pass. Preserve `/Users/bigmac_moon/dev/omr_maker/.worktrees/initial-ops-core-distribution` until the user separately approves cleanup. Do not merge analytics or deploy production as part of this plan.

## Task 8: Record honest release qualification status

**Files:**
- Modify: `docs/initial-operations-runbook.md` only if the existing evidence section lacks the result.

- [ ] **Step 1: Record local evidence without upgrading external status**

Document local commit SHA and command results. Keep protected staging, 100-user hosted load, alert heartbeat, restore rehearsal, device matrix, and promotion lineage explicitly `UNVERIFIED`.

- [ ] **Step 2: Final branch handoff**

Report the merged commit range, preserved worktrees, local verification results, and exact external blockers. Do not claim production GO, remove worktrees, push, or deploy without separate authority.
