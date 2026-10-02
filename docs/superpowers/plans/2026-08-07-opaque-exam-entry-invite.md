# Opaque Exam Entry Invite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore safe organization and group login context from a new-device exam share URL using only a revocable opaque token.

**Architecture:** Store only SHA-256 token hashes in a FORCE-RLS Postgres table. Purpose-scoped service-role RPCs rotate and resolve the token, while server actions re-resolve it at directory, login, and exam preview boundaries and bind the resolved organization only into a signed HttpOnly student session.

**Tech Stack:** Next.js server actions, TypeScript, Node crypto, Supabase/PostgreSQL 17, Vitest.

---

### Task 1: Token and redirect contracts

**Files:**
- Create: `src/lib/examEntryInvite.ts`
- Test: `src/lib/examEntryInvite.test.ts`
- Modify: `src/lib/examLinks.ts`
- Test: `src/lib/examLinks.test.ts`

- [x] Write failing tests requiring a 43-character base64url token, SHA-256-only storage key, rejection of malformed tokens, fragment scrubbing, and non-secret query preservation without `workspace` or group ids.
- [ ] Run `npm test -- --run src/lib/examEntryInvite.test.ts src/lib/examLinks.test.ts` and confirm missing exports fail.
- [ ] Implement `createExamEntryInviteToken`, `hashExamEntryInviteToken`, `normalizeExamEntryInviteToken`, and invite-aware share/login URL helpers.
- [ ] Re-run the focused tests and confirm they pass.

### Task 2: PostgreSQL invite boundary

**Files:**
- Create: `supabase/migrations/202608060028_exam_entry_invites.sql`
- Create: `src/lib/examEntryInviteMigrationContract.test.ts`

- [ ] Write a failing migration contract requiring a hash-only FORCE-RLS table, one-active-token rotation, bounded TTL, teacher membership and exam ownership checks, service-role-only grants, and fail-closed resolver predicates.
- [ ] Run `npm test -- --run src/lib/examEntryInviteMigrationContract.test.ts` and confirm the missing migration fails.
- [ ] Add `omr_exam_entry_invites`, `omr_rotate_exam_entry_invite_v1`, and `omr_resolve_exam_entry_invite_v1`; never accept or return the raw token.
- [ ] Re-run the migration contract.

### Task 3: Server gateway and teacher issuance

**Files:**
- Create: `src/lib/examEntryInviteGateway.ts`
- Test: `src/lib/examEntryInviteGateway.test.ts`
- Modify: `src/app/actions/teacherExam.ts`

- [ ] Write failing tests for sanitized resolution, ownership-scoped rotation, token non-disclosure in errors, and bounded response sizes.
- [ ] Run the focused tests and confirm failures reference missing gateway/action behavior.
- [ ] Implement the gateway and `rotateTeacherExamEntryInvite(examId)` using the signed teacher context and canonical exam-derived group scope.
- [ ] Re-run focused tests.

### Task 4: New-device directory and login

**Files:**
- Modify: `src/app/actions/studentSession.ts`
- Modify: `src/app/page.tsx`
- Test: `src/lib/studentServerAuthSurface.test.ts`
- Test: `src/lib/studentSessionDurableRateLimit.test.ts`
- Create: `src/lib/studentExamInviteFlow.test.ts`

- [ ] Write failing tests requiring production directory/login to use `{ examId, inviteToken }`, re-resolve independently, filter invited groups, reject raw workspace authority, and sign the resolved organization/group without returning organization id.
- [ ] Run the focused tests and confirm the old workspace-based path fails.
- [x] Implement invite resolution in both actions and update login state/UX to retain the opaque invite in a bounded tab handoff while preserving the non-secret `next` query.
- [ ] Re-run focused tests.

### Task 5: Exam preview and share issuance

**Files:**
- Modify: `src/app/actions/studentExam.ts`
- Modify: `src/lib/studentExamClient.ts`
- Modify: `src/app/solve/[id]/page.tsx`
- Modify: `src/app/create/page.tsx`
- Modify: `src/components/teacher/users/InvitesTab.tsx`
- Modify: `src/app/teacher/users/page.tsx`
- Test: `src/lib/studentExamContract.test.ts`
- Test: `src/lib/createSaveHierarchySurface.test.ts`
- Test: `src/lib/uiSurface.test.ts`

- [ ] Write failing tests that a bare new-device share passes invite to safe preview, login href preserves it, canonical publish rotates a token before returning a link, and generic UI no longer emits raw workspace ids.
- [ ] Run focused tests and confirm failures.
- [ ] Thread the invite only through safe preview/login requests, rotate after canonical save, build the opaque URL, and remove the raw workspace invite copy.
- [ ] Re-run focused tests.

### Task 6: Production boundary and readiness

**Files:**
- Modify: `supabase/production-server-boundary.sql`
- Modify: `supabase/production-server-boundary-rollback.sql`
- Modify: `supabase/live-test-assertions.sql`
- Modify: `supabase/live-test-boundary-assertions.sql`
- Modify: `supabase/live-test-rollback-assertions.sql`
- Modify: `src/lib/supabaseReadinessProbe.ts`
- Modify: `src/lib/deploymentReadiness.ts`
- Test: `src/lib/productionServerBoundaryContract.test.ts`
- Test: `src/lib/supabaseReadinessProbe.test.ts`

- [ ] Write failing contracts requiring readiness version `202608060028`, `examEntryInvitesReady`, browser privilege denial, function ownership/grants, and rollback/live attack assertions.
- [ ] Run the focused tests and confirm failures.
- [ ] Extend the production/rollback profiles and PG17 assertions, then update the TypeScript readiness key/version and labels.
- [ ] Re-run focused tests.

### Task 7: Verification

- [ ] Run all touched Vitest files.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run build`.
- [ ] Run `git diff --check` and inspect that no raw token/hash logging or raw workspace query generation remains in production paths.
- [ ] Report any live PG17 assertion not executed because external database credentials are unavailable; do not claim it passed without execution.
