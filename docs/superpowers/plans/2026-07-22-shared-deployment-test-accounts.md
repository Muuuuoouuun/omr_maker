# Shared Deployment Test Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate all synthetic analytics data to the public mockup account and make one admin, three teacher, and three student test accounts work against one shared Vercel/Supabase workspace with account-specific plan ceilings.

**Architecture:** Extend the existing environment-backed teacher credential and signed-session contracts with an explicit organization, organization name, member role, and signed plan ceiling. Keep the Supabase organization on Academy, compute the effective server plan as the lower of the organization plan and signed account ceiling, and seed only minimal real test roster rows; synthetic analytics remain display-only for `omr-showcase`.

**Tech Stack:** Next.js 16 server actions, TypeScript, Vitest, Supabase Postgres/service-role client, Vercel CLI, Node.js deployment scripts.

---

## File map

- Modify `src/lib/teacherAuth.ts`: parse and validate shared workspace metadata and return it after login.
- Modify `src/lib/teacherSession.ts`: preserve shared workspace metadata and plan ceiling in browser/server session payloads.
- Modify `src/lib/workspaceContext.ts`: honor explicit organization IDs while keeping stable per-actor IDs and member roles.
- Modify `src/lib/serverPlan.ts`: cap organization plan by the signed account plan.
- Modify `src/lib/supabaseServerAdmin.ts`: bootstrap the configured member role instead of always writing `owner`.
- Modify `src/lib/demoData.ts`: make demo eligibility identity-based rather than environment-based.
- Modify `src/app/teacher/dashboard/page.tsx`, `src/app/teacher/users/page.tsx`, `src/app/teacher/live/page.tsx`: request synthetic data only for the mockup identity.
- Create `scripts/deployment-test-accounts-core.mjs`: deterministic fixture definitions, hash builders, Supabase row builders, and secret-safe Vercel payload construction.
- Create `scripts/setup-deployment-test-accounts.mjs`: authenticated Vercel environment update, Supabase upsert, and read-only verification CLI.
- Modify `package.json`: expose dry-run, apply, and verify scripts.
- Modify focused tests beside each library and `src/lib/uiSurface.test.ts`.
- Modify `README.md` and `docs/deployment-test-accounts.md`: document the shared test login URL and credentials.

### Task 1: Carry shared workspace identity through teacher authentication and signed sessions

**Files:**
- Modify: `src/lib/teacherAuth.ts`
- Modify: `src/lib/teacherAuth.test.ts`
- Modify: `src/lib/teacherSession.ts`
- Modify: `src/lib/teacherSession.test.ts`
- Modify: `src/lib/teacherServerSession.test.ts`

- [ ] **Step 1: Write failing credential parsing tests**

Add a production `TEACHER_ACCOUNTS` case to `src/lib/teacherAuth.test.ts`:

```ts
it("returns signed shared-workspace metadata for a deployment account", () => {
    const env = {
        NODE_ENV: "production",
        TEACHER_ACCOUNTS: JSON.stringify([{
            id: "teacher2",
            email: "teacher2@omr.test",
            name: "강사 2",
            password: "teacher1234",
            plan: "pro",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher",
        }]),
    };

    expect(resolveTeacherCredentials(env)[0]).toMatchObject({
        organizationId: "teacher_sharedqa",
        organizationName: "OMR Maker 테스트",
        memberRole: "teacher",
        plan: "pro",
    });
    expect(verifyTeacherLogin("teacher2", "teacher1234", env).teacher).toMatchObject({
        teacherId: "teacher2",
        organizationId: "teacher_sharedqa",
        organizationName: "OMR Maker 테스트",
        memberRole: "teacher",
        plan: "pro",
    });
});

it("rejects invalid explicit workspace metadata", () => {
    const credentials = resolveTeacherCredentials({
        NODE_ENV: "production",
        TEACHER_ACCOUNTS: JSON.stringify([
            { id: "bad-org", password: "pass", organizationId: "../../escape", memberRole: "teacher" },
            { id: "bad-role", password: "pass", organizationId: "teacher_sharedqa", memberRole: "superadmin" },
            { id: "bad-plan", password: "pass", organizationId: "teacher_sharedqa", memberRole: "teacher", plan: "ultra" },
        ]),
    });
    expect(credentials).toEqual([]);
});
```

- [ ] **Step 2: Run the auth tests and confirm failure**

Run: `npm test -- --run src/lib/teacherAuth.test.ts`

Expected: FAIL because workspace fields are not parsed and invalid metadata rows are still accepted.

- [ ] **Step 3: Implement validated credential metadata**

Add these contracts and validation to `src/lib/teacherAuth.ts`:

```ts
export type OrganizationMemberRole = "owner" | "admin" | "teacher" | "assistant" | "viewer";
export const TEACHER_ORGANIZATION_ID_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16})$/;
const MEMBER_ROLES = new Set<OrganizationMemberRole>(["owner", "admin", "teacher", "assistant", "viewer"]);

export interface TeacherCredential {
    id: string;
    email: string;
    name: string;
    password?: string;
    passwordHash?: string;
    plan?: PlanKey;
    organizationId?: string;
    organizationName?: string;
    memberRole?: OrganizationMemberRole;
}

export interface TeacherLoginIdentity {
    teacherId: string;
    email: string;
    displayName: string;
    plan?: PlanKey;
    organizationId?: string;
    organizationName?: string;
    memberRole?: OrganizationMemberRole;
}
```

In `credentialFromRecord`, normalize the optional fields, reject a supplied invalid plan/organization/role, and copy the validated values into the credential. Copy those values in `verifyTeacherLogin` as well.

- [ ] **Step 4: Write and run signed-session preservation tests**

Extend `src/lib/teacherSession.test.ts` and `src/lib/teacherServerSession.test.ts` with an identity containing:

```ts
{
    teacherId: "teacher2",
    organizationId: "teacher_sharedqa",
    organizationName: "OMR Maker 테스트",
    memberRole: "teacher",
    plan: "pro",
}
```

Assert that `createTeacherSession`, `parseTeacherSession`, `createSignedTeacherSessionCookie`, and `parseSignedTeacherSessionCookie` preserve every field. Run:

`npm test -- --run src/lib/teacherSession.test.ts src/lib/teacherServerSession.test.ts`

Expected before implementation: FAIL because `TeacherSessionIdentity` drops the fields.

- [ ] **Step 5: Preserve optional fields without breaking schema version 1**

Add the optional fields to `TeacherSession` and `TeacherSessionIdentity`, normalize them in `createTeacherSession` and `parseTeacherSession`, and keep `schemaVersion: 1` so old sessions without the fields remain valid.

- [ ] **Step 6: Run focused tests and commit**

Run: `npm test -- --run src/lib/teacherAuth.test.ts src/lib/teacherSession.test.ts src/lib/teacherServerSession.test.ts`

Expected: all tests PASS.

Commit only the five files:

```bash
git add src/lib/teacherAuth.ts src/lib/teacherAuth.test.ts src/lib/teacherSession.ts src/lib/teacherSession.test.ts src/lib/teacherServerSession.test.ts
git commit -m "feat(auth): support shared deployment workspaces"
```

### Task 2: Share one workspace while enforcing account plan ceilings

**Files:**
- Modify: `src/lib/workspaceContext.ts`
- Modify: `src/lib/workspaceContext.test.ts`
- Modify: `src/lib/supabaseServerAdmin.ts`
- Modify: `src/lib/supabaseServerAdmin.test.ts`
- Modify: `src/lib/serverPlan.ts`
- Modify: `src/lib/serverPlan.test.ts`

- [ ] **Step 1: Write failing workspace and role tests**

Add tests showing `admin` and `teacher1` have the same organization but different actor IDs and member roles:

```ts
const admin = workspaceContextFromIdentity({
    teacherId: "admin",
    organizationId: "teacher_sharedqa",
    organizationName: "OMR Maker 테스트",
    memberRole: "admin",
});
const teacher = workspaceContextFromIdentity({
    teacherId: "teacher1",
    organizationId: "teacher_sharedqa",
    organizationName: "OMR Maker 테스트",
    memberRole: "teacher",
});

expect(admin.organizationId).toBe("teacher_sharedqa");
expect(teacher.organizationId).toBe("teacher_sharedqa");
expect(admin.actorUserId).not.toBe(teacher.actorUserId);
expect(workspaceBootstrapRows(admin).member?.role).toBe("admin");
expect(workspaceBootstrapRows(teacher).member?.role).toBe("teacher");
```

Run: `npm test -- --run src/lib/workspaceContext.test.ts src/lib/supabaseServerAdmin.test.ts`

Expected: FAIL because the organization is still derived per teacher and bootstrap always writes `owner`.

- [ ] **Step 2: Implement explicit organization and member role context**

Extend `WorkspaceIdentity` and `WorkspaceContext` with `organizationId`, `organizationName`, and `memberRole`. In `workspaceContextFromIdentity`, use a valid explicit organization ID when present, but continue deriving `teacher_<hash>` for legacy identities. Always derive `actorUserId` from `teacherId`/email so shared members remain distinct. Use `context.memberRole || "owner"` in `workspaceBootstrapRows`.

- [ ] **Step 3: Write failing plan ceiling tests**

In `src/lib/serverPlan.test.ts`, create an Academy store and four signed sessions:

```ts
const store = {
    source: "supabase" as const,
    readPlan: async () => "academy" as const,
    readUsage: async () => 0,
    reserveUsage: async () => ({ allowed: true, used: 0 }),
    releaseUsage: async () => ({ released: false, used: 0 }),
    syncStudentUsage: async () => ({ allowed: true, used: 0 }),
};
const session = (teacherId: string, plan: "free" | "pro" | "academy") => createTeacherSession(TOKEN, Date.now(), {
    teacherId,
    organizationId: "teacher_sharedqa",
    plan,
});

await expect(resolveServerPlanAccess(session("admin", "academy"), { store })).resolves.toMatchObject({ plan: "academy" });
await expect(resolveServerPlanAccess(session("teacher1", "free"), { store })).resolves.toMatchObject({ plan: "free" });
await expect(resolveServerPlanAccess(session("teacher2", "pro"), { store })).resolves.toMatchObject({ plan: "pro" });
await expect(resolveServerPlanAccess(session("teacher3", "academy"), { store })).resolves.toMatchObject({ plan: "academy" });
```

Also assert that an Academy ceiling cannot elevate a Free organization.

- [ ] **Step 4: Implement lower-plan selection**

Add a pure helper to `src/lib/serverPlan.ts`:

```ts
const PLAN_RANK: Record<PlanKey, number> = { free: 0, pro: 1, academy: 2 };

export function applyPlanCeiling(organizationPlan: PlanKey, ceiling?: PlanKey): PlanKey {
    return ceiling && PLAN_RANK[ceiling] < PLAN_RANK[organizationPlan] ? ceiling : organizationPlan;
}
```

After reading the organization plan in `resolveServerPlanAccess`, return `applyPlanCeiling(organizationPlan, session.plan)`. Keep all quota reads and reservations scoped to the shared organization ID.

- [ ] **Step 5: Run focused tests and commit**

Run:

`npm test -- --run src/lib/workspaceContext.test.ts src/lib/supabaseServerAdmin.test.ts src/lib/serverPlan.test.ts`

Expected: all tests PASS.

Commit:

```bash
git add src/lib/workspaceContext.ts src/lib/workspaceContext.test.ts src/lib/supabaseServerAdmin.ts src/lib/supabaseServerAdmin.test.ts src/lib/serverPlan.ts src/lib/serverPlan.test.ts
git commit -m "feat(plans): cap shared workspace access per teacher"
```

### Task 3: Restrict synthetic data to the mockup account

**Files:**
- Modify: `src/lib/demoData.ts`
- Modify: `src/lib/demoData.test.ts`
- Modify: `src/app/teacher/dashboard/page.tsx`
- Modify: `src/app/teacher/users/page.tsx`
- Modify: `src/app/teacher/live/page.tsx`
- Modify: `src/lib/uiSurface.test.ts`

- [ ] **Step 1: Replace environment gating tests with identity gating tests**

Change `src/lib/demoData.test.ts` to assert:

```ts
expect(shouldUseDemoData({ teacherId: "omr-showcase" })).toBe(true);
expect(shouldUseDemoData({ teacherId: "admin" })).toBe(false);
expect(shouldUseDemoData({ teacherId: "teacher1" })).toBe(false);
expect(shouldUseDemoData(null)).toBe(false);
```

Add source-surface assertions that dashboard demo forcing is inside `isMockupAccount`, and users/live call demo gating with the current teacher session rather than `NODE_ENV`.

- [ ] **Step 2: Run tests and confirm failure**

Run: `npm test -- --run src/lib/demoData.test.ts src/lib/uiSurface.test.ts`

Expected: FAIL because `shouldUseDemoData` still accepts a node environment string and regular development accounts still receive examples.

- [ ] **Step 3: Make demo eligibility identity-only**

Implement:

```ts
import { isMockupTeacherIdentity } from "@/lib/mockupAccount";
import type { TeacherSessionIdentity } from "@/lib/teacherSession";

export function shouldUseDemoData(identity: Partial<TeacherSessionIdentity> | null | undefined): boolean {
    return isMockupTeacherIdentity(identity);
}
```

In the dashboard, remove `allowDemoData` and seed demo data only through the existing `forceDemoData` branch entered by `isMockupAccount`. In users and live pages, read the active teacher session and pass it to `shouldUseDemoData`; initialize regular accounts with empty real collections. Preserve display-only behavior and the legacy localStorage cleanup.

- [ ] **Step 4: Run focused tests and commit**

Run: `npm test -- --run src/lib/demoData.test.ts src/lib/uiSurface.test.ts`

Expected: all tests PASS.

Commit:

```bash
git add src/lib/demoData.ts src/lib/demoData.test.ts src/app/teacher/dashboard/page.tsx src/app/teacher/users/page.tsx src/app/teacher/live/page.tsx src/lib/uiSurface.test.ts
git commit -m "fix(demo): isolate samples to the mockup account"
```

### Task 4: Build a secret-safe deployment fixture CLI

**Files:**
- Create: `scripts/deployment-test-accounts-core.mjs`
- Create: `scripts/deployment-test-accounts-core.test.mjs`
- Create: `scripts/setup-deployment-test-accounts.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing fixture tests**

Test that the core module returns four teacher accounts and three students, never includes plaintext teacher passwords in the Vercel JSON, binds all rows to `teacher_sharedqa`, and creates verifiable student hashes:

```js
import { describe, expect, it } from "vitest";
import {
    buildDeploymentFixture,
    verifyTeacherPasswordHash,
    verifyStudentStartCodeHash,
} from "./deployment-test-accounts-core.mjs";

describe("deployment test account fixture", () => {
    it("builds shared accounts without plaintext teacher passwords", () => {
        const fixture = buildDeploymentFixture({ studentSessionSecret: "student-secret", now: "2026-07-22T00:00:00.000Z" });
        expect(fixture.organization.id).toBe("teacher_sharedqa");
        expect(fixture.teacherAccounts.map(account => account.plan)).toEqual(["academy", "free", "pro", "academy"]);
        expect(fixture.teacherAccounts.map(account => account.memberRole)).toEqual(["admin", "teacher", "teacher", "teacher"]);
        expect(JSON.stringify(fixture.teacherAccounts)).not.toContain("admin1234");
        expect(JSON.stringify(fixture.teacherAccounts)).not.toContain("teacher1234");
        expect(verifyTeacherPasswordHash("admin1234", fixture.teacherAccounts[0].passwordHash)).toBe(true);
        expect(fixture.students).toHaveLength(3);
        expect(verifyStudentStartCodeHash("ABC234", fixture.studentCredentials[0].start_code_hash)).toBe(true);
    });
});
```

- [ ] **Step 2: Run the fixture test and confirm failure**

Run: `npm test -- --run scripts/deployment-test-accounts-core.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement fixture builders**

Create a pure Node ESM module using `pbkdf2Sync`, `randomBytes`, and `createHmac` with this implementation shape:

```js
import { createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const SHARED_ORGANIZATION_ID = "teacher_sharedqa";
export const SHARED_CLASS_ID = "teacher_sharedqa_test_class";
export const TEACHER_LOGIN_PASSWORDS = { admin: "admin1234", teacher1: "teacher1234", teacher2: "teacher1234", teacher3: "teacher1234" };
export const STUDENT_START_CODES = { student1: "ABC234", student2: "BCD345", student3: "CDE456" };

function encodedPbkdf2(value, iterations = 120_000, salt = randomBytes(16)) {
    const hash = pbkdf2Sync(value, salt, iterations, 32, "sha256");
    return `pbkdf2-sha256:${iterations}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function verifyEncodedPbkdf2(value, encoded) {
    const [algorithm, iterationsRaw, saltHex, hashHex] = encoded.split(":");
    if (algorithm !== "pbkdf2-sha256") return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = pbkdf2Sync(value, Buffer.from(saltHex, "hex"), Number(iterationsRaw), expected.length, "sha256");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function stableWorkspaceHash(value) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
}

export function teacherPasswordHash(password) {
    return encodedPbkdf2(password);
}

export function studentStartCodeHash(code) {
    return encodedPbkdf2(code.replace(/\s/g, "").toUpperCase());
}

export function studentMetadata(code, studentId, organizationId, secret, now) {
    const normalized = code.replace(/\s/g, "").toUpperCase();
    const hash = createHmac("sha256", secret)
        .update(`${organizationId}\u0000${studentId}\u0000${normalized}`, "utf8")
        .digest("hex");
    return {
        source: "deployment_test_fixture",
        group: "테스트반",
        region: "서울",
        studentAccessCode: { version: 1, hash, updatedAt: now },
    };
}

export function buildDeploymentFixture({ studentSessionSecret, now = new Date().toISOString() }) {
    if (!studentSessionSecret?.trim()) throw new Error("studentSessionSecret is required");
    const teachers = [
        { id: "admin", name: "관리자", email: "admin@omr.test", memberRole: "admin", plan: "academy" },
        { id: "teacher1", name: "강사 1", email: "teacher1@omr.test", memberRole: "teacher", plan: "free" },
        { id: "teacher2", name: "강사 2", email: "teacher2@omr.test", memberRole: "teacher", plan: "pro" },
        { id: "teacher3", name: "강사 3", email: "teacher3@omr.test", memberRole: "teacher", plan: "academy" },
    ];
    const teacherAccounts = teachers.map(teacher => ({
        ...teacher,
        passwordHash: teacherPasswordHash(TEACHER_LOGIN_PASSWORDS[teacher.id]),
        organizationId: SHARED_ORGANIZATION_ID,
        organizationName: "OMR Maker 테스트",
    }));
    const actorRows = teachers.map(teacher => ({ ...teacher, userId: `teacher_${stableWorkspaceHash(teacher.id)}` }));
    const students = Object.entries(STUDENT_START_CODES).map(([id, code], index) => ({
        id,
        organization_id: SHARED_ORGANIZATION_ID,
        display_name: `학생 ${index + 1}`,
        external_id: id,
        email: `${id}@omr.test`,
        status: "active",
        metadata: studentMetadata(code, id, SHARED_ORGANIZATION_ID, studentSessionSecret, now),
        updated_at: now,
    }));
    return {
        teacherAccounts,
        organization: { id: SHARED_ORGANIZATION_ID, name: "OMR Maker 테스트", plan: "academy", metadata: { source: "deployment_test_fixture" }, updated_at: now },
        userProfiles: actorRows.map(row => ({ user_id: row.userId, email: row.email, display_name: row.name, status: "active", updated_at: now })),
        members: actorRows.map(row => ({ organization_id: SHARED_ORGANIZATION_ID, user_id: row.userId, email: row.email, display_name: row.name, role: row.memberRole, status: "active", updated_at: now })),
        teacherProfiles: actorRows.map(row => ({ organization_id: SHARED_ORGANIZATION_ID, user_id: row.userId, display_name: row.name, status: "active", metadata: { source: "deployment_test_fixture" }, updated_at: now })),
        classRow: { id: SHARED_CLASS_ID, organization_id: SHARED_ORGANIZATION_ID, name: "테스트반", campus: "서울", status: "active", metadata: { source: "deployment_test_fixture" }, updated_at: now },
        students,
        enrollments: students.map(row => ({ class_id: SHARED_CLASS_ID, organization_id: SHARED_ORGANIZATION_ID, student_profile_id: row.id, enrollment_status: "active" })),
        studentCredentials: students.map(row => ({ organization_id: SHARED_ORGANIZATION_ID, student_profile_id: row.id, start_code_hash: studentStartCodeHash(STUDENT_START_CODES[row.id]), updated_at: now })),
    };
}

export function verifyTeacherPasswordHash(password, encoded) {
    return verifyEncodedPbkdf2(password, encoded);
}

export function verifyStudentStartCodeHash(code, encoded) {
    return verifyEncodedPbkdf2(code.replace(/\s/g, "").toUpperCase(), encoded);
}
```

The fixture must include user profiles, organization members, teacher profiles, class, student profiles, class enrollments, and `omr_student_start_credentials` rows. Student profile metadata must also include the HMAC record used by `issueStudentSession`.

- [ ] **Step 4: Implement the apply/verify CLI**

Create `scripts/setup-deployment-test-accounts.mjs` with three modes:

- `--dry-run`: validate fixture counts and print only IDs/roles/plans, never secrets or hashes.
- `--apply`: use Vercel CLI to pull existing Production and Preview environment values into `mkdtemp` files, preserve existing Supabase keys, generate missing 32-byte session secrets, upsert `TEACHER_ACCOUNTS`, `TEACHER_SESSION_SECRET`, and `STUDENT_SESSION_SECRET`, then use the service-role client to upsert fixture rows in foreign-key order.
- `--verify`: pull environments and query Supabase read-only, returning nonzero unless all four teacher configs, one Academy organization, four members, one class, three students, three enrollments, and three credentials exist.

Use `spawnSync` argument arrays and stdin for `vercel env add`; do not interpolate secrets into shell command strings. Delete temporary pull files in `finally`.

- [ ] **Step 5: Add package scripts and run dry-run tests**

Add:

```json
"accounts:deploy:dry-run": "node scripts/setup-deployment-test-accounts.mjs --dry-run",
"accounts:deploy:apply": "node scripts/setup-deployment-test-accounts.mjs --apply",
"accounts:deploy:verify": "node scripts/setup-deployment-test-accounts.mjs --verify"
```

Run:

```bash
npm test -- --run scripts/deployment-test-accounts-core.test.mjs
npm run accounts:deploy:dry-run
```

Expected: tests PASS; dry-run reports 4 teachers, 3 students, organization `teacher_sharedqa`, and no secret values.

- [ ] **Step 6: Commit**

```bash
git add scripts/deployment-test-accounts-core.mjs scripts/deployment-test-accounts-core.test.mjs scripts/setup-deployment-test-accounts.mjs package.json
git commit -m "feat(deploy): add shared test account provisioning"
```

### Task 5: Document the deployed test accounts

**Files:**
- Modify: `README.md`
- Modify: `docs/deployment-test-accounts.md`

- [ ] **Step 1: Update account documentation**

Document the exact teacher logins, plans, student names/IDs/codes, `테스트반`, and the student entry URL:

```text
/?role=student&workspace=teacher_sharedqa
```

State that the credentials are simple by request, are test-only, and teacher passwords are stored in Vercel as PBKDF2 hashes. Explain that all four teacher accounts share data while the signed account plan is a ceiling over the Academy organization plan.

- [ ] **Step 2: Run documentation checks and commit**

Run:

```bash
rg -n "teacher_sharedqa|teacher1|student1|목업" README.md docs/deployment-test-accounts.md
git diff --check -- README.md docs/deployment-test-accounts.md
```

Expected: both files contain the shared workspace and account instructions; no whitespace errors.

Commit only the documentation files:

```bash
git add README.md docs/deployment-test-accounts.md
git commit -m "docs: describe shared deployment test accounts"
```

### Task 6: Run repository verification

**Files:**
- Verify only; do not modify unrelated dirty files.

- [ ] **Step 1: Run focused tests**

```bash
npm test -- --run src/lib/teacherAuth.test.ts src/lib/teacherSession.test.ts src/lib/teacherServerSession.test.ts src/lib/workspaceContext.test.ts src/lib/supabaseServerAdmin.test.ts src/lib/serverPlan.test.ts src/lib/demoData.test.ts src/lib/uiSurface.test.ts scripts/deployment-test-accounts-core.test.mjs
```

Expected: all focused tests PASS.

- [ ] **Step 2: Run static and full verification**

```bash
npm run lint
npm test
npm run build
```

Expected: all commands exit 0. If an existing unrelated failure remains, record the exact command and failure without editing the user's unrelated files.

- [ ] **Step 3: Inspect the final diff**

```bash
git status --short
git diff --check
git log -6 --oneline
```

Expected: only the user's pre-existing uncommitted files remain dirty; account implementation files are committed.

### Task 7: Apply Vercel/Supabase configuration and smoke-test deployment

**Files:**
- External state: linked Vercel project `omr-maker`
- External state: Supabase project configured in Vercel
- Temporary clean worktree for deployment

- [ ] **Step 1: Verify authenticated deployment tooling**

Run:

```bash
npx vercel@latest whoami
npx vercel@latest env ls
```

Expected: authenticated Vercel identity and environment variable names for the linked `omr-maker` project. Do not print values.

- [ ] **Step 2: Apply and verify account configuration**

Run:

```bash
npm run accounts:deploy:apply
npm run accounts:deploy:verify
```

Expected: Preview and Production each contain four hashed teacher accounts and required secrets; Supabase contains the shared Academy organization, four members, one class, three students, three enrollments, and three credentials.

- [ ] **Step 3: Deploy from a clean worktree**

Create a temporary worktree at the verified implementation commit, copy only `.vercel/project.json` into its `.vercel` directory, install locked dependencies, and deploy:

```bash
deployment_dir=$(mktemp -d)
git worktree add "$deployment_dir/repo" HEAD
mkdir -p "$deployment_dir/repo/.vercel"
cp .vercel/project.json "$deployment_dir/repo/.vercel/project.json"
npm ci --prefix "$deployment_dir/repo"
(cd "$deployment_dir/repo" && npx vercel@latest --prod --yes)
```

Expected: Vercel returns a successful Production deployment URL. Remove the temporary worktree with `git worktree remove "$deployment_dir/repo"` after verification; do not delete the main workspace.

- [ ] **Step 4: Smoke-test teacher and student login**

Use the public deployment URL and verify:

1. `admin/admin1234` reports Academy.
2. `teacher1/teacher1234` reports Free.
3. `teacher2/teacher1234` reports Pro.
4. `teacher3/teacher1234` reports Academy.
5. Every teacher sees `테스트반` and students 1–3, with no synthetic sample exams.
6. `student1/ABC234`, `student2/BCD345`, and `student3/CDE456` log in through `/?role=student&workspace=teacher_sharedqa`.
7. The public mockup entry still displays the existing synthetic analytics.

- [ ] **Step 5: Report final deployment state**

Report the deployed URL, completed account matrix, focused/full verification results, and any external operation that could not be completed. Never include session secrets, service-role keys, or password hashes in the report.
