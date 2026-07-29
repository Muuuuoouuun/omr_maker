# Exam Workflow Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove false-positive exam-away events and make submission persistence status honest and recoverable.

**Architecture:** Extract away tracking into a pure state machine with a 2-second threshold and a single active away session. Integrate it with the solve page, then expose neutral/attention severity consistently to student and teacher surfaces.

**Tech Stack:** TypeScript, React 19, Vitest, Playwright

---

### Task 1: Build the away-session state machine

**Files:**
- Create: `src/lib/examAwayTracker.ts`
- Create: `src/lib/examAwayTracker.test.ts`

- [ ] **Step 1: Write failing tests**

Cover:

```ts
it("drops an away session shorter than two seconds", () => {
  const away = beginAwaySession(null, 1_000);
  expect(finishAwaySession(away, 2_999)).toEqual({ count: 0, durationMs: 1_999 });
});

it("counts a two-second away session once", () => {
  const away = beginAwaySession(null, 1_000);
  expect(finishAwaySession(away, 3_000)).toEqual({ count: 1, durationMs: 2_000 });
});

it("deduplicates blur and hidden", () => {
  const first = beginAwaySession(null, 1_000);
  expect(beginAwaySession(first, 1_050)).toBe(first);
});

it("flushes an active qualifying session at submission", () => {
  expect(flushAwaySession({ startedAt: 1_000 }, 3_500).count).toBe(1);
});
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/examAwayTracker.test.ts
```

- [ ] **Step 3: Implement**

Use:

```ts
export const EXAM_AWAY_THRESHOLD_MS = 2_000;

export interface AwaySession {
  startedAt: number;
}

export function beginAwaySession(
  current: AwaySession | null,
  now: number,
): AwaySession {
  return current ?? { startedAt: now };
}

export function finishAwaySession(
  current: AwaySession | null,
  now: number,
): { count: 0 | 1; durationMs: number } {
  if (!current) return { count: 0, durationMs: 0 };
  const durationMs = Math.max(0, now - current.startedAt);
  return {
    count: durationMs >= EXAM_AWAY_THRESHOLD_MS ? 1 : 0,
    durationMs,
  };
}

export const flushAwaySession = finishAwaySession;

export function awaySeverity(count: number): "neutral" | "attention" {
  return count >= 3 ? "attention" : "neutral";
}
```

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run src/lib/examAwayTracker.test.ts
git add src/lib/examAwayTracker.ts src/lib/examAwayTracker.test.ts
git commit -m "feat: add two-second exam away tracker"
```

### Task 2: Integrate one away session into solve

**Files:**
- Modify: `src/app/solve/[id]/page.tsx`
- Modify: `src/lib/liveControls.test.ts`
- Modify: `e2e/full-journey.spec.ts`

- [ ] **Step 1: Add failing browser cases**

Use `page.evaluate` to dispatch blur/visibility changes and fake elapsed time through an injected clock seam. Assert:

```ts
expect(await readLeaveCount()).toBe(0); // 1.9s
expect(await readLeaveCount()).toBe(1); // 2.0s blur + hidden pair
```

- [ ] **Step 2: Verify RED**

```bash
npx playwright test e2e/full-journey.spec.ts --project=chromium --grep "away session"
```

- [ ] **Step 3: Replace immediate increments**

Keep an `awaySessionRef`. Both `blur` and `visibilitychange(hidden)` call `beginAwaySession`. Focus or visible calls `finishAwaySession`, clears the ref, and increments only when `count === 1`. Submission calls `flushAwaySession` before constructing attempt metadata.

- [ ] **Step 4: Use progressive student copy**

Use:

```ts
const message = nextCount === 1
  ? "시험 화면을 벗어난 기록이 제출 기록과 함께 선생님 화면에 표시됩니다."
  : `시험 화면 이탈이 ${nextCount}회 기록되었습니다. 답안을 확인한 뒤 계속 진행해 주세요.`;
```

Do not label the event as cheating.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/examAwayTracker.test.ts src/lib/liveControls.test.ts
npx playwright test e2e/full-journey.spec.ts --project=chromium --grep "away session"
git add src/app/solve/[id]/page.tsx src/lib/liveControls.test.ts e2e/full-journey.spec.ts
git commit -m "fix: debounce and deduplicate exam away events"
```

### Task 3: Apply neutral and attention severity

**Files:**
- Modify: `src/app/teacher/live/page.tsx`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`
- Modify: `src/app/student/review/[attemptId]/page.tsx`
- Modify: `src/app/globals.css`
- Modify: `e2e/teacher-pages.spec.ts`

- [ ] **Step 1: Write failing severity assertions**

Render fixtures with counts 1, 2, and 3. Assert 1–2 use `data-away-severity="neutral"` and 3 uses `"attention"`.

- [ ] **Step 2: Verify RED**

```bash
npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "away severity"
```

- [ ] **Step 3: Implement shared severity output**

Use `awaySeverity(count)` and render:

```tsx
<span data-away-severity={awaySeverity(count)}>
  화면 이탈 {count}회
</span>
```

Student review copy is factual: `시험 중 화면을 벗어난 기록`.

- [ ] **Step 4: Style**

Neutral uses slate text/background. Attention uses amber, not destructive red.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run src/lib/examAwayTracker.test.ts
npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "away severity"
git add src/app/teacher/live/page.tsx src/app/teacher/attempt/[attemptId]/page.tsx src/app/student/review/[attemptId]/page.tsx src/app/globals.css e2e/teacher-pages.spec.ts
git commit -m "fix: present away events without cheating claims"
```

### Task 4: Show authoritative submission persistence

**Files:**
- Modify: `src/lib/studentAttemptReceipt.ts`
- Modify: `src/lib/studentAttemptReceipt.test.ts`
- Modify: `src/app/student/review/[attemptId]/page.tsx`
- Modify: `src/components/SyncFlusher.tsx`
- Modify: `e2e/full-journey.spec.ts`

- [ ] **Step 1: Write failing receipt-state tests**

Define and test:

```ts
expect(submissionReceiptLabel({ status: "confirmed" })).toBe("서버 반영 완료");
expect(submissionReceiptLabel({ status: "pending" })).toBe("서버 반영 대기 · 자동 재시도");
expect(submissionReceiptLabel({ status: "local_only" })).toBe("이 기기에만 저장됨");
```

- [ ] **Step 2: Verify RED**

```bash
npx vitest run src/lib/studentAttemptReceipt.test.ts
```

- [ ] **Step 3: Implement the explicit state contract**

Use:

```ts
export type SubmissionReceiptStatus = "confirmed" | "pending" | "local_only";

export function submissionReceiptLabel(
  receipt: { status: SubmissionReceiptStatus },
): string {
  if (receipt.status === "confirmed") return "서버 반영 완료";
  if (receipt.status === "pending") return "서버 반영 대기 · 자동 재시도";
  return "이 기기에만 저장됨";
}
```

Persist the status with the attempt receipt. `SyncFlusher` changes `pending` to `confirmed` only after the purpose-specific server request succeeds.

- [ ] **Step 4: Render status and retry action**

Review displays the label as `role="status"`. Pending status includes a `지금 다시 시도` button that calls the same idempotent server request; local-only status explains that another device cannot see the result.

- [ ] **Step 5: Verify browser behavior**

```bash
npx vitest run src/lib/studentAttemptReceipt.test.ts
npx playwright test e2e/full-journey.spec.ts --project=chromium --grep "submission receipt"
```

Expected: confirmed, offline pending, and successful retry cases pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/studentAttemptReceipt.ts src/lib/studentAttemptReceipt.test.ts src/app/student/review/[attemptId]/page.tsx src/components/SyncFlusher.tsx e2e/full-journey.spec.ts
git commit -m "feat: show authoritative submission receipts"
```
