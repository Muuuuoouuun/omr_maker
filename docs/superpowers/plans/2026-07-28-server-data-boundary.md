# Server Data Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise security and operational readiness above 80 by making the production data plane server-only and proving table privileges are closed.

**Architecture:** Preserve signed HMAC app sessions for this release, but require every canonical read/write to pass a same-origin server action and service-role gateway. Add a server-only RLS profile, purpose-scoped teacher mutations, and a readiness probe that verifies effective privileges rather than policy-file presence.

**Tech Stack:** Next.js Server Actions, Supabase/PostgreSQL, Vitest, SQL assertions

---

## File map

- `src/lib/productionBrowserBoundary.ts`: single decision for browser data-plane availability.
- `src/lib/omrPersistence.ts`, `src/lib/feedbackPersistence.ts`: local cache only in production.
- `src/app/actions/studentAuth.ts`, `src/app/actions/studentSession.ts`: one PBKDF2 start-code path.
- `src/app/actions/teacherAttempts.ts`, `src/lib/teacherAttemptGateway.ts`: purpose-scoped mutations.
- `supabase/migrations/202607280001_teacher_attempt_scoped_mutations.sql`: field-limited RPCs.
- `supabase/production-server-boundary.sql`: anon/authenticated canonical privilege removal.
- `supabase/migrations/202607280002_production_boundary_preflight.sql`: org-integrity preflight.
- `supabase/migrations/202607280003_service_readiness_probe_v4.sql`: effective privilege readiness.
- `scripts/verify-supabase-live.mjs`, `supabase/live-test-assertions.sql`: executable proof.

### Task 1: Disable the production browser data plane

**Files:**
- Create: `src/lib/productionBrowserBoundary.ts`
- Create: `src/lib/productionBrowserBoundary.test.ts`
- Modify: `src/lib/omrPersistence.ts`
- Modify: `src/lib/feedbackPersistence.ts`

- [ ] **Step 1: Write failing boundary tests**

```ts
expect(canUseCanonicalBrowserDataPlane({
  nodeEnv: "production",
  hasPublicSupabase: true,
})).toBe(false);

expect(canUseCanonicalBrowserDataPlane({
  nodeEnv: "development",
  hasPublicSupabase: true,
})).toBe(true);
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/productionBrowserBoundary.test.ts
```

- [ ] **Step 3: Implement the decision**

```ts
export function canUseCanonicalBrowserDataPlane(input: {
  nodeEnv: string | undefined;
  hasPublicSupabase: boolean;
}): boolean {
  return input.nodeEnv !== "production" && input.hasPublicSupabase;
}
```

Use it before constructing browser Supabase clients in both persistence modules. Do not let `OMR_PRODUCTION_RLS_APPLIED` re-enable the browser path.

- [ ] **Step 4: Add source-surface assertions**

Assert production official pages call server clients and do not call raw `saveAttempt`, `loadExams`, or `syncMergedGuestAttempts`.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/productionBrowserBoundary.test.ts src/lib/omrPersistence.test.ts src/lib/feedbackPersistence.test.ts
git add src/lib/productionBrowserBoundary.ts src/lib/productionBrowserBoundary.test.ts src/lib/omrPersistence.ts src/lib/feedbackPersistence.ts
git commit -m "security: disable canonical browser CRUD in production"
```

### Task 2: Single-source student start credentials

**Files:**
- Modify: `src/app/actions/studentAuth.ts`
- Modify: `src/app/actions/studentSession.ts`
- Modify: `src/app/teacher/users/page.tsx`
- Modify: `src/lib/studentCredentialVerifier.ts`
- Modify: `src/lib/studentCredentialVerifier.test.ts`

- [ ] **Step 1: Write failing organization-bound tests**

Verify a credential from organization A cannot authenticate the same profile ID in organization B, and metadata HMAC alone is rejected.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/studentCredentialVerifier.test.ts src/lib/studentServerAuthSurface.test.ts
```

- [ ] **Step 3: Make organization required**

Use:

```ts
export interface StudentCredentialLookup {
  organizationId: string;
  studentProfileId: string;
  code: string;
}
```

The lookup selects `omr_student_start_credentials` by both organization and profile, then verifies PBKDF2. Remove reads of start-code material from profile metadata.

- [ ] **Step 4: Use one teacher issuance action**

Teacher UI calls the dedicated `issueStudentStartCredential` server action once. On success it may cache only display status locally, never the code hash or authentication truth.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/studentCredentialVerifier.test.ts src/lib/studentServerAuthSurface.test.ts src/lib/studentAccessCode.test.ts
git add src/app/actions/studentAuth.ts src/app/actions/studentSession.ts src/app/teacher/users/page.tsx src/lib/studentCredentialVerifier.ts src/lib/studentCredentialVerifier.test.ts
git commit -m "security: unify organization-bound student credentials"
```

### Task 3: Replace broad teacher attempt mutation

**Files:**
- Create: `supabase/migrations/202607280001_teacher_attempt_scoped_mutations.sql`
- Modify: `src/app/actions/teacherAttempts.ts`
- Modify: `src/lib/teacherAttemptGateway.ts`
- Modify: `src/lib/teacherAttemptClient.ts`
- Modify: `src/lib/teacherAttemptGateway.test.ts`
- Modify: `src/app/teacher/live/page.tsx`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`

- [ ] **Step 1: Write failing tamper tests**

Attempt to send changed `score`, `student_id`, and `question_results` through answer and force-finish calls. Assert stored values remain unchanged.

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/teacherAttemptGateway.test.ts
```

- [ ] **Step 3: Add three RPCs**

Create service-role-only functions:

```sql
omr_answer_attempt_question_v1(p_organization_id text, p_attempt_id text, p_question_id text, p_answer text)
omr_set_subquestion_review_v1(p_organization_id text, p_attempt_id text, p_subquestion_id text, p_status text)
omr_force_finish_attempts_v1(p_organization_id text, p_attempt_ids text[], p_finished_at timestamptz)
```

Each updates only its allowed JSON path/status fields, verifies the stored organization, revokes `public`, `anon`, and `authenticated`, and grants execute to `service_role`.

- [ ] **Step 4: Wire purpose-specific actions**

Expose matching server actions after same-origin and signed-teacher checks. Replace UI calls to broad `saveTeacherAttempt`.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/teacherAttemptGateway.test.ts src/lib/teacherExamGateway.test.ts
git add supabase/migrations/202607280001_teacher_attempt_scoped_mutations.sql src/app/actions/teacherAttempts.ts src/lib/teacherAttemptGateway.ts src/lib/teacherAttemptClient.ts src/lib/teacherAttemptGateway.test.ts src/app/teacher/live/page.tsx src/app/teacher/attempt/[attemptId]/page.tsx
git commit -m "security: scope teacher attempt mutations"
```

### Task 4: Add organization-integrity preflight

**Files:**
- Create: `supabase/migrations/202607280002_production_boundary_preflight.sql`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `src/lib/supabaseSchemaContract.test.ts`

- [ ] **Step 1: Write failing SQL contract assertions**

Require a service-role-only function named `omr_production_boundary_preflight_v1` and JSON keys:

```json
{
  "null_organization_rows": 0,
  "orphan_rows": 0,
  "cross_organization_rows": 0,
  "students_without_credentials": 0
}
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/supabaseSchemaContract.test.ts
```

- [ ] **Step 3: Implement the SECURITY DEFINER function**

Count violations across organizations, exams, questions, attempts, results, classes, profiles, memberships, and credentials. Revoke public/anon/authenticated execute and grant service_role.

- [ ] **Step 4: Verify live SQL**

```bash
npm run test:supabase:live
```

Expected: zero violations in fixtures and explicit failure after inserting a cross-org fixture.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202607280002_production_boundary_preflight.sql supabase/live-test-assertions.sql src/lib/supabaseSchemaContract.test.ts
git commit -m "security: add organization boundary preflight"
```

### Task 5: Add the server-only RLS profile

**Files:**
- Create: `supabase/production-server-boundary.sql`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `supabase/README.md`
- Modify: `docs/production-readiness.md`

- [ ] **Step 1: Write negative privilege assertions**

For canonical and PII tables, assert `anon` and `authenticated` cannot SELECT/INSERT/UPDATE/DELETE. Assert service-role RPCs still execute.

- [ ] **Step 2: Verify RED**

```bash
npm run test:supabase:live
```

Expected: FAIL until the profile is applied by the verifier.

- [ ] **Step 3: Implement the profile**

In one transaction:

```sql
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
```

Drop every alpha allow-all policy by explicit name, enable and force RLS on canonical tables, and preserve service-role-only RPC grants.

- [ ] **Step 4: Update the verifier order**

Run baseline schema, migrations, `production-server-boundary.sql`, then live assertions.

- [ ] **Step 5: Verify and commit**

```bash
npm run test:supabase:live
git add supabase/production-server-boundary.sql supabase/live-test-assertions.sql scripts/verify-supabase-live.mjs supabase/README.md docs/production-readiness.md
git commit -m "security: add server-only production RLS profile"
```

### Task 6: Make readiness prove effective privileges

**Files:**
- Create: `supabase/migrations/202607280003_service_readiness_probe_v4.sql`
- Modify: `src/lib/supabaseReadinessProbe.ts`
- Modify: `src/lib/supabaseReadinessProbe.test.ts`
- Modify: `src/lib/deploymentReadiness.ts`
- Modify: `src/lib/deploymentReadiness.test.ts`

- [ ] **Step 1: Write failing readiness cases**

Require false when FORCE RLS exists but an alpha policy or anon table privilege remains. Require true only when:

```ts
{
  anonTablePrivilegesDenied: true,
  authenticatedCanonicalPrivilegesDenied: true,
  alphaPoliciesAbsent: true,
  organizationBackfillReady: true,
  scopedRpcPrivilegesReady: true,
}
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/supabaseReadinessProbe.test.ts src/lib/deploymentReadiness.test.ts
```

- [ ] **Step 3: Implement probe v4 and TypeScript parsing**

Query `information_schema.role_table_grants`, `pg_policies`, preflight output, and routine grants. The app treats missing or false keys as not ready.

- [ ] **Step 4: Verify**

```bash
npx vitest run src/lib/supabaseReadinessProbe.test.ts src/lib/deploymentReadiness.test.ts src/lib/examServiceReadiness.test.ts
npm run test:supabase:live
```

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/202607280003_service_readiness_probe_v4.sql src/lib/supabaseReadinessProbe.ts src/lib/supabaseReadinessProbe.test.ts src/lib/deploymentReadiness.ts src/lib/deploymentReadiness.test.ts
git commit -m "security: prove effective production privileges"
```
