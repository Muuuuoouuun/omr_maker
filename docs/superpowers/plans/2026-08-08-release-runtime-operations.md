# Release Runtime and Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make CI, readiness, observability, recovery metadata, and release evidence describe and verify one Node 22.13+ immutable build.

**Architecture:** Keep existing health, readiness, sink, GC, backup, and hosted verifier implementations. Add missing identity-mode and operational-state inputs, consolidate canonical schema identity, and bind workflow source SHA to deployment SHA. External providers remain adapters; local tests prove fail-closed behavior.

**Tech Stack:** TypeScript, Next.js route handlers, PostgreSQL 17, Vitest, GitHub Actions, Node.js 22.13+.

---

### Task 1: Align every executable workflow with the Node engine

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/production-readiness.yml`
- Modify: `src/lib/ciWorkflowContract.test.ts`
- Create: `src/lib/runtimeVersionContract.test.ts`

- [ ] **Step 1: Write the failing runtime contract**

Add a test that reads `package.json` and both workflow files, extracts every `node-version`, and asserts
the exact supported line:

```ts
const expectedNode = "22.13.0";
expect(packageJson.engines.node).toBe(">=22.13.0");
expect([...ci.matchAll(/node-version:\s*["']([^"']+)["']/g)].map(match => match[1]))
  .toEqual(Array(6).fill(expectedNode));
expect([...readiness.matchAll(/node-version:\s*["']([^"']+)["']/g)].map(match => match[1]))
  .toEqual([expectedNode]);
```

- [ ] **Step 2: Run RED**

Run:

```sh
npx vitest run src/lib/runtimeVersionContract.test.ts src/lib/ciWorkflowContract.test.ts
```

Expected: failure showing workflow Node `20` values and the old contract expectation.

- [ ] **Step 3: Update workflow runtime values and the existing contract**

Change all seven workflow setup-node inputs to:

```yaml
with:
  node-version: "22.13.0"
  cache: npm
```

Update `ciWorkflowContract.test.ts` so no assertion accepts Node 20 and all jobs continue to require
`npm ci`.

- [ ] **Step 4: Run GREEN and YAML-adjacent tests**

```sh
npx vitest run src/lib/runtimeVersionContract.test.ts src/lib/ciWorkflowContract.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit**

```sh
git add .github/workflows/ci.yml .github/workflows/production-readiness.yml src/lib/ciWorkflowContract.test.ts src/lib/runtimeVersionContract.test.ts
git commit -m "fix(ci): align initial operations runtime"
```

### Task 2: Bind the verifier checkout and deployment to the same SHA

**Files:**
- Modify: `.github/workflows/production-readiness.yml`
- Modify: `scripts/verify-production-deployment.mjs`
- Modify: `src/lib/productionDeploymentVerification.test.ts`
- Create: `src/lib/productionReadinessWorkflowContract.test.ts`

- [ ] **Step 1: Add failing trusted-workflow and attestation tests**

Assert that the protected-default-branch workflow rejects a historical or user-selected SHA before
checkout, then preserves the exact checked-out HEAD and default-branch ancestry gates before any
repository-controlled command:

```ts
expect(workflow).toContain("WORKFLOW_SHA: ${{ github.sha }}");
expect(workflow).toContain('test "$OMR_PRODUCTION_EXPECTED_BUILD" = "$WORKFLOW_SHA"');
expect(workflow).toContain("ref: ${{ inputs.expected_build }}");
expect(workflow).toContain('test "$(git rev-parse --verify HEAD)" = "$OMR_PRODUCTION_EXPECTED_BUILD"');
expect(workflow).toContain(
  'git merge-base --is-ancestor "$OMR_PRODUCTION_EXPECTED_BUILD" "origin/$OMR_PRODUCTION_DEFAULT_BRANCH"',
);
```

Require `preview_deployment_id`, `preview_artifact_digest`, and
`preview_attestation_signature` workflow inputs, plus the protected
`OMR_RELEASE_ATTESTATION_SECRET`. Assert that signer and verifier share the canonical payload and
that evidence records only the attested identity:

```ts
expect(buildPreviewIdentityAttestationPayload({
  expectedBuild,
  previewDeploymentId: "dpl_preview_01",
  previewArtifactDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
})).toBe(
  `omr-preview-identity:v1\n${expectedBuild}\ndpl_preview_01\nsha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`,
);
expect(evidence.releaseIdentity).toEqual({
  verifierSha: expectedBuild,
  deployedSha: expectedBuild,
  previewDeploymentId: "dpl_preview_01",
  previewArtifactDigest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  previewIdentityAttested: true,
});
expect(JSON.stringify(evidence)).not.toContain(previewAttestationSignature);
expect(JSON.stringify(evidence)).not.toContain(releaseAttestationSecret);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/productionReadinessWorkflowContract.test.ts src/lib/productionDeploymentVerification.test.ts
```

Expected: missing pre-checkout trusted-workflow equality, ancestry ordering, domain-separated HMAC,
exact digest validation, and attested release identity fields.

- [ ] **Step 3: Add trusted exact-SHA and preview attestation gates**

Keep the job restricted to the protected default branch. Before checkout, bind
`inputs.expected_build` to the trusted workflow event by requiring exact equality with
`${{ github.sha }}` through a quoted `WORKFLOW_SHA` environment variable. Only then checkout
`inputs.expected_build` with full ancestry available. Before `actions/setup-node`, `npm ci`, or the
verifier step, require the actual HEAD to equal `expected_build` and require that commit to be an
ancestor of `origin/$OMR_PRODUCTION_DEFAULT_BRANCH`.

Add required workflow inputs `preview_deployment_id`, `preview_artifact_digest`, and
`preview_attestation_signature`, and pass the protected `OMR_RELEASE_ATTESTATION_SECRET` only to
the verifier step. Extend `resolveProductionDeploymentConfig` with:

```ts
previewDeploymentId: string;
previewArtifactDigest: `sha256:${string}`;
previewIdentityAttested: true;
```

Validate deployment IDs with `^[A-Za-z0-9._:-]{3,200}$` and digests with
`^sha256:[a-f0-9]{64}$`. Require the signature to be exactly 64 lowercase hexadecimal characters
and the attestation secret to be 32–512 non-whitespace bytes and distinct from every other
production credential. Verify HMAC-SHA256 with `timingSafeEqual` over the exported canonical
payload:

```text
omr-preview-identity:v1\n<expectedBuild>\n<previewDeploymentId>\n<previewArtifactDigest>
```

Write the verifier SHA, deployed SHA, preview deployment ID, exact artifact digest, and
`previewIdentityAttested: true` into the exclusive 0600 evidence JSON. Never write the attestation
signature or secret to config serialization, evidence, logs, or errors.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/productionReadinessWorkflowContract.test.ts src/lib/productionDeploymentVerification.test.ts
```

Expected: all focused tests pass, including historical-SHA downgrade, wrong-HEAD, non-ancestor,
legacy non-domain-separated signature, invalid attestation, and 63/65/uppercase digest failures.

- [ ] **Step 5: Commit**

```sh
git add .github/workflows/production-readiness.yml scripts/verify-production-deployment.mjs src/lib/productionDeploymentVerification.test.ts src/lib/productionReadinessWorkflowContract.test.ts
git commit -m "feat(ops): bind verifier to immutable deployment"
```

### Task 3: Make canonical table identity one generated contract

**Files:**
- Create: `scripts/canonical-table-manifest.mjs`
- Modify: `scripts/backup-restore-core.mjs`
- Modify: `src/lib/productionServerBoundaryContract.test.ts`
- Modify: `src/lib/backupRestoreCore.test.ts`
- Modify: `docs/production-readiness.md`
- Modify: `docs/operations/backup-restore-runbook.md`

- [ ] **Step 1: Write failing manifest consistency tests**

Export a manifest loader and assert every consumer uses the same sorted names:

```ts
const discovered = discoverCanonicalTables({ schemaSql, migrationSqlFiles });
expect(discovered).toHaveLength(38);
expect(discovered).toEqual([...new Set(discovered)].sort());
expect(backupCanonicalTables).toEqual(discovered);
expect(readinessDoc).toContain(`${discovered.length} canonical tables`);
expect(restoreRunbook).toContain(`${discovered.length} canonical tables`);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/productionServerBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts
```

Expected: documentation still says 37 and consumers define separate lists.

- [ ] **Step 3: Implement the manifest loader**

`canonical-table-manifest.mjs` must expose:

```js
export function discoverCanonicalTables({ schemaSql, migrationSqlFiles }) {
  const combined = [schemaSql, ...migrationSqlFiles].join("\n");
  return [...new Set([...combined.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(omr_[a-z0-9_]+)/gi)]
    .map(match => match[1]))].sort();
}
```

Use the discovered manifest in backup and boundary contract code. Keep an explicit expected count so
an accidental table silently added by a migration fails review. Update both documents to 38 and state:
`schema.sql baseline + sorted migrations = final schema`.

- [ ] **Step 4: Run GREEN and live boundary**

```sh
npx vitest run src/lib/productionServerBoundaryContract.test.ts src/lib/post023ProductionBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts
npm run test:supabase:live
```

Expected: unit contracts and PostgreSQL 17 live boundary pass.

- [ ] **Step 5: Commit**

```sh
git add scripts/canonical-table-manifest.mjs scripts/backup-restore-core.mjs src/lib/productionServerBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts docs/production-readiness.md docs/operations/backup-restore-runbook.md
git commit -m "refactor(ops): unify canonical table manifest"
```

### Task 4: Add safe severity and caller correlation to operational events

**Files:**
- Modify: `src/lib/reportError.ts`
- Modify: `src/lib/operationalEventSink.server.ts`
- Modify: `src/lib/operationalEventSink.server.test.ts`
- Modify: `src/lib/operationalInstrumentation.test.ts`

- [ ] **Step 1: Write failing event-envelope tests**

```ts
expect(event).toMatchObject({
  severity: "error",
  correlationId: "corr_01JABCDEF0123456789",
  buildSha: "0123456789012345678901234567890123456789",
});
expect(JSON.stringify(event)).not.toContain("student@example.com");
expect(buildRuntimeErrorEvent(error, { correlationId: "../unsafe" }).correlationId)
  .toMatch(/^evt_[a-f0-9]{32}$/);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/operationalEventSink.server.test.ts src/lib/operationalInstrumentation.test.ts
```

- [ ] **Step 3: Extend the bounded event contract**

Add:

```ts
export type OperationalSeverity = "info" | "warning" | "error" | "critical";
export const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
```

Accept only allowlisted severity values and safe opaque correlation IDs. Generate a new random event ID
when caller correlation is invalid. Keep event ID distinct from correlation ID, keep the 32 KiB body
limit, and continue dropping unknown context fields.

- [ ] **Step 4: Run GREEN and retry regression**

```sh
npx vitest run src/lib/operationalEventSink.server.test.ts src/lib/operationalEventSinkRetry.regression-1.test.ts src/lib/operationalInstrumentation.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/reportError.ts src/lib/operationalEventSink.server.ts src/lib/operationalEventSink.server.test.ts src/lib/operationalInstrumentation.test.ts
git commit -m "feat(ops): preserve safe event correlation"
```

### Task 5: Persist job status and enforce the 30-hour cleanup heartbeat

**Files:**
- Create: `supabase/migrations/202608080005_operational_job_status.sql`
- Create: `src/lib/operationalJobStatusGateway.server.ts`
- Create: `src/lib/operationalJobStatusGateway.server.test.ts`
- Modify: `src/app/api/internal/asset-gc/route.ts`
- Modify: `src/lib/operationsHealth.ts`
- Modify: `src/lib/operationsHealth.test.ts`
- Modify: `src/lib/productionServerBoundaryContract.test.ts`
- Modify: `src/lib/backupRestoreCore.test.ts`
- Modify: `supabase/live-test-assertions.sql`

- [ ] **Step 1: Write failing job-status tests**

```ts
expect(await readOperationalJobStatus(client, "asset_gc")).toEqual({
  status: "healthy",
  lastSuccessAt: "2026-08-08T00:00:00.000Z",
  buildSha: BUILD_SHA,
  deadCount: 0,
});
expect(evaluateAssetGcReadiness({ now, lastSuccessAt: thirtyHoursAgo, deadCount: 0 })).toBe("ready");
expect(evaluateAssetGcReadiness({ now, lastSuccessAt: olderThanThirtyHours, deadCount: 0 })).toBe("stale");
expect(evaluateAssetGcReadiness({ now, lastSuccessAt: now, deadCount: 1 })).toBe("dead_items");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/operationalJobStatusGateway.server.test.ts src/lib/operationsHealth.test.ts
```

- [ ] **Step 3: Add the service-role-only job status boundary**

The migration creates `omr_operational_job_status` keyed by a bounded job name and a service-role-only
RPCs `omr_begin_operational_job_run_v1` and `omr_complete_operational_job_run_v1`. The row stores only
bounded status, attempt/success time, durable dead count, build SHA, sanitized category, and monotonic
run generations. The GC route begins before claiming work, and an older completion cannot overwrite a
newer started generation; failure never moves `last_success_at`.

Readiness must return `not_ready` when the configured scheduler has no row, last success is more than
30 hours old, or dead count is nonzero. Missing job status cannot be inferred as healthy.

Update the canonical manifest expectation from 38 to 39 and prove the backup/boundary contracts include
`omr_operational_job_status`.

- [ ] **Step 4: Run GREEN and live SQL**

```sh
npx vitest run src/lib/operationalJobStatusGateway.server.test.ts src/lib/operationsHealth.test.ts src/lib/remoteAssetCleanupRoute.test.ts src/lib/remoteAssetCleanupRouteBehavior.test.ts
npm run test:supabase:live
```

- [ ] **Step 5: Commit**

```sh
git add supabase/migrations/202608080005_operational_job_status.sql src/lib/operationalJobStatusGateway.server.ts src/lib/operationalJobStatusGateway.server.test.ts src/app/api/internal/asset-gc/route.ts src/lib/operationsHealth.ts src/lib/operationsHealth.test.ts src/lib/productionServerBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts supabase/live-test-assertions.sql
git commit -m "feat(ops): enforce cleanup heartbeat readiness"
```

### Task 6: Add a provider-neutral synthetic alert exercise

**Files:**
- Create: `scripts/verify-operational-alert.mjs`
- Create: `src/lib/operationalAlertExercise.test.ts`
- Modify: `package.json`
- Modify: `docs/operations/release-evidence-template.md`

- [ ] **Step 1: Write failing script contract tests**

Tests inject HTTP and clock dependencies and require:

```ts
expect(result).toMatchObject({
  status: "verified",
  eventId: expect.stringMatching(/^evt_[a-f0-9]{32}$/),
  sinkReceivedAt: expect.any(String),
  alertReceivedAt: expect.any(String),
  acknowledgedAt: expect.any(String),
  resolvedAt: expect.any(String),
});
expect(result.alertReceivedAt >= result.sinkReceivedAt).toBe(true);
```

Missing receipt, mismatched event ID, timeout, non-HTTPS endpoint, or absent acknowledgement must return
`unverified` and exit 1.

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/operationalAlertExercise.test.ts
```

- [ ] **Step 3: Implement the bounded exercise**

Add `npm run ops:alert:verify`. The script emits `omr.synthetic_alert` with severity `critical`, polls
the configured receipt endpoint for the same event ID, requests acknowledgement and resolution through
adapter URLs, and writes a 0600 JSON file containing timestamps and SHA-256 but no tokens or response
bodies.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/operationalAlertExercise.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add scripts/verify-operational-alert.mjs src/lib/operationalAlertExercise.test.ts package.json docs/operations/release-evidence-template.md
git commit -m "feat(ops): verify synthetic alert delivery"
```
