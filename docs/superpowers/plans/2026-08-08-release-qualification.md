# Release Qualification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce exact-SHA evidence that all ten quality dimensions meet mean 9.3, minimum 8.7, and zero hard gates before promoting the initial 100-user release.

**Architecture:** First eliminate deterministic and order-dependent browser failures. Then create a machine-readable evidence manifest that hashes, dates, and scores local, hosted, load, alert, backup, and restore artifacts. GitHub protected workflows execute staging and promotion; missing infrastructure fails as unverified.

**Tech Stack:** Playwright, Vitest, Node.js evidence scripts, PostgreSQL 17, GitHub Actions, immutable preview promotion.

---

### Task 1: Repair stale browser contracts

**Files:**
- Modify: `e2e/student-dashboard-load-state.spec.ts`
- Modify: `e2e/teacher-pages.spec.ts`

- [ ] **Step 1: Reproduce the two deterministic failures**

```sh
CI=1 npx playwright test --project=chromium --workers=1 --retries=0 e2e/student-dashboard-load-state.spec.ts e2e/teacher-pages.spec.ts
```

Expected before changes: student recovery link expects `학생 로그인` instead of `로그인 안내`, and
teacher readiness expects `교사 계정 환경변수` instead of `교사 계정 수명주기`.

- [ ] **Step 2: Align assertions with the approved product contract**

```ts
await expect(page.getByRole("link", { name: "로그인 안내" })).toHaveAttribute("href", "/");
await expect(page.getByText("교사 계정 수명주기", { exact: true })).toBeVisible();
```

Do not loosen locators to arbitrary text or add retries.

- [ ] **Step 3: Run GREEN five times**

```sh
for run in {1..5}; do
  CI=1 npx playwright test --project=chromium --workers=1 --retries=0 e2e/student-dashboard-load-state.spec.ts e2e/teacher-pages.spec.ts || exit 1
done
```

Expected: five consecutive passes.

- [ ] **Step 4: Commit**

```sh
git add e2e/student-dashboard-load-state.spec.ts e2e/teacher-pages.spec.ts
git commit -m "fix(e2e): align core recovery assertions"
```

### Task 2: Remove reduced-motion observation races

**Files:**
- Modify: `e2e/ui-ux-audit.spec.ts`
- Modify: `src/components/dashboard/CountUp.tsx`
- Modify: `src/components/dashboard/CountUp.test.tsx`

- [ ] **Step 1: Add a failing product-owned readiness signal test**

Render CountUp under app motion off and assert the stable signal:

```ts
expect(screen.getByTestId("count-up")).toHaveAttribute("data-count-up-ready", "true");
expect(screen.getByTestId("count-up")).toHaveAttribute("data-count-up-motion", "reduced");
expect(screen.getByTestId("count-up")).toHaveAttribute("data-count-up-raf", "idle");
expect(screen.getByTestId("count-up")).toHaveTextContent("42");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/components/dashboard/CountUp.test.tsx
```

- [ ] **Step 3: Implement the stable readiness attribute**

Set `data-count-up-ready="true"` only after the component has evaluated OS and app motion and either
committed the final reduced value or scheduled the animated path. Do not delay behavior with a larger
timeout.

- [ ] **Step 4: Split the Playwright race into two tests**

One boot test seeds `omr_settings.theme.motion=false`, waits for `data-count-up-ready=true`, and asserts
final/idle. A separate media-transition test changes root motion and `page.emulateMedia`, then uses
`expect.poll` on root and CountUp signals in sequence. Remove the external MutationObserver first-frame
capture and keep retries disabled.

- [ ] **Step 5: Run the order group twenty times**

```sh
npx vitest run src/components/dashboard/CountUp.test.tsx
CI=1 npx playwright test --project=chromium --workers=1 --retries=0 e2e/ui-ux-audit.spec.ts --grep 'balanced motion|motion-off' --repeat-each=20
```

Expected: forty browser cases pass with no retry.

- [ ] **Step 6: Commit**

```sh
git add e2e/ui-ux-audit.spec.ts src/components/dashboard/CountUp.tsx src/components/dashboard/CountUp.test.tsx
git commit -m "fix(e2e): remove reduced-motion observation race"
```

### Task 3: Create a versioned quality evidence manifest and scorer

**Files:**
- Create: `scripts/release-quality-core.mjs`
- Create: `scripts/score-release-quality.mjs`
- Create: `src/lib/releaseQualityScorer.test.ts`
- Modify: `package.json`
- Modify: `docs/operations/release-evidence-template.md`

- [ ] **Step 1: Write failing scoring tests**

```ts
expect(scoreReleaseEvidence(allPassing)).toMatchObject({
  status: "go",
  mean: 9.3,
  minimum: 8.7,
  hardGateFailures: [],
});
expect(scoreReleaseEvidence({ ...allPassing, hosted: { status: "unverified" } }).status).toBe("no_go");
expect(scoreReleaseEvidence({ ...allPassing, dimensions: { ...allPassing.dimensions, browser: 8.6 } }).status).toBe("no_go");
expect(() => scoreReleaseEvidence({ ...allPassing, buildSha: "short" })).toThrow(/build SHA/);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/releaseQualityScorer.test.ts
```

- [ ] **Step 3: Implement the exact ten dimensions**

Use these keys only:

```js
export const RELEASE_DIMENSIONS = [
  "student_core",
  "teacher_core",
  "provisioning_entitlement",
  "data_integrity_isolation",
  "code_supply_chain",
  "browser_determinism",
  "ux_accessibility_responsiveness",
  "hosted_deployment",
  "capacity_observability",
  "recovery_release",
];
```

Each atomic check is binary and has fixed tenths summing to 10.0 per dimension. Missing, expired,
wrong-SHA, skipped, or unverified evidence scores zero. Mean must be ≥9.3 and every dimension ≥8.7.

- [ ] **Step 4: Encode hard gates**

Hard gates include core E2E failure/retry/order dependence, health/readiness 404/degraded/wrong SHA,
unverified production boundary or 100-user load, duplicate submission/data exposure, plaintext secrets,
PII logs, absent sink/alert/heartbeat, failed restore/RPO/RTO, high/critical production vulnerability,
and unexplained skip.

- [ ] **Step 5: Seal output**

`npm run release:score -- --manifest=/absolute/path/manifest.json --output=/absolute/path/score.json`
validates every source artifact SHA-256, writes a 0600 JSON result, includes scorer SHA and build SHA,
and exits 1 for NO-GO.

- [ ] **Step 6: Run GREEN**

```sh
npx vitest run src/lib/releaseQualityScorer.test.ts
```

- [ ] **Step 7: Commit**

```sh
git add scripts/release-quality-core.mjs scripts/score-release-quality.mjs src/lib/releaseQualityScorer.test.ts package.json docs/operations/release-evidence-template.md
git commit -m "feat(release): add objective quality scorer"
```

### Task 4: Extend restore verification through live contract and browser smoke

**Files:**
- Modify: `scripts/verify-restored-environment.mjs`
- Modify: `src/lib/restoredEnvironmentVerification.test.ts`
- Create: `scripts/run-restored-environment-smoke.mjs`
- Create: `src/lib/restoredEnvironmentSmoke.test.ts`
- Modify: `docs/operations/backup-restore-runbook.md`

- [ ] **Step 1: Write failing orchestration tests**

```ts
expect(result).toMatchObject({
  status: "verified",
  boundaryContract: "passed",
  browserSmoke: "passed",
  disposableCredentialsRevoked: true,
});
expect(result.completeMarker).toMatch(/\.RESTORE_COMPLETE$/);
```

Missing live contract, browser smoke, or credential revocation returns `unverified` and creates no
completion marker.

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/restoredEnvironmentVerification.test.ts src/lib/restoredEnvironmentSmoke.test.ts
```

- [ ] **Step 3: Add injected live-contract and smoke runners**

After exact table count, object body hashes, and RPO/RTO pass, run the PostgreSQL production-boundary
contract against the isolated target. Provision a disposable teacher and two students, execute
create→publish→invite→solve→submit→feedback, then revoke all disposable credentials. Store only command
exit codes, safe IDs, timestamps, build SHA, and artifact hashes.

- [ ] **Step 4: Seal restore evidence only after all gates**

Create `.RESTORE_COMPLETE` with mode 0600 only when count/hash, RPO/RTO, boundary, browser smoke, and
credential revocation are all verified. Keep `.INCOMPLETE` on failure.

- [ ] **Step 5: Run GREEN**

```sh
npx vitest run src/lib/restoredEnvironmentVerification.test.ts src/lib/restoredEnvironmentSmoke.test.ts src/lib/backupRestoreCore.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add scripts/verify-restored-environment.mjs src/lib/restoredEnvironmentVerification.test.ts scripts/run-restored-environment-smoke.mjs src/lib/restoredEnvironmentSmoke.test.ts docs/operations/backup-restore-runbook.md
git commit -m "feat(recovery): verify restored core journey"
```

### Task 5: Add a protected staging qualification workflow

**Files:**
- Create: `.github/workflows/initial-operations-qualification.yml`
- Create: `src/lib/initialOperationsQualificationWorkflow.test.ts`
- Modify: `docs/initial-operations-runbook.md`

- [ ] **Step 1: Write failing workflow tests**

```ts
expect(workflow).toContain("environment: initial-operations-staging");
expect(workflow).toContain('node-version: "22.13.0"');
expect(workflow).toContain("npm run test:ops:initial -- --run");
expect(workflow).toContain("npm run ops:alert:verify");
expect(workflow).toContain("npm run ops:restore:verify");
expect(workflow).toContain("npm run release:score");
expect(workflow).not.toContain("continue-on-error: true");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/initialOperationsQualificationWorkflow.test.ts
```

- [ ] **Step 3: Implement protected exact-SHA stages**

Checkout a required 40-character SHA and assert HEAD. Run clean install/static/unit/build/live DB,
immutable preview verification, exact 80+10+10 workload, alert exercise, backup/restore verification,
and score generation. Upload raw evidence even on failure, but never mark a failed command successful.

- [ ] **Step 4: Enforce evidence freshness and non-production targets**

The workflow rejects a workload or restore host matching production, requires explicit fixture and
project confirmations, and records environment/deployment identifiers as hashes. Source/audit/browser
evidence expires after 24 hours; restore after 30 days; hosted evidence after any environment change.

- [ ] **Step 5: Run GREEN**

```sh
npx vitest run src/lib/initialOperationsQualificationWorkflow.test.ts src/lib/ciWorkflowContract.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add .github/workflows/initial-operations-qualification.yml src/lib/initialOperationsQualificationWorkflow.test.ts docs/initial-operations-runbook.md
git commit -m "feat(release): add protected staging qualification"
```

### Task 6: Add immutable preview promotion with post-promotion proof

**Files:**
- Create: `scripts/promote-qualified-preview.mjs`
- Create: `src/lib/qualifiedPreviewPromotion.test.ts`
- Modify: `.github/workflows/production-readiness.yml`
- Modify: `docs/production-readiness.md`

- [ ] **Step 1: Write failing promotion safety tests**

```ts
expect(validatePromotionInput(input)).toEqual({ ok: true });
expect(validatePromotionInput({ ...input, scoreStatus: "no_go" })).toEqual({ ok: false, error: "qualification_failed" });
expect(validatePromotionInput({ ...input, previewSha: otherSha })).toEqual({ ok: false, error: "build_mismatch" });
expect(commands).toEqual(["vercel", "promote", qualifiedPreviewUrl, "--yes"]);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/qualifiedPreviewPromotion.test.ts
```

- [ ] **Step 3: Implement promotion guardrails**

Require the qualified score manifest, exact build SHA, preview deployment ID, artifact digest, target
production host, and an explicit operator confirmation. Invoke promotion only; never `vercel deploy
--prod` or a rebuild. After promotion, run the existing production verifier and compare deployed SHA,
deployment ID/digest lineage, readiness version, DB project hash, and negative access probes.

- [ ] **Step 4: Add rollback evidence**

On post-promotion failure, keep writes paused and produce a rollback-required JSON containing safe
trigger, previous deployment ID, target deployment ID, SHA, timestamp, and operator. Do not relax RLS.

- [ ] **Step 5: Run GREEN**

```sh
npx vitest run src/lib/qualifiedPreviewPromotion.test.ts src/lib/productionDeploymentVerification.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add scripts/promote-qualified-preview.mjs src/lib/qualifiedPreviewPromotion.test.ts .github/workflows/production-readiness.yml docs/production-readiness.md
git commit -m "feat(release): promote qualified immutable preview"
```

### Task 7: Execute the final local qualification matrix

**Files:**
- Evidence only: a new absolute directory outside tracked source

- [ ] **Step 1: Run the source and supply-chain gate**

```sh
npm ci
npm audit --package-lock-only --omit=dev --audit-level=high
node scripts/verify-desktop-dependency-audit.mjs
npm run lint
npx tsc --noEmit
npm test
npm run test:supabase:live
npm run build
```

Expected: every command exits 0 and the production audit reports zero high/critical findings.

- [ ] **Step 2: Run Chromium ten consecutive times**

```sh
for run in {1..10}; do
  CI=1 npx playwright test --project=chromium --workers=1 --retries=0 --reporter=json > "$EVIDENCE/chromium-$run.json" || exit 1
done
```

Expected: ten full runs pass without retry or quarantine.

- [ ] **Step 3: Run production and WebKit core matrices**

```sh
CI=1 npm run test:e2e:prod -- --retries=0
CI=1 PLAYWRIGHT_ENABLE_WEBKIT=1 npm run test:e2e:ios-webkit -- --retries=0
```

Expected: all configured core projects pass; every skip has a separate executed counterpart and dated
artifact.

- [ ] **Step 4: Generate the local manifest**

Hash every stdout/report artifact, record tool and browser versions, build SHA, start/end times, and
lockfile SHA. Do not score hosted, load, alert, or restore dimensions until their actual evidence is
present.

Expected: local score manifest is valid but overall status remains NO-GO/unverified before external
qualification.

### Task 8: Execute external qualification and final audit

**Files:**
- Evidence only: protected workflow artifacts and operator release record

- [ ] **Step 1: Qualify isolated staging**

Apply schema, sorted migrations, and production boundary as one owner; run negative direct-access
probes and the exact 80-student + 10-poller + 10-uploader workload. Require no 5xx, read p95 <750 ms,
submit RPC p95 <1.5 s, submit E2E p99 <9 s, sampled query ≤500 ms, and dead queue 0.

- [ ] **Step 2: Exercise observability**

Run one unique synthetic critical event through sink receipt, alert receipt, acknowledgement, and
resolution. Confirm cleanup heartbeat is newer than 30 hours and backup age is within 60 minutes.

- [ ] **Step 3: Complete isolated restore**

Restore the production-shaped backup to a distinct project, compare exact table counts and every object
body SHA, pass boundary contracts and the disposable browser smoke, revoke fixtures, and finish within
RPO 60/RTO 120.

- [ ] **Step 4: Promote and verify**

Pause writes and cleanup claims, take backup, run preflight, apply boundary, promote the exact qualified
preview without rebuilding, and verify public health, authenticated ready status, exact SHA/version,
negative access, and disposable hosted teacher/student journeys before resuming writes.

- [ ] **Step 5: Score the final evidence**

Run the scorer over only current exact-SHA artifacts. Require mean ≥9.3, minimum ≥8.7, and zero hard
gates. If any result is unverified, expired, wrong-SHA, or missing, keep the release NO-GO and do not
claim goal completion.
