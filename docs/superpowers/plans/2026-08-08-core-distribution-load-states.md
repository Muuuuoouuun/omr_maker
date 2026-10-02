# Core Distribution and Load States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make exam distribution recoverable and honest after refresh, label assignment availability correctly, and prevent backend failures from appearing as empty data.

**Architecture:** Extend the existing hash-only invite model with metadata-only teacher reads; never make raw invite tokens recoverable on the server. Derive assignment lifecycle from canonical state and server times. Use one generic discriminated load-state union across teacher dashboard, roster, distribution, and student dashboard.

**Tech Stack:** PostgreSQL RPCs, Next.js Server Actions, React 19, TypeScript, Vitest, Playwright.

---

### Task 1: Define invite capability and metadata contracts

**Files:**
- Create: `src/lib/examEntryInviteLifecycle.ts`
- Create: `src/lib/examEntryInviteLifecycle.test.ts`

- [ ] **Step 1: Write failing lifecycle tests**

```ts
expect(resolveInviteCapability({ metadata: active, rawUrl: validCurrentUrl, now })).toBe("copyable_here");
expect(resolveInviteCapability({ metadata: active, rawUrl: null, now })).toBe("active_but_raw_unavailable");
expect(resolveInviteCapability({ metadata: expired, rawUrl: validCurrentUrl, now })).toBe("expired");
expect(resolveInviteCapability({ metadata: revoked, rawUrl: validCurrentUrl, now })).toBe("revoked");
expect(resolveInviteCapability({ metadata: generationTwo, rawUrl: generationOneUrl, now })).toBe("active_but_raw_unavailable");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/examEntryInviteLifecycle.test.ts
```

- [ ] **Step 3: Implement the pure lifecycle model**

```ts
export type ExamEntryInviteCapability =
  | "copyable_here"
  | "active_but_raw_unavailable"
  | "expired"
  | "revoked";

export interface ExamEntryInviteMetadata {
  inviteId: string;
  examId: string;
  targetType: "groups" | "individuals" | "public";
  targetIds: string[];
  generation: number;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}
```

Raw URL state includes only URL, exam ID, generation, and local issue time. Capability requires exact
exam and generation matches. Never parse or expose the token hash.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/examEntryInviteLifecycle.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/examEntryInviteLifecycle.ts src/lib/examEntryInviteLifecycle.test.ts
git commit -m "feat(invites): define safe invite capabilities"
```

### Task 2: Add metadata-only teacher invite RPCs

**Files:**
- Create: `supabase/migrations/202608080011_exam_entry_invite_lifecycle.sql`
- Create: `src/lib/examEntryInviteLifecycleMigrationContract.test.ts`
- Modify: `src/lib/examEntryInviteGateway.ts`
- Modify: `src/lib/examEntryInviteGateway.test.ts`
- Modify: `supabase/live-test-assertions.sql`

- [ ] **Step 1: Write failing SQL and gateway tests**

Require:

```ts
expect(sql).toContain("omr_get_exam_entry_invite_metadata_v1");
expect(sql).toContain("omr_revoke_exam_entry_invite_v1");
expect(metadataResult).toEqual({ status: "found", metadata: expect.objectContaining({ generation: 2 }) });
expect(JSON.stringify(metadataResult)).not.toMatch(/token|hash/i);
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/examEntryInviteLifecycleMigrationContract.test.ts src/lib/examEntryInviteGateway.test.ts
```

- [ ] **Step 3: Implement metadata and revocation boundaries**

Add `generation integer not null default 1` and explicit target metadata without changing the hash-only
token boundary. Rotation revokes the prior active invite and increments generation transactionally.
Metadata lookup returns exam, target, issue, expiry, revoke, and generation only. Revoke is idempotent.

Restrict rotate/get/revoke to the signed organization and roles `owner`, `admin`, or `teacher`. Keep
`anon` and `authenticated` execute denied.

- [ ] **Step 4: Run GREEN and live tenant denial**

```sh
npx vitest run src/lib/examEntryInviteLifecycleMigrationContract.test.ts src/lib/examEntryInviteGateway.test.ts src/lib/examEntryInviteMigrationContract.test.ts
npm run test:supabase:live
```

- [ ] **Step 5: Commit**

```sh
git add supabase/migrations/202608080011_exam_entry_invite_lifecycle.sql src/lib/examEntryInviteLifecycleMigrationContract.test.ts src/lib/examEntryInviteGateway.ts src/lib/examEntryInviteGateway.test.ts supabase/live-test-assertions.sql
git commit -m "feat(invites): expose metadata without invite secret"
```

### Task 3: Show current distribution state after refresh

**Files:**
- Modify: `src/app/actions/teacherExam.ts`
- Modify: `src/components/DistributeModal.tsx`
- Modify: `src/app/create/page.tsx`
- Create: `src/lib/distributionInviteLifecycleSurface.test.ts`
- Create: `e2e/exam-invite-lifecycle.spec.ts`

- [ ] **Step 1: Write failing surface tests**

```ts
expect(surface).toContain("활성 링크가 있습니다");
expect(surface).toContain("이 기기에는 링크 원문이 없습니다");
expect(surface).toContain("새 링크 발급");
expect(surface).toContain("기존 링크와 QR은 즉시 무효화됩니다");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/distributionInviteLifecycleSurface.test.ts src/lib/distributionInviteRotationSurface.test.ts
```

- [ ] **Step 3: Add the metadata Server Action**

Expose `getExamEntryInviteMetadata(examId)` and `revokeExamEntryInvite(examId)` after same-origin,
signed-session, role, and ownership checks. Return `not_found`, `forbidden`, or
`dependency_unavailable`; never collapse gateway errors to no invite.

- [ ] **Step 4: Add honest modal state**

On modal open, load metadata. If current client memory has a raw link with exact exam and generation,
show copy and QR. If metadata is active without raw capability, show metadata and only the reissue CTA.
Expired/revoked state disables copy and QR. Reissue confirmation names the invalidation consequence.

- [ ] **Step 5: Add browser proof**

The E2E journey issues an invite, closes and reopens the modal, refreshes, checks
`active_but_raw_unavailable`, reissues, proves the old URL is denied and the new URL resolves, and
proves exam A metadata never appears on exam B.

- [ ] **Step 6: Run GREEN**

```sh
npx vitest run src/lib/distributionInviteLifecycleSurface.test.ts src/lib/distributionInviteRotationSurface.test.ts
npx playwright test --project=chromium --workers=1 --retries=0 e2e/exam-invite-lifecycle.spec.ts
```

- [ ] **Step 7: Commit**

```sh
git add src/app/actions/teacherExam.ts src/components/DistributeModal.tsx src/app/create/page.tsx src/lib/distributionInviteLifecycleSurface.test.ts e2e/exam-invite-lifecycle.spec.ts
git commit -m "feat(invites): show current distribution status"
```

### Task 4: Centralize assignment lifecycle

**Files:**
- Create: `src/lib/assignmentLifecycle.ts`
- Create: `src/lib/assignmentLifecycle.test.ts`
- Modify: `src/lib/studentExamContract.ts`
- Modify: `src/lib/individualAssignmentGateway.ts`
- Modify: `src/lib/individualAssignmentGateway.test.ts`

- [ ] **Step 1: Write boundary-time tests**

```ts
expect(resolveAssignmentLifecycle({ state: "open", startsAt: future, endsAt: later, now })).toBe("scheduled");
expect(resolveAssignmentLifecycle({ state: "open", startsAt: now, endsAt: later, now })).toBe("open");
expect(resolveAssignmentLifecycle({ state: "open", startsAt: past, endsAt: now, now })).toBe("closed");
expect(resolveAssignmentLifecycle({ state: "archived", startsAt: past, endsAt: later, now })).toBe("closed");
expect(resolveAssignmentLifecycle({ state: "open", startsAt: later, endsAt: past, now })).toBe("invalid");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/assignmentLifecycle.test.ts src/lib/individualAssignmentGateway.test.ts
```

- [ ] **Step 3: Implement one fail-closed resolver**

```ts
export type AssignmentLifecycle = "scheduled" | "open" | "closed" | "invalid";
```

Use ISO timestamps and a supplied server time; `endsAt` is exclusive. Add lifecycle, startsAt, and
endsAt to `StudentAssignmentPreview`. Gateway mapping rejects malformed timestamp/state rows as
`dependency_unavailable` rather than presenting them as open.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/assignmentLifecycle.test.ts src/lib/individualAssignmentGateway.test.ts src/lib/individualAssignmentMigrationContract.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/assignmentLifecycle.ts src/lib/assignmentLifecycle.test.ts src/lib/studentExamContract.ts src/lib/individualAssignmentGateway.ts src/lib/individualAssignmentGateway.test.ts
git commit -m "feat(assignments): centralize lifecycle calculation"
```

### Task 5: Render scheduled, open, and closed assignments

**Files:**
- Modify: `src/app/student/dashboard/page.tsx`
- Modify: `src/components/dashboard/AssignmentBlock.tsx`
- Create: `src/lib/assignmentLifecycleSurface.test.ts`
- Create: `e2e/student-assignment-lifecycle.spec.ts`

- [ ] **Step 1: Write failing surface tests**

```ts
expect(surface).toContain("예정");
expect(surface).toContain("응시 가능");
expect(surface).toContain("마감");
expect(surface).toContain('aria-disabled');
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/assignmentLifecycleSurface.test.ts
```

- [ ] **Step 3: Render lifecycle independently from progress**

Scheduled cards show the localised opening time and no active solve link. Open cards show `시작` or
`계속 풀기`. Closed cards retain result/review links for completed work but do not create a new attempt.
Completion state remains a separate badge and never changes a closed assignment back to open.

- [ ] **Step 4: Add server-boundary browser cases**

Use fixtures one second before and at each boundary, plus archived and malformed data. The browser test
asserts UI state while the existing solve Server Action remains the final authorization check.

- [ ] **Step 5: Run GREEN**

```sh
npx vitest run src/lib/assignmentLifecycleSurface.test.ts src/lib/studentDashboardLoadState.test.ts
npx playwright test --project=chromium --workers=1 --retries=0 e2e/student-assignment-lifecycle.spec.ts
```

- [ ] **Step 6: Commit**

```sh
git add src/app/student/dashboard/page.tsx src/components/dashboard/AssignmentBlock.tsx src/lib/assignmentLifecycleSurface.test.ts e2e/student-assignment-lifecycle.spec.ts
git commit -m "feat(assignments): show canonical availability state"
```

### Task 6: Define the canonical load-state union

**Files:**
- Create: `src/lib/canonicalLoadState.ts`
- Create: `src/lib/canonicalLoadState.test.ts`

- [ ] **Step 1: Write failing transition tests**

```ts
expect(resolveCanonicalLoad({ remote: { ok: true, data: [] }, cache: null })).toEqual({ state: "loaded_empty", data: [] });
expect(resolveCanonicalLoad({ remote: { ok: false }, cache: cached })).toMatchObject({ state: "degraded_with_cache", data: cached });
expect(resolveCanonicalLoad({ remote: { ok: false }, cache: null })).toEqual({ state: "error_without_cache", error: "dependency_unavailable" });
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/canonicalLoadState.test.ts
```

- [ ] **Step 3: Implement the generic discriminated union**

```ts
export type CanonicalLoadState<T> =
  | { state: "loading" }
  | { state: "loaded_empty"; data: T }
  | { state: "loaded_data"; data: T }
  | { state: "degraded_with_cache"; data: T; staleAt: string; error: "dependency_unavailable" }
  | { state: "error_without_cache"; error: "dependency_unavailable" };
```

Require an explicit `isEmpty` predicate so object responses are not guessed from truthiness.

- [ ] **Step 4: Run GREEN**

```sh
npx vitest run src/lib/canonicalLoadState.test.ts
```

- [ ] **Step 5: Commit**

```sh
git add src/lib/canonicalLoadState.ts src/lib/canonicalLoadState.test.ts
git commit -m "feat(ui): define canonical load states"
```

### Task 7: Apply truthful state to dashboard, roster, and distribution

**Files:**
- Modify: `src/app/teacher/dashboard/page.tsx`
- Modify: `src/app/teacher/users/page.tsx`
- Modify: `src/components/DistributeModal.tsx`
- Modify: `src/app/student/dashboard/page.tsx`
- Create: `src/lib/canonicalLoadStateSurface.test.ts`
- Modify: `e2e/student-dashboard-load-state.spec.ts`
- Create: `e2e/teacher-canonical-load-state.spec.ts`

- [ ] **Step 1: Write failing source and rendered-state tests**

```ts
expect(remoteFailureWithoutCache).toHaveTestId("canonical-error-no-cache");
expect(remoteFailureWithoutCache).not.toContain("첫 시험 만들기");
expect(remoteFailureWithCache).toContain("저장된 데이터를 표시 중");
expect(remoteFailureWithCache).toContain("마지막 저장");
expect(successfulEmpty).toContain("첫 학생 추가");
```

- [ ] **Step 2: Run RED**

```sh
npx vitest run src/lib/canonicalLoadStateSurface.test.ts src/lib/studentDashboardLoadState.test.ts
```

- [ ] **Step 3: Remove empty-array fallbacks from failed canonical reads**

Teacher dashboard, roster, and distribution loaders must retain remote failure as an error. They may
use a real cache only when data and `staleAt` exist. `error_without_cache` disables roster mutations,
distribution, and onboarding CTAs. `degraded_with_cache` shows persistent stale labeling and retry.

- [ ] **Step 4: Keep student login recovery copy aligned**

The unauthenticated student dashboard link is `로그인 안내` to `/`. The E2E test must assert that
current product contract rather than the stale `학생 로그인` link.

- [ ] **Step 5: Run GREEN browser tests**

```sh
npx vitest run src/lib/canonicalLoadStateSurface.test.ts src/lib/studentDashboardLoadState.test.ts
npx playwright test --project=chromium --workers=1 --retries=0 e2e/student-dashboard-load-state.spec.ts e2e/teacher-canonical-load-state.spec.ts
```

- [ ] **Step 6: Commit**

```sh
git add src/app/teacher/dashboard/page.tsx src/app/teacher/users/page.tsx src/components/DistributeModal.tsx src/app/student/dashboard/page.tsx src/lib/canonicalLoadStateSurface.test.ts e2e/student-dashboard-load-state.spec.ts e2e/teacher-canonical-load-state.spec.ts
git commit -m "fix(ui): distinguish empty cached and failed loads"
```
