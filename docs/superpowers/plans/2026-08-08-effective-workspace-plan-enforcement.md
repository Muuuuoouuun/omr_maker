# Effective Workspace Plan Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce current provisioned identity, organization topology, session generation, and effective workspace plan in the same PostgreSQL transaction as every active paid mutation or storage authorization.

**Architecture:** Migration `202608080008_effective_workspace_plan_enforcement.sql` adds private exact authorization helpers and non-overloaded public vNext RPCs. Every teacher mutation receives the signed account ID and generation, validates them before any replay, and resolves the effective plan from the pilot grant ledger in the mutation transaction. Student storage and targeted-attempt triggers derive the same exact organization entitlement without trusting browser state. Already-committed database mutation receipts may replay after entitlement expiry only after current identity validation; storage prepare/finalize never issues new capability after expiry. Old caller-trusting and generic service-role entry points are revoked.

**Tech Stack:** PostgreSQL 17, Supabase service-role RPCs, Next.js Server Actions, TypeScript, Vitest, live PostgreSQL assertions, Playwright.

---

### Task 1: Freeze the active paid call graph and RED contract

**Files:**
- Create: `src/lib/effectiveWorkspacePlanEnforcementMigrationContract.test.ts`
- Create: `docs/superpowers/plans/2026-08-08-effective-workspace-plan-enforcement.md`

- [ ] **Step 1: Assert the exact migration number, private authorization helpers, vNext public signatures, old-entry revocations, and absence of `organizations.plan` in every paid decision body.**
- [ ] **Step 2: Assert receipt-bearing mutations validate identity before receipt replay, while storage prepares validate identity and plan before every retry.**
- [ ] **Step 3: Run the focused contract and record the expected missing-migration RED.**

### Task 2: Add exact in-transaction authorization helpers

**Files:**
- Create: `supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql`
- Modify: `src/lib/effectiveWorkspacePlanEnforcementMigrationContract.test.ts`

- [ ] **Step 1: Add a private teacher helper accepting exact account, session generation, and organization identifiers.**
- [ ] **Step 2: Reproduce the exact validator topology under table/row locks, then reuse `omr_read_effective_workspace_plan_v1`; reject role/profile/membership/grant provenance drift.**
- [ ] **Step 3: Add a private organization helper for student-owned paths that proves the exact sole provisioned owner graph and returns only the current effective plan.**
- [ ] **Step 4: Deny public, anon, authenticated, and service_role execution on all private helpers; set owner, empty search path, and bounded timeouts.**
- [ ] **Step 5: Run the migration contract GREEN.**

### Task 3: Replace roster, exam, feedback, and assignment mutations

**Files:**
- Modify: `supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql`
- Modify: `src/lib/teacherRosterGateway.ts`
- Modify: `src/lib/teacherRosterGateway.test.ts`
- Modify: `src/lib/teacherExamGateway.ts`
- Modify: `src/lib/teacherExamGateway.test.ts`
- Modify: `src/lib/feedbackServerGateway.ts`
- Modify: `src/lib/feedbackServerGateway.test.ts`
- Modify: `src/lib/individualAssignmentGateway.ts`
- Modify: `src/lib/individualAssignmentGateway.test.ts`

- [ ] **Step 1: Add vNext non-overloaded roster and exam RPCs with account ID and session generation.**
- [ ] **Step 2: Validate current identity before exact committed receipt replay; require current effective plan before new paid mutation work.**
- [ ] **Step 3: Add vNext feedback save/return RPCs and revoke public service-role access to paid v2/v3 bypass signatures.**
- [ ] **Step 4: Add vNext assign/clear RPCs, replace targeted assignment trigger plan reads with exact effective entitlement, and revoke old public signatures.**
- [ ] **Step 5: Update gateways to pass exact signed account identity and generation and assert exactly one vNext RPC call.**
- [ ] **Step 6: Run focused gateway and SQL contract tests GREEN.**

### Task 4: Replace teacher asset authorization and remove generic metadata bypass

**Files:**
- Modify: `supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql`
- Modify: `src/lib/remoteAssetGateway.server.ts`
- Modify: `src/lib/remoteAssetGateway.server.test.ts`
- Modify: `src/app/actions/remoteAssets.ts`
- Modify: `src/app/actions/remoteAssets.test.ts`

- [ ] **Step 1: Add vNext prepare, authorize-finalize, and finalize RPCs with exact account, generation, and organization binding in each transaction.**
- [ ] **Step 2: Require current effective paid plan before every prepare retry and cap new intent expiry at the current grant expiry.**
- [ ] **Step 3: Revalidate identity and plan both before Storage inspection and during finalization; never issue a new signed URL after expiry.**
- [ ] **Step 4: Revoke `omr_save_remote_asset_metadata_v1(jsonb)` and all superseded public teacher asset signatures.**
- [ ] **Step 5: Remove the second generic metadata write from upload gateway flows.**
- [ ] **Step 6: Run focused asset tests GREEN.**

### Task 5: Enforce student handwriting entitlement atomically

**Files:**
- Modify: `supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql`
- Modify: `src/lib/studentAttemptHandwritingGateway.server.ts`
- Modify: `src/lib/studentAttemptHandwritingGateway.server.test.ts`
- Modify: `src/app/actions/remoteAssets.ts`

- [ ] **Step 1: Add non-overloaded handwriting prepare and attach RPCs that derive current organization entitlement in the same transaction.**
- [ ] **Step 2: Keep submitted-session and completed-attempt ownership checks, require paid entitlement for each new upload capability, and cap intent expiry at grant expiry.**
- [ ] **Step 3: Remove the separate TypeScript plan precheck as an authority decision and remove generic metadata persistence.**
- [ ] **Step 4: Revoke old handwriting public signatures and run focused tests GREEN.**

### Task 6: Replace caller-trusting plan-usage RPCs

**Files:**
- Modify: `supabase/migrations/202608080008_effective_workspace_plan_enforcement.sql`
- Modify: `src/lib/serverPlan.ts`
- Modify: `src/lib/serverPlan.test.ts`
- Modify: `src/app/actions/premiumAccess.ts`
- Modify: `src/app/actions/premiumAccess.test.ts`

- [ ] **Step 1: Add account/session-bound reserve, release, and sync v2 RPCs that compute limits from current effective plan rather than caller-provided plan/limit values.**
- [ ] **Step 2: Revoke the old service-role reserve/release/sync signatures.**
- [ ] **Step 3: Thread exact signed account identity into the server plan store and assert no account authority can use legacy calls.**
- [ ] **Step 4: Run focused plan gateway and action tests GREEN.**

### Task 7: Prove live PostgreSQL behavior and concurrency

**Files:**
- Modify: `supabase/live-test-assertions.sql`

- [ ] **Step 1: Add valid active grant fixtures for every vNext mutation family and prove forged `organizations.plan` is ignored.**
- [ ] **Step 2: Prove expired, superseded, missing, wrong-account, wrong-org, stale-generation, membership/profile drift, and non-owner identities fail without mutation.**
- [ ] **Step 3: Prove exact committed database receipts replay after expiry only when identity is still current; storage prepares/finalizers do not mint or complete new capabilities after expiry.**
- [ ] **Step 4: Add two-connection grant-expiry/supersession races against each mutation class and verify serialization leaves no unauthorized committed state.**
- [ ] **Step 5: Prove old and generic signatures are denied to service_role, anon, and authenticated while exact vNext service calls succeed.**
- [ ] **Step 6: Run `npm run test:supabase:live` GREEN with the final marker last.**

### Task 8: Propagate readiness, rollback, and operator evidence

**Files:**
- Modify: `supabase/production-server-boundary.sql`
- Modify: `supabase/production-server-boundary-rollback.sql`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `src/lib/supabaseReadinessProbe.ts`
- Modify: `src/lib/productionServerBoundaryContract.test.ts`
- Modify: `src/lib/backupRestoreCore.test.ts`
- Modify: `docs/production-readiness.md`
- Modify: `docs/production-deployment.md`
- Modify: `docs/superpowers/plans/2026-08-08-initial-operations-100-release-master.md`

- [ ] **Step 1: Bump the honest readiness version to `202608080008` without changing the canonical table count.**
- [ ] **Step 2: Add named effective-plan-enforcement readiness with exact signatures, owners, result types, ACLs, proconfig, comments, and function body digests; reject extra overloads.**
- [ ] **Step 3: Add live semantic body-drift and overload-drift tests with exact restoration.**
- [ ] **Step 4: Update rollback assertions and backup/version consumers; preserve historical migrations.**
- [ ] **Step 5: Document that Phase C closes mutation-transaction entitlement races while Storage object inspection still requires the explicit two-transaction revalidation protocol.**

### Task 9: Full verification and independent review

**Files:**
- Modify: only files identified by failing verification or review with a new isolated RED.

- [ ] **Step 1: Run all focused Vitest suites.**
- [ ] **Step 2: Run full Vitest, TypeScript, ESLint, production build, route budgets, production browser tests, and production diff check.**
- [ ] **Step 3: Run a security self-review of old entry-point revocations, replay ordering, grant-expiry bounds, and exact account/session propagation.**
- [ ] **Step 4: Request independent read-only review and resolve every P0/P1 with a new RED.**
- [ ] **Step 5: Commit only after every gate is GREEN.**
