# Custom Question Count Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let teachers set any integer question count from 1 through 50 and reliably auto-match PDF question locations above question 20.

**Architecture:** Put the supported range and strict input parser in a small shared module used by creation and settings normalization. Keep a staged string in the create page so multi-digit entry commits on Enter or blur, then reuse the existing resize confirmation and question synchronization flow. The existing text-coordinate detector needs no production rewrite; regression coverage will lock in recognition for questions 21 through 50.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Playwright, pdfjs-dist

---

### Task 1: Shared question-count policy

**Files:**
- Create: `src/lib/questionCount.ts`
- Create: `src/lib/questionCount.test.ts`
- Modify: `src/lib/appSettings.ts`
- Modify: `src/lib/appSettings.test.ts`

- [ ] **Step 1: Write the failing parser and settings tests**

```ts
import { describe, expect, it } from "vitest";
import { MAX_QUESTION_COUNT, MIN_QUESTION_COUNT, parseQuestionCountInput } from "./questionCount";

describe("question count", () => {
  it("accepts whole-number counts throughout the supported range", () => {
    expect(parseQuestionCountInput("1")).toBe(MIN_QUESTION_COUNT);
    expect(parseQuestionCountInput("45")).toBe(45);
    expect(parseQuestionCountInput("50")).toBe(MAX_QUESTION_COUNT);
  });

  it.each(["", "0", "51", "4.5", "abc"])("rejects %s", value => {
    expect(parseQuestionCountInput(value)).toBeNull();
  });
});
```

Add `expect(normalizeExamDefaults({ questions: 200 }).questions).toBe(50)` to `src/lib/appSettings.test.ts`.

- [ ] **Step 2: Run tests and verify the new policy is missing**

Run: `npm test -- src/lib/questionCount.test.ts src/lib/appSettings.test.ts`

Expected: FAIL because `src/lib/questionCount.ts` does not exist and settings still allow 200.

- [ ] **Step 3: Implement the shared range and strict parser**

```ts
export const MIN_QUESTION_COUNT = 1;
export const MAX_QUESTION_COUNT = 50;

export function parseQuestionCountInput(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return Number.isInteger(count) && count >= MIN_QUESTION_COUNT && count <= MAX_QUESTION_COUNT
    ? count
    : null;
}
```

Import `MAX_QUESTION_COUNT` in `src/lib/appSettings.ts` and replace the question default normalization maximum of `200` with `MAX_QUESTION_COUNT`.

- [ ] **Step 4: Run focused policy tests**

Run: `npm test -- src/lib/questionCount.test.ts src/lib/appSettings.test.ts`

Expected: both files PASS.

### Task 2: Recognition coverage above question 20

**Files:**
- Modify: `src/lib/pdfQuestionDetection.test.ts`

- [ ] **Step 1: Add a regression test for questions 21, 45, and 50**

```ts
it("detects configured question numbers above 20 through the 50-question limit", () => {
  const items: PdfTextLocatorItem[] = [21, 45, 50].flatMap((questionNumber, index) => [
    { str: `${questionNumber}.`, x: 0.08, y: 0.18 + index * 0.2 },
    { str: "다음 글을 읽고 물음에 답하시오.", x: 0.14, y: 0.18 + index * 0.2 },
  ]);

  const detected = detectQuestionLocationsFromText(items, [21, 45, 50]);

  expect([...detected.keys()]).toEqual([21, 45, 50]);
});
```

- [ ] **Step 2: Run the detector test**

Run: `npm test -- src/lib/pdfQuestionDetection.test.ts`

Expected: PASS, proving the detector is not capped at 20 and documenting the supported range.

### Task 3: Direct question-count input

**Files:**
- Modify: `e2e/teacher-pages.spec.ts`
- Modify: `src/app/create/page.tsx`
- Modify: `src/app/teacher/settings/page.tsx`

- [ ] **Step 1: Write the failing creation-page browser test**

Add a test to the authenticated create-page describe block:

```ts
test("accepts a custom 45-question exam size", async ({ page }) => {
  await page.goto("/create");
  const input = page.getByLabel("문항 수 직접 입력");
  await input.fill("45");
  await input.press("Enter");
  await expect(input).toHaveValue("45");
  await expect(page.getByText("새 시험 · 45문항 · 5지선다")).toBeVisible();
});
```

- [ ] **Step 2: Run the browser test and verify the control is missing**

Run: `npx playwright test e2e/teacher-pages.spec.ts --grep "custom 45-question" --project=desktop-chrome`

Expected: FAIL because the labeled input does not exist.

- [ ] **Step 3: Add staged input and commit behavior**

In `src/app/create/page.tsx`, import the shared constants/parser, initialize `questionCountInput` to `"20"`, synchronize it when committed `questionsCount` changes, and add:

```ts
const commitQuestionCountInput = () => {
  const nextCount = parseQuestionCountInput(questionCountInput);
  if (nextCount === null) {
    setQuestionCountInput(String(questionsCount));
    toast.info("문항 수 확인", `${MIN_QUESTION_COUNT}~${MAX_QUESTION_COUNT} 사이의 정수를 입력해주세요.`);
    return;
  }
  handleQuestionCountChange(nextCount);
};
```

Render a numeric input next to the presets with `min={MIN_QUESTION_COUNT}`, `max={MAX_QUESTION_COUNT}`, `inputMode="numeric"`, and `aria-label="문항 수 직접 입력"`. Update its draft on change, commit on blur, and on Enter prevent default, commit, and blur. When a shrink confirmation is cancelled or dismissed, restore the draft string from `questionsCount`.

- [ ] **Step 4: Bound the settings default control**

Add `min={MIN_QUESTION_COUNT}`, `max={MAX_QUESTION_COUNT}`, and `step={1}` to the default question-count input in `src/app/teacher/settings/page.tsx`, importing the shared constants directly.

- [ ] **Step 5: Run the focused browser test**

Run: `npx playwright test e2e/teacher-pages.spec.ts --grep "custom 45-question" --project=desktop-chrome`

Expected: PASS with the committed input value and 45-question editor summary visible.

### Task 4: Verification against supplied PDFs and repository checks

**Files:**
- Verify only; no production files added.

- [ ] **Step 1: Run focused unit tests**

Run: `npm test -- src/lib/questionCount.test.ts src/lib/appSettings.test.ts src/lib/pdfQuestionDetection.test.ts src/app/create/page.test.ts`

Expected: all focused tests PASS.

- [ ] **Step 2: Re-run both supplied PDFs through the current detector with expected questions 1 through 45**

Use Node 24 with `--experimental-strip-types`, `pdfjs-dist/legacy/build/pdf.mjs`, and `detectQuestionLocationsFromText`. Aggregate the best placement per question across all pages.

Expected: both PDFs report `missing: []` for questions 1 through 45.

- [ ] **Step 3: Run the complete unit suite**

Run: `npm test`

Expected: all tests PASS with zero failures.

- [ ] **Step 4: Run lint**

Run: `npm run lint`

Expected: exit code 0 with no lint errors.

- [ ] **Step 5: Run production build**

Run: `npm run build`

Expected: exit code 0 and Next.js production build completes.

- [ ] **Step 6: Inspect the final diff**

Run: `git diff -- src/lib/questionCount.ts src/lib/questionCount.test.ts src/lib/appSettings.ts src/lib/appSettings.test.ts src/lib/pdfQuestionDetection.test.ts src/app/create/page.tsx src/app/teacher/settings/page.tsx e2e/teacher-pages.spec.ts`

Expected: only the custom 1-50 count policy, direct input, settings bound, and regression tests appear.
