# Teacher Account Lifecycle Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-safe teacher signup and password-reset core that stores only password/token hashes, requires an explicit delivery adapter, and fails closed when external delivery is unavailable.

**Architecture:** A pure lifecycle policy validates normalized email, display name, and password and creates PBKDF2 password hashes plus SHA-256 one-time-token hashes. Server actions use a service-role-only gateway backed by new account/token tables. A delivery adapter is intentionally unconfigured in this release, so signup and reset-request actions perform no database mutation and return a clear unavailable status; token completion remains testable through injected gateways without persisting token plaintext.

**Tech Stack:** TypeScript, Next.js server actions, Supabase/PostgreSQL, Vitest.

---

### Task 1: Credential and token policy

**Files:**
- Create: `src/lib/teacherAccountLifecycle.ts`
- Test: `src/lib/teacherAccountLifecycle.test.ts`

- [ ] Write tests proving normalization, password policy, PBKDF2 hashing, token hashing, TTL, and generic public request results.
- [ ] Run `npx vitest run src/lib/teacherAccountLifecycle.test.ts` and observe RED because the module is absent.
- [ ] Implement bounded inputs, `hashTeacherPassword`, `verifyTeacherCredentialPassword`, and one-time token material that exposes plaintext only to the delivery call while returning only its digest for persistence.
- [ ] Re-run the focused test and require all assertions to pass.

### Task 2: Fail-closed delivery seam

**Files:**
- Create: `src/lib/teacherAccountDelivery.ts`
- Test: `src/lib/teacherAccountDelivery.test.ts`

- [ ] Write tests proving the default adapter reports unavailable and never logs or records email/token/password values.
- [ ] Run the focused test and observe RED.
- [ ] Implement an explicit `TeacherAccountDeliveryAdapter` interface and an unavailable default resolver. Do not add SMTP, email API, console, or file delivery.
- [ ] Re-run the focused test and require GREEN.

### Task 3: Service-role persistence and atomic token consumption

**Files:**
- Create: `supabase/migrations/202608060022_teacher_account_lifecycle.sql`
- Create: `src/lib/teacherAccountLifecycleMigrationContract.test.ts`
- Create: `src/lib/teacherAccountGateway.ts`
- Test: `src/lib/teacherAccountGateway.test.ts`

- [ ] Write contract tests requiring private account/token tables, unique normalized email, password/token hash columns, status/expiry/consumed constraints, no plaintext columns, revoked browser grants, and atomic reset-token consumption RPC.
- [ ] Observe RED against the missing migration/gateway.
- [ ] Add the migration and a bounded service-role gateway. Persist no plaintext password or token and return generic duplicate/not-found results.
- [ ] Re-run gateway and migration tests and require GREEN.

### Task 4: Public server-action boundary

**Files:**
- Create: `src/app/actions/teacherAccount.ts`
- Create: `src/lib/teacherAccountAction.test.ts`

- [ ] Write tests requiring same-origin checks, durable request throttling, delivery readiness before DB mutation, generic anti-enumeration reset responses, and password/token input bounds.
- [ ] Observe RED.
- [ ] Implement signup request, reset request, and reset completion actions using the delivery and gateway seams. Default deployment must return `delivery_unavailable` before resolving a service-role client.
- [ ] Re-run the action tests and require GREEN.

### Task 5: Login bridge and truthful UX surface

**Files:**
- Modify: `src/app/actions/auth.ts`
- Modify: `src/app/page.tsx`
- Create: `src/lib/teacherAccountSurface.test.ts`

- [ ] Write tests requiring active DB-account login before bootstrap env fallback, explicit bootstrap/demo labeling, signup/reset forms, and unavailable-delivery copy.
- [ ] Observe RED.
- [ ] Add the DB login bridge and small account lifecycle modes to the existing teacher login card. Keep environment credentials as explicitly labeled bootstrap/demo credentials only.
- [ ] Run focused tests, TypeScript, ESLint, and the production build.

### Verification

- [ ] Run all teacher auth/account lifecycle tests.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run ESLint on every changed TypeScript/TSX file.
- [ ] Run `git diff --check`.
- [ ] Do not stage or commit; report external delivery and production migration as remaining dependencies.
