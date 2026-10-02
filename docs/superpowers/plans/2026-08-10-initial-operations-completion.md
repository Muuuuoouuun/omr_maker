# Initial Operations Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Raise the repository-owned initial-operations release path to a truthful mean target of 9.3/10 with every local/source dimension at least 8.7/10, while keeping the official release `UNVERIFIED/NO-GO` until exact-SHA hosted, load, alert, and restore evidence exists.

**Architecture:** Keep Next.js and PostgreSQL/Supabase as the application and coordination boundaries. Replace aggregate evidence fan-out with assertion-bound proof catalogs, keep live payment disabled behind a provider-neutral server-only seam, make database cutover waits bounded, and move restore execution from opaque secret runners to repository-owned streaming executors. Local browser fixtures may emulate transport, but they must exercise the real UI/state machines and may never be counted as hosted authorization evidence.

**Tech Stack:** Next.js 16, React 19, TypeScript, Node.js 22.13+, PostgreSQL 17, Supabase, Vitest, Playwright, GitHub Actions.

---

## Task 1: Make scope, workflow identity, and baseline gates truthful

**Files:**

- Modify: `docs/superpowers/specs/2026-08-08-initial-operations-100-release-design.md`
- Modify: `docs/superpowers/plans/2026-08-08-initial-operations-100-release-master.md`
- Modify: `docs/superpowers/plans/2026-08-08-billing-connection-boundary.md`
- Modify: `.github/workflows/initial-operations-qualification.yml`
- Modify: `src/lib/initialOperationsQualificationWorkflow.test.ts`
- Modify: `src/lib/demoData.test.ts`
- Modify: `src/lib/groupProfileAnalytics.test.ts`
- Modify only if the attested production path still misses the limit: `src/lib/groupProfileAnalytics.ts`
- Modify only if the attested production path still misses the limit: `src/lib/studentProfileAnalytics.ts`

### Step 1: Write scope/version/performance RED tests

- Assert the qualification input default is exactly `202608090001`.
- Assert the approved specification says live payment, durable billing persistence, checkout/webhook routes, and provider credentials are outside this release; only the disabled server-only adapter/catalog/authority seam remains.
- In the 20×500 profile fixture, attest each complete attempt exactly as the real server read boundary does before timing the student and group builders.
- Run the deterministic demo test under the full-suite concurrency budget and record the pre-fix timeout.

Run:

```sh
npx vitest run \
  src/lib/initialOperationsQualificationWorkflow.test.ts \
  src/lib/groupProfileAnalytics.test.ts \
  src/lib/demoData.test.ts --reporter=verbose
```

Expected RED: stale workflow version and/or un-attested CPU fixture fail for the intended reason; the existing full suite continues to expose the demo timeout.

### Step 2: Apply the minimum truthful fixes

- Change only the initial-operations qualification default to `202608090001`; do not invent a new readiness version for feature migrations.
- Rewrite the billing sections of the approved design/master plan so current user scope is authoritative: no checkout/webhook/durable billing schema in this release, no enabled CTA, and no plan mutation from provider intent. Keep `billingProviderContract.server.ts` as the tested future adapter seam.
- Attest the performance fixture using `attestCanonicalQuestionResultEvidence`; do not weaken the 1.5-second production CPU bound.
- Give the intentionally heavy demo determinism assertion an explicit bounded timeout only after measuring that one build remains acceptable; do not raise the global Vitest timeout.

### Step 3: Verify the baseline slice

```sh
npx vitest run \
  src/lib/initialOperationsQualificationWorkflow.test.ts \
  src/lib/groupProfileAnalytics.test.ts \
  src/lib/demoData.test.ts --reporter=verbose
npx tsc --noEmit
```

Expected GREEN: all focused tests pass and both profile builders remain below 1.5 seconds with attested inputs.

## Task 2: Bind browser atomic checks to actual Playwright results

**Files:**

- Create: `scripts/browser-release-proof-core.mjs`
- Create: `src/lib/browserReleaseProofCore.test.ts`
- Modify: `scripts/build-initial-operations-qualification.mjs`
- Modify: `src/lib/initialOperationsQualificationBuilder.test.ts`
- Modify: `.github/workflows/initial-operations-qualification.yml`
- Modify selected tests in: `e2e/full-journey.spec.ts`
- Modify selected tests in: `e2e/teacher-pages.spec.ts`
- Modify selected tests in: `e2e/teacher-canonical-load-state.spec.ts`
- Modify selected tests in: `e2e/student-dashboard-load-state.spec.ts`
- Modify selected tests in: `e2e/student-assignment-lifecycle.spec.ts`
- Modify selected tests in: `e2e/student-handwriting-recovery.spec.ts`
- Modify selected tests in: `e2e/exam-invite-lifecycle.spec.ts`
- Modify selected tests in: `e2e/ui-ux-audit.spec.ts`
- Modify selected tests in: `e2e/tablet-layout.spec.ts`
- Modify selected tests in: `e2e/ios-mobile-layout.spec.ts`
- Modify selected tests in: `e2e/pwa-mobile.spec.ts`
- Modify selected tests in: `e2e/teacher-mobile.spec.ts`

### Step 1: Write proof parser RED tests

Construct small Playwright JSON reports and require the parser to:

- accept only exact `release-proof` annotations from expected files;
- require a passed, non-skipped, non-flaky result for every student, teacher, UX, credential, reduced-motion, and fresh-context proof ID;
- reject a constant proof list when the matching annotated test is absent, skipped, flaky, or failed;
- reject duplicate/conflicting proof ownership and unknown proof IDs;
- return the canonical proof list derived from report bytes, never from caller claims.

Run:

```sh
npx vitest run src/lib/browserReleaseProofCore.test.ts --reporter=verbose
```

Expected RED: module missing.

### Step 2: Implement report-derived proof validation

- Export the immutable browser proof catalog from `browser-release-proof-core.mjs`.
- Traverse Playwright suites/specs/tests/results with exact own-data validation and bounded counts/bytes.
- Attach `test.info().annotations.push({ type: "release-proof", description: proofId })` only inside tests whose assertions actually prove that atomic behavior.
- Replace the workflow's `proofs: QUALIFICATION_BROWSER_PROOFS` constant injection with the parser result from all ten Chromium reports plus WebKit.
- Change `validateMetrics("browser")` so the returned metric predicates are `browser.proof:<proofId>` and map every browser-owned atomic check to its own predicate.

### Step 3: Verify missing-proof fail-closed behavior

```sh
npx vitest run \
  src/lib/browserReleaseProofCore.test.ts \
  src/lib/initialOperationsQualificationBuilder.test.ts \
  src/lib/initialOperationsQualificationWorkflow.test.ts --reporter=verbose
```

Expected GREEN: deleting any one annotation or changing its result to skipped makes qualification invalid.

## Task 3: Bind PostgreSQL atomic checks to executed assertion IDs

**Files:**

- Create: `supabase/initial-operations-release-proof-assertions.sql`
- Create: `scripts/live-pg-release-proof-core.mjs`
- Create: `src/lib/livePgReleaseProofCore.test.ts`
- Modify: `scripts/verify-supabase-live.mjs`
- Modify: `src/lib/supabaseLiveVerifier.test.ts`
- Modify: `scripts/build-initial-operations-qualification.mjs`
- Modify: `src/lib/initialOperationsQualificationBuilder.test.ts`
- Modify: `.github/workflows/initial-operations-qualification.yml`

### Step 1: Write proof extraction RED tests

- Require exact markers for all ten `provisioning_entitlement_*` and all ten `data_integrity_isolation_*` checks.
- Reject duplicate, unknown, missing, out-of-order, or stderr-only markers.
- Prove a generic `live_pg.exact_contract=passed` without the exact markers cannot pass any atomic check.

Run:

```sh
npx vitest run \
  src/lib/livePgReleaseProofCore.test.ts \
  src/lib/initialOperationsQualificationBuilder.test.ts --reporter=verbose
```

Expected RED: exact proof module/assertion file is absent.

### Step 2: Add independent live SQL assertions

In `initial-operations-release-proof-assertions.sql`, independently check and then emit one bounded marker for each required behavior:

- operator provision/audit/pilot grant/student batch/one-time credential rotation/session revocation/invite/assignment/account recovery;
- tenant isolation/canonical ACL/submission replay/quota/receipt/session generation/roster CAS/question atomicity/storage isolation/rollback.

Do not emit a marker before its corresponding SQL assertion succeeds. The verifier must run this file after schema, sorted migrations, production boundary, live assertions, and rollback/reapply assertions.

### Step 3: Wire exact live proofs into qualification

- Capture proof markers in `verify-supabase-live.mjs` and write only a bounded proof summary to a private workflow artifact.
- Make `source-live_pg.json.metrics.proofs` the exact executed list.
- Map each PG-owned atomic check to `live_pg.proof:<id>`.

### Step 4: Verify locally on PostgreSQL 17

```sh
npx vitest run \
  src/lib/livePgReleaseProofCore.test.ts \
  src/lib/supabaseLiveVerifier.test.ts \
  src/lib/initialOperationsQualificationBuilder.test.ts --reporter=verbose
npm run test:supabase:live
```

Expected GREEN: full PG17 matrix passes and one removed marker makes the builder reject the bundle.

## Task 4: Repair the real local core browser journeys

**Files:**

- Modify: `e2e/full-journey.spec.ts`
- Modify shared fixture only if required: `e2e/fixtures/canonical-remote-fixture.ts` (create if no existing exact helper is suitable)
- Modify production only when the same failure reproduces with an authoritative successful remote response: `src/app/teacher/dashboard/page.tsx`
- Modify production only when the same failure reproduces with an authoritative successful remote response: `src/app/teacher/create/page.tsx`
- Modify production only when the same failure reproduces with an authoritative successful remote response: `src/app/solve/[id]/page.tsx`
- Modify adjacent unit/source tests for any production change.

### Step 1: Preserve the three exact browser REDs

Run each failure independently with one worker and zero retries:

```sh
npx playwright test e2e/full-journey.spec.ts --project=chromium --workers=1 --retries=0 \
  --grep "start-code student submit|re-entering a retake|creates an exam through the teacher UI"
```

Expected RED:

- start-code submission reaches teacher analytics only when the canonical remote dashboard response is supplied;
- retake Q3 must render from the exact retake snapshot;
- distribution cannot claim success while roster is `error_without_cache`.

### Step 2: Fix transport fixtures before product code

- Provide one shared exact Next Action fixture that returns the authoritative roster, exam, assignment, attempt, receipt, and analytics revisions used by the UI.
- Keep localStorage only for device session/bootstrap; do not synthesize a completed attempt directly into teacher analytics.
- Make submission travel through the real action client/outbox reconciliation path.
- If the UI still fails with valid authoritative responses, write a focused component/unit RED and fix the production state transition.

### Step 3: Prove the journey and proof annotations

```sh
npx playwright test e2e/full-journey.spec.ts --project=chromium --workers=1 --retries=0
```

Expected GREEN: every full-journey test passes with no retry and proof annotations identify the actual assertions.

## Task 5: Bound canonical evidence migration cutover

**Files:**

- Modify: `supabase/migrations/202608100001_canonical_question_result_evidence.sql`
- Modify: `src/lib/canonicalQuestionResultEvidenceMigrationContract.test.ts`
- Modify: `supabase/canonical-question-result-evidence-assertions.sql`

### Step 1: Write deployment-boundary RED tests

- Require transaction-local `lock_timeout` and `statement_timeout` before the first DDL.
- Require a deterministic preflight lock order for `omr_attempts`, `omr_question_results`, and `omr_attempt_sessions` that is compatible with Task 6/7 runtime locks.
- Add a live blocker fixture proving the migration aborts within the lock budget and leaves no partial schema.

### Step 2: Implement bounded cutover

- Add `SET LOCAL lock_timeout = '2s'` and a bounded statement timeout suitable for the migration transaction.
- Acquire required locks in the tested global order before altering tables/triggers/indexes.
- Do not use `CREATE INDEX CONCURRENTLY` inside the migration transaction and do not weaken deferred evidence validation.

### Step 3: Verify migration apply and contention

```sh
npx vitest run src/lib/canonicalQuestionResultEvidenceMigrationContract.test.ts --reporter=verbose
npm run test:supabase:live
```

Expected GREEN: fresh apply, upgrade apply, contention abort, rollback, and reapply all pass on PostgreSQL 17.

## Task 6: Replace opaque restore preparation with repository-owned streaming execution

**Files:**

- Create: `scripts/restore-target-apply-core.mjs`
- Create: `scripts/apply-backup-to-restore-target.mjs`
- Create: `src/lib/restoreTargetApplyCore.test.ts`
- Create: `scripts/restore-smoke-runner.mjs`
- Create: `src/lib/repositoryRestoreSmokeRunner.test.ts`
- Modify: `.github/workflows/initial-operations-qualification.yml`
- Modify: `scripts/verify-restored-environment.mjs`
- Modify: `src/lib/restoredEnvironmentVerification.test.ts`
- Modify: `docs/operations/backup-restore-runbook.md`
- Modify: `docs/initial-operations-runbook.md`

### Step 1: Write streaming and identity RED tests

- Reject source=target, production=target, non-staging tier, stale build, wrong boundary hash, incomplete backup, and symlink/hard-link substitution.
- Stream roles, schema, and data into PostgreSQL sequentially; never retain all three buffers or convert complete SQL artifacts to JS strings.
- Bound each artifact, aggregate bytes, child-process runtime, stdout/stderr, Storage object count/bytes, and concurrent uploads.
- Require cleanup on timeout/error and preserve `.INCOMPLETE` without publishing `.RESTORE_COMPLETE`.
- Require the smoke runner bytes to be tracked in the exact checkout and SHA-bound; remove B64 runner source as an authority.

### Step 2: Implement the streaming apply CLI

- Use `spawn` with stdin backpressure to apply one verified SQL artifact at a time using PostgreSQL 17.
- Verify source file inode/size/hash before and after streaming.
- Upload private Storage objects from the backup manifest with bounded concurrency and body SHA recheck.
- Emit only one allowlisted JSON status line without credentials, URLs, object paths, or row data.

### Step 3: Implement the repository-owned smoke protocol

- Keep the existing `create-teacher`, two `create-student`, `browser-journey`, and revoke protocol.
- Bind every command to the restore environment/build/target digest and disposable actor IDs.
- Use only staging restore credentials; never contact production or real delivery/payment providers.
- Run create→publish→invite→solve→submit→feedback in a fresh browser context, then revoke all disposable credentials in `finally`.

### Step 4: Rewire qualification and verify

```sh
npx vitest run \
  src/lib/restoreTargetApplyCore.test.ts \
  src/lib/repositoryRestoreSmokeRunner.test.ts \
  src/lib/restoredEnvironmentVerification.test.ts \
  src/lib/initialOperationsQualificationWorkflow.test.ts --reporter=verbose
```

Expected GREEN: the workflow hashes tracked runner bytes from the immutable checkout and no longer accepts opaque B64 runner code.

## Task 7: Document the operator qualification and run all local gates

**Files:**

- Create: `docs/operations/initial-operations-qualification.md`
- Modify: `docs/operations/release-evidence-template.md`
- Modify: `docs/initial-operations-runbook.md`
- Modify: `docs/initial-ops-user-journey-audit-2026-08-07.md`

### Step 1: Write the operator guide

Document exact protected-environment inputs, immutable preview identity, same-SHA staging apply, 80+10+10 workload, external alert, backup/restore, evidence retention, score generation, promotion, rollback, and disposal. Mark every unavailable external credential as `UNVERIFIED`; never substitute local or mock evidence.

### Step 2: Run local source qualification

```sh
npm ci
npm audit --package-lock-only --omit=dev --audit-level=high
node scripts/verify-desktop-dependency-audit.mjs
npm run lint
npx tsc --noEmit
npm test -- --run
npm run test:supabase:live
npm run build
npx playwright test \
  e2e/full-journey.spec.ts \
  e2e/teacher-pages.spec.ts \
  e2e/teacher-canonical-load-state.spec.ts \
  e2e/student-dashboard-load-state.spec.ts \
  e2e/student-assignment-lifecycle.spec.ts \
  e2e/student-handwriting-recovery.spec.ts \
  e2e/exam-invite-lifecycle.spec.ts \
  e2e/ui-ux-audit.spec.ts \
  e2e/tablet-layout.spec.ts \
  --project=chromium --workers=1 --retries=0
npm run test:e2e:ios-webkit -- --workers=1 --retries=0
git diff --check
```

### Step 3: Preserve the honest external result

Run without protected credentials only to prove fail-closed behavior:

```sh
npm run test:ops:initial -- --run
```

Expected result: exit 2 with `{"status":"unverified","code":"invalid_staging_config"}`. Do not generate a GO score or claim 9.3/8.7 until protected staging produces the exact evidence bundle.

## Task 8: Review, integrate, and request external evidence

- Dispatch a spec reviewer over the final diff and this plan.
- Resolve every Critical/Important finding.
- Dispatch a code-quality reviewer and resolve every Critical/Important finding.
- Use `superpowers:verification-before-completion` before any completion claim.
- Use `superpowers:finishing-a-development-branch` to merge only verified commits back to `codex/initial-ops-100`.
- Leave the dirty `codex/initial-ops-core-distribution` worktree untouched.
- Report the exact missing protected inputs: immutable staging deployment, Supabase staging/restore credentials, external alert adapter credentials, Vercel promotion credentials, physical Android/iOS evidence, and operator approvals.
