# Provisioned Identity and Roster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Operate teachers through audited provisioning and let a teacher atomically issue one-time start codes to 1–100 students while revoking prior student sessions.

**Architecture:** Add three service-role PostgreSQL boundaries in dependency order: operator provisioning, student session generation, then credential batch issuance. Keep credential generation in trusted server memory, persist only password/code verifiers, and expose raw credentials once through operator or teacher UI.

**Tech Stack:** PostgreSQL 17 RPCs, Next.js Server Actions, TypeScript, PBKDF2 credential helpers, Vitest, Playwright.

---

### Task 1: Define provisioned-only identity mode

**Files:**
- Create: `src/lib/teacherIdentityMode.ts`
- Create: `src/lib/teacherIdentityMode.test.ts`
- Modify: `src/app/page.tsx`
- Create: `src/lib/teacherProvisionedOnlySurface.test.ts`
- Modify: `src/app/actions/teacherAccount.ts`

- [ ] **Step 1: Write failing policy and surface tests**

```ts
expect(resolveTeacherIdentityMode({ OMR_TEACHER_IDENTITY_MODE: "provisioned_only", NODE_ENV: "production" }))
  .toBe("provisioned_only");
expect(resolveTeacherIdentityMode({ OMR_TEACHER_IDENTITY_MODE: "bad", NODE_ENV: "production" }))
  .toBe("provisioned_only");
expect(homeSource).not.toContain('교사 계정 만들기');
expect(homeSource).toContain('운영자에게 계정 또는 비밀번호 재발급을 요청해주세요');
```

Action tests must prove `requestTeacherSignup` and `requestTeacherPasswordReset` return the stable
public code `dependency_unavailable` without calling delivery or account RPCs in provisioned-only mode.

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/teacherIdentityMode.test.ts src/lib/teacherProvisionedOnlySurface.test.ts src/lib/teacherAccountAction.test.ts
```

- [ ] **Step 3: Implement the policy and fail-closed actions**

```ts
export type TeacherIdentityMode = "provisioned_only" | "self_service";

export function resolveTeacherIdentityMode(env = process.env): TeacherIdentityMode {
  const configured = env.OMR_TEACHER_IDENTITY_MODE?.trim().toLowerCase();
  if (configured === "self_service" && env.NODE_ENV !== "production") return "self_service";
  return "provisioned_only";
}
```

Render only login and operator-contact guidance when mode is provisioned-only. Do not merely disable
the signup controls. Keep self-service code available for non-production explicit testing.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/teacherIdentityMode.test.ts src/lib/teacherProvisionedOnlySurface.test.ts src/lib/teacherAccountAction.test.ts src/lib/teacherAccountSurface.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/teacherIdentityMode.ts src/lib/teacherIdentityMode.test.ts src/app/page.tsx src/lib/teacherProvisionedOnlySurface.test.ts src/app/actions/teacherAccount.ts
git commit -m "feat(identity): add provisioned-only teacher mode"
```

### Task 2: Add atomic operator teacher and pilot provisioning

**Files:**
- Create: `supabase/migrations/202608080001_initial_operator_provisioning.sql`
- Create: `src/lib/operatorProvisioningMigrationContract.test.ts`
- Modify: `src/lib/productionServerBoundaryContract.test.ts`
- Modify: `src/lib/backupRestoreCore.test.ts`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `supabase/production-server-boundary.sql`
- Modify: `supabase/production-server-boundary-rollback.sql`

- [ ] **Step 1: Write the failing SQL contract**

Assert the migration creates `omr_pilot_plan_grants` and service-role-only
`omr_provision_pilot_teacher_v1`, with these required inputs:

```ts
expect(sql).toContain("p_idempotency_key text");
expect(sql).toContain("p_actor text");
expect(sql).toContain("p_reason text");
expect(sql).toContain("p_expires_at timestamptz");
expect(sql).toContain("for update");
expect(sql).toContain("on conflict (idempotency_key_hash)");
expect(sql).not.toMatch(/grant execute[^;]+\bto\s+(anon|authenticated)\b/i);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/operatorProvisioningMigrationContract.test.ts
```

- [ ] **Step 3: Implement the transactional RPC**

The migration must:

```text
validate bounded organization name, normalized email, display name, encoded password verifier,
plan in {pro, academy}, expiry in the future, actor, reason, and idempotency key;
hash the idempotency key before storage;
lock or create one organization;
create one active teacher account and organization membership;
insert one time-bounded pilot grant;
set the organization plan from the active grant;
append an omr_audit_logs event with actor, reason, before/after plan, expiry, and grant id;
return organization_id, account_id, grant_id, plan, expires_at, and replayed;
perform all writes in the caller transaction or no writes at all.
```

The RPC must not accept a raw password, log the verifier, or return the verifier. Replaying the same
idempotency key with different normalized input returns `idempotency_conflict`.

Update the canonical manifest expectation from 39 to 40 because the pilot grant ledger is canonical;
the backup and boundary tests must discover and protect the new table.

- [ ] **Step 4: Add live rollback, replay, and authorization assertions**

The live fixture verifies initial apply, exact replay, conflicting replay, audit insert failure rollback,
expired grant fallback to free, anon/authenticated denial, and no credential material in audit metadata.

- [ ] **Step 5: Run GREEN and live PostgreSQL**

```sh
npx vitest run src/lib/operatorProvisioningMigrationContract.test.ts src/lib/productionServerBoundaryContract.test.ts
npm run test:supabase:live
```

- [ ] **Step 6: Commit**

```sh
git add supabase/migrations/202608080001_initial_operator_provisioning.sql src/lib/operatorProvisioningMigrationContract.test.ts src/lib/productionServerBoundaryContract.test.ts src/lib/backupRestoreCore.test.ts supabase/live-test-assertions.sql supabase/production-server-boundary.sql supabase/production-server-boundary-rollback.sql
git commit -m "feat(identity): add atomic pilot provisioning"
```

### Task 3: Add the server gateway and operator CLI

**Files:**
- Create: `src/lib/operatorProvisioningGateway.server.ts`
- Create: `src/lib/operatorProvisioningGateway.test.ts`
- Create: `scripts/provision-initial-teacher.mjs`
- Create: `src/lib/operatorProvisioningCli.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing gateway tests**

```ts
const result = await provisionPilotTeacher({
  organizationName: "서울 파일럿",
  email: "teacher@example.com",
  displayName: "김교사",
  initialPassword: "Correct-Horse-2026!",
  plan: "pro",
  expiresAt: "2026-09-08T00:00:00.000Z",
  actor: "operator:launch",
  reason: "initial_pilot",
  idempotencyKey: "prov_01JABCDEF0123456789",
}, client);
expect(result).toMatchObject({ status: "provisioned", replayed: false });
expect(client.rpc).toHaveBeenCalledWith("omr_provision_pilot_teacher_v1", expect.objectContaining({
  p_email: "teacher@example.com",
  p_password_hash: expect.stringMatching(/^pbkdf2_sha256\$/),
}));
expect(JSON.stringify(result)).not.toContain("pbkdf2_sha256");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/operatorProvisioningGateway.test.ts src/lib/operatorProvisioningCli.test.ts
```

- [ ] **Step 3: Implement validation and stable result mapping**

Expose:

```ts
export type ProvisionPilotTeacherResult =
  | { status: "provisioned"; organizationId: string; accountId: string; grantId: string; plan: "pro" | "academy"; expiresAt: string; replayed: boolean }
  | { status: "rejected"; error: "invalid_input" | "conflict" | "capacity_exceeded" }
  | { status: "unavailable"; error: "dependency_unavailable" };
```

Hash the password with the existing asynchronous teacher password helper before the RPC, discard the
hash variable after the call, and never pass raw errors through the result.

- [ ] **Step 4: Implement the CLI without secret logging**

`npm run ops:teacher:provision -- --request=/absolute/0600/request.json` reads a 0600 JSON request that
contains no password, refuses a group/world-readable file, generates the initial password in process
memory, and writes it only to a new 0600 receipt when the operation is not a replay. It prints only the
receipt path, organization ID, account ID, grant ID, and expiry to stdout. The caller deletes or
securely archives the receipt after credential handoff.

- [ ] **Step 5: Run GREEN**

```sh
npx vitest run src/lib/operatorProvisioningGateway.test.ts src/lib/operatorProvisioningCli.test.ts
```

- [ ] **Step 6: Commit**

```sh
git add src/lib/operatorProvisioningGateway.server.ts src/lib/operatorProvisioningGateway.test.ts scripts/provision-initial-teacher.mjs src/lib/operatorProvisioningCli.test.ts package.json
git commit -m "feat(identity): add safe teacher provisioning cli"
```

### Task 4: Align readiness with provisioned-only operation

**Files:**
- Modify: `src/lib/deploymentReadiness.ts`
- Modify: `src/lib/deploymentReadiness.test.ts`
- Modify: `src/lib/operationsHealth.ts`
- Modify: `src/lib/operationsHealth.test.ts`
- Modify: `docs/production-readiness.md`

- [ ] **Step 1: Write failing readiness-mode tests**

```ts
expect(await evaluateReadiness(provisionedEnv, dependencies)).toMatchObject({
  status: "ready",
  teacherIdentity: "provisioned_only",
});
expect(dependencies.probeTeacherDelivery).not.toHaveBeenCalled();
expect(await evaluateReadiness(selfServiceEnv, dependencies)).toMatchObject({ status: "not_ready" });
expect(dependencies.probeTeacherDelivery).toHaveBeenCalled();
```

Provisioned mode must fail when the operator provisioning RPC is missing, the canary active account
cannot validate, or the active pilot grant/audit check fails.

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/deploymentReadiness.test.ts src/lib/operationsHealth.test.ts
```

- [ ] **Step 3: Implement mode-specific readiness**

In `provisioned_only`, require the provisioning boundary version and a side-effect-free configured
canary lookup but do not require email delivery. In `self_service`, continue requiring the delivery
probe. The response contains only stable check names and never the canary email, account ID, grant ID,
or database error.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/deploymentReadiness.test.ts src/lib/operationsHealth.test.ts src/lib/operationsHealthRoutes.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/deploymentReadiness.ts src/lib/deploymentReadiness.test.ts src/lib/operationsHealth.ts src/lib/operationsHealth.test.ts docs/production-readiness.md
git commit -m "feat(identity): align readiness with provisioned mode"
```

### Task 5: Add student session generation and request-time validation

**Files:**
- Create: `supabase/migrations/202608080002_student_session_generation.sql`
- Create: `src/lib/studentSessionRevocation.test.ts`
- Modify: `src/lib/studentServerSession.ts`
- Modify: `src/app/actions/studentAuth.ts`
- Modify: `src/app/actions/studentSession.ts`
- Modify: `supabase/live-test-assertions.sql`

- [ ] **Step 1: Write failing generation tests**

```ts
expect(decoded).toMatchObject({ version: 2, credentialGeneration: 3 });
expect(await validateStudentServerSession(oldCookie)).toEqual({ status: "unauthenticated" });
expect(await validateStudentServerSession(currentCookie)).toMatchObject({ status: "active" });
```

Tests also cover disabled/withdrawn students, another organization, malformed generation, gateway
timeout, and a version-1 cookie.

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/studentSessionRevocation.test.ts src/lib/studentSessionRecoveryFlow.test.ts
```

- [ ] **Step 3: Implement schema and RPC changes**

Add `credential_generation integer not null default 1` to the student credential boundary and expose
service-role-only `omr_validate_student_session_v1(account_id, organization_id, student_id,
credential_generation)`. The lookup used during login returns generation. Credential rotation and
student deactivation increment it in the same transaction.

- [ ] **Step 4: Sign version-2 cookies and fail closed on every canonical request**

```ts
export interface StudentServerSessionV2 {
  version: 2;
  accountId: string;
  organizationId: string;
  studentId: string;
  credentialGeneration: number;
  issuedAt: number;
  expiresAt: number;
}
```

Version-1 cookies are rejected after a short explicit migration grace only in non-production. Every
canonical student action resolves and validates the signed version-2 session before data access.

- [ ] **Step 5: Run GREEN and live concurrency assertions**

```sh
npx vitest run src/lib/studentSessionRevocation.test.ts src/lib/studentSessionRecoveryFlow.test.ts src/lib/studentSessionOriginGuard.test.ts
npm run test:supabase:live
```

- [ ] **Step 6: Commit**

```sh
git add supabase/migrations/202608080002_student_session_generation.sql src/lib/studentSessionRevocation.test.ts src/lib/studentServerSession.ts src/app/actions/studentAuth.ts src/app/actions/studentSession.ts supabase/live-test-assertions.sql
git commit -m "feat(students): revoke sessions on credential rotation"
```

### Task 6: Add all-or-none start-code batch issuance

**Files:**
- Create: `supabase/migrations/202608080003_student_start_code_batch.sql`
- Create: `src/lib/studentCredentialBatchMigrationContract.test.ts`
- Create: `src/lib/studentCredentialBatchGateway.server.ts`
- Create: `src/lib/studentCredentialBatchGateway.test.ts`
- Modify: `src/app/actions/studentAuth.ts`
- Modify: `supabase/live-test-assertions.sql`

- [ ] **Step 1: Write failing gateway and SQL contract tests**

```ts
expect(validateCredentialBatch([])).toEqual({ ok: false, error: "invalid_input" });
expect(validateCredentialBatch(Array.from({ length: 101 }, row))).toEqual({ ok: false, error: "capacity_exceeded" });
expect(await issueStudentCredentialBatch(input, client)).toMatchObject({
  status: "issued",
  count: 100,
  replayed: false,
});
```

The SQL test requires `omr_issue_student_start_code_batch_v1`, a 1–100 JSON array bound, organization
and role checks, `FOR UPDATE` student locks, verifier-only persistence, generation increments, hashed
idempotency, and an audit summary without raw codes.

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/studentCredentialBatchMigrationContract.test.ts src/lib/studentCredentialBatchGateway.test.ts
```

- [ ] **Step 3: Implement the atomic RPC**

Accept a JSON array of `{ studentId, verifier }`, deduplicate student IDs before the call, require every
student to be active and in the signed teacher organization, and update all rows or none. Replaying the
same idempotency key returns `already_applied`; it never returns or reconstructs prior raw codes.

- [ ] **Step 4: Implement the server action**

```ts
export type IssuedStudentCredential = { studentId: string; startCode: string };
export type IssueStudentCredentialBatchResult =
  | { status: "issued"; credentials: IssuedStudentCredential[]; idempotencyKey: string }
  | { status: "rejected"; error: "invalid_input" | "forbidden" | "capacity_exceeded" | "conflict" }
  | { status: "unavailable"; error: "dependency_unavailable" };
```

Generate strong raw codes in server memory, hash each with the existing helper, call the RPC once, and
return raw codes only for the first successful non-replay response.

- [ ] **Step 5: Run GREEN and live rollback/concurrency cases**

```sh
npx vitest run src/lib/studentCredentialBatchMigrationContract.test.ts src/lib/studentCredentialBatchGateway.test.ts src/lib/studentCredentialIssuanceAction.test.ts
npm run test:supabase:live
```

- [ ] **Step 6: Commit**

```sh
git add supabase/migrations/202608080003_student_start_code_batch.sql src/lib/studentCredentialBatchMigrationContract.test.ts src/lib/studentCredentialBatchGateway.server.ts src/lib/studentCredentialBatchGateway.test.ts src/app/actions/studentAuth.ts supabase/live-test-assertions.sql
git commit -m "feat(roster): issue student codes atomically"
```

### Task 7: Add one-time credential CSV and teacher batch UX

**Files:**
- Create: `src/lib/studentCredentialCsv.ts`
- Create: `src/lib/studentCredentialCsv.test.ts`
- Create: `src/components/StudentCredentialBatchDialog.tsx`
- Create: `src/lib/studentCredentialBatchSurface.test.ts`
- Modify: `src/app/teacher/users/page.tsx`
- Create: `e2e/student-credential-batch.spec.ts`

- [ ] **Step 1: Write failing CSV and surface tests**

```ts
expect(csv.charCodeAt(0)).toBe(0xfeff);
expect(csv).toContain("student_id,name,group,start_code");
expect(csv.split("\r\n")).toHaveLength(102);
expect(surface).toContain("선택 학생 코드 발급");
expect(surface).toContain("기존 로그인 세션도 즉시 종료됩니다");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/studentCredentialCsv.test.ts src/lib/studentCredentialBatchSurface.test.ts
```

- [ ] **Step 3: Implement deterministic CSV generation**

```ts
export function serializeStudentCredentialCsv(rows: readonly StudentCredentialCsvRow[]): string {
  return `\uFEFF${serializeCsvRows([
    ["student_id", "name", "group", "start_code"],
    ...rows.map(row => [row.studentId, row.name, row.group, row.startCode]),
  ])}`;
}
```

Reject duplicate/missing rows and preserve the server result order.

- [ ] **Step 4: Implement secret-state lifecycle in the dialog**

Support selected students only, show 1–100 count, require a rotation confirmation, call one Server
Action, create one Blob URL, and revoke the URL plus clear credential arrays on close, unmount, successful
download, and navigation. After a download failure, retain the still-current result and allow retry. Do
not claim a server rollback when CSV creation fails after issuance.

- [ ] **Step 5: Add the browser journey**

The E2E test selects two disposable students, issues codes, downloads CSV, asserts header and two rows,
closes the dialog, confirms codes are no longer visible, logs one student in, rotates that student, and
proves the prior cookie and prior code are rejected.

- [ ] **Step 6: Run GREEN**

```sh
npx vitest run src/lib/studentCredentialCsv.test.ts src/lib/studentCredentialBatchSurface.test.ts
npx playwright test --project=chromium --workers=1 --retries=0 e2e/student-credential-batch.spec.ts
```

- [ ] **Step 7: Commit**

```sh
git add src/lib/studentCredentialCsv.ts src/lib/studentCredentialCsv.test.ts src/components/StudentCredentialBatchDialog.tsx src/lib/studentCredentialBatchSurface.test.ts src/app/teacher/users/page.tsx e2e/student-credential-batch.spec.ts
git commit -m "feat(roster): export one-time student credentials"
```
