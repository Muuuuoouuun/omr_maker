# Alpha Usability Recognition DB Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring OMR Maker's alpha loop closer to production shape by hardening answer recognition, plan entitlements, billing copy, and database schema boundaries.

**Architecture:** Keep the current Next.js client-heavy alpha architecture. Add pure tested helpers for answer normalization, shared plan catalog definitions, local usage counters, and Supabase schema tables that can evolve into real organization-backed auth later.

**Tech Stack:** Next.js 16, React 19, TypeScript, Vitest, Supabase/PostgreSQL SQL, lucide-react.

---

## File Structure

- Modify: `src/services/answerParser.ts` to export pure normalization helpers and use them for text and Gemini results.
- Create: `src/services/answerParser.test.ts` to test parsing, duplicate resolution, circled/Korean answers, and Gemini result normalization.
- Modify: `src/utils/plans.ts` to provide the shared Free/Pro/Academy catalog, legacy `school` migration, entitlement helpers, and AI usage counter helpers.
- Create: `src/utils/plans.test.ts` to test plan normalization, labels, entitlements, and usage counters.
- Modify: `src/types/omr.ts` to rename `PlanKey` to `free | pro | academy` while allowing legacy migration through helper code.
- Modify: `src/app/teacher/billing/page.tsx` to consume the shared plan catalog and rename AI scoring copy to AI answer-key recognition.
- Modify: `src/components/AnswerImportModal.tsx` to use lucide icons, improve accessible modal semantics, count AI recognition usage only after successful AI extraction, and improve result validation.
- Modify: `src/app/create/page.tsx`, `src/components/NotificationBell.tsx`, and `src/app/teacher/attempt/[attemptId]/page.tsx` to use Academy labels and icon buttons where touched.
- Modify: `supabase/schema.sql` and `supabase/README.md` to add alpha organization/class/member/audit foundations and document current RLS limitations.
- Modify: `README.md` to describe the alpha database and recognition setup.

## Task 1: Answer Recognition Normalization

**Files:**
- Create: `src/services/answerParser.test.ts`
- Modify: `src/services/answerParser.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { describe, expect, it } from "vitest";
import {
  extractAnswersFromText,
  normalizeAnswerValue,
  normalizeGeminiAnswerRows,
} from "./answerParser";

describe("answer parser normalization", () => {
  it("normalizes numeric, alphabetic, circled, and Korean answer values", () => {
    expect(normalizeAnswerValue("A")).toBe(1);
    expect(normalizeAnswerValue("⑤")).toBe(5);
    expect(normalizeAnswerValue("정답: 3번")).toBe(3);
    expect(normalizeAnswerValue("나")).toBe(2);
  });

  it("extracts answers from common table and inline answer key text", () => {
    const parsed = extractAnswersFromText("1. A 2) ④ 3 - C 4 정답 2번 5: E");
    expect(parsed.map(item => [item.questionNum, item.answer])).toEqual([
      [1, 1],
      [2, 4],
      [3, 3],
      [4, 2],
      [5, 5],
    ]);
  });

  it("deduplicates repeated question rows by highest confidence", () => {
    const parsed = extractAnswersFromText("1. A 1 정답 ⑤ 2. B");
    expect(parsed.find(item => item.questionNum === 1)?.answer).toBe(1);
    expect(parsed).toHaveLength(2);
  });

  it("normalizes Gemini rows with alternate keys and string answers", () => {
    const rows = normalizeGeminiAnswerRows([
      { id: "1", answer: "B", score: "2.5" },
      { number: 2, correctAnswer: "④" },
      { questionNum: "bad", answer: "A" },
    ]);
    expect(rows).toEqual([
      expect.objectContaining({ questionNum: 1, answer: 2, score: 2.5 }),
      expect.objectContaining({ questionNum: 2, answer: 4 }),
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/services/answerParser.test.ts`
Expected: FAIL because the test file and exported helpers do not exist yet.

- [ ] **Step 3: Implement minimal parser helpers**

Export `normalizeAnswerValue`, `extractAnswersFromText`, and `normalizeGeminiAnswerRows`. Use them from `parseAnswerKeyPdf` and `parseAnswerKeyWithGemini`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/services/answerParser.test.ts`
Expected: PASS.

## Task 2: Shared Plan Catalog And Usage Counters

**Files:**
- Create: `src/utils/plans.test.ts`
- Modify: `src/types/omr.ts`
- Modify: `src/utils/plans.ts`

- [ ] **Step 1: Write failing tests**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLAN_CATALOG,
  canArchiveHandwriting,
  getPlanLabel,
  incrementAiRecognitionUsage,
  normalizePlan,
  readAiRecognitionUsage,
} from "./plans";

function storage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: key => data.get(key) ?? null,
    key: index => [...data.keys()][index] ?? null,
    removeItem: key => data.delete(key),
    setItem: (key, value) => { data.set(key, value); },
  } as Storage;
}

afterEach(() => vi.unstubAllGlobals());

describe("plan catalog", () => {
  it("uses Free, Pro, Academy as canonical public plans", () => {
    expect(PLAN_CATALOG.map(plan => plan.key)).toEqual(["free", "pro", "academy"]);
    expect(getPlanLabel("academy")).toBe("Academy");
    expect(normalizePlan("school")).toBe("academy");
  });

  it("archives handwriting for paid plans", () => {
    expect(canArchiveHandwriting("free")).toBe(false);
    expect(canArchiveHandwriting("pro")).toBe(true);
    expect(canArchiveHandwriting("academy")).toBe(true);
  });

  it("increments AI answer-key recognition usage safely", () => {
    const localStorage = storage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(readAiRecognitionUsage()).toBe(0);
    expect(incrementAiRecognitionUsage()).toBe(1);
    expect(incrementAiRecognitionUsage(4)).toBe(5);
    expect(localStorage.getItem("omr_ai_usage")).toBe("5");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/utils/plans.test.ts`
Expected: FAIL because the catalog and usage helpers are missing and `academy` is not yet canonical.

- [ ] **Step 3: Implement shared plan catalog**

Define Free, Pro, and Academy in `src/utils/plans.ts`, migrate legacy `school` reads to `academy`, expose `PLAN_CATALOG`, `PLAN_BY_KEY`, `normalizePlan`, `getCurrentPlan`, `setCurrentPlan`, `canArchiveHandwriting`, `getPlanLabel`, `readAiRecognitionUsage`, and `incrementAiRecognitionUsage`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/utils/plans.test.ts`
Expected: PASS.

## Task 3: Billing And Modal UX Integration

**Files:**
- Modify: `src/app/teacher/billing/page.tsx`
- Modify: `src/components/AnswerImportModal.tsx`
- Modify: `src/components/NotificationBell.tsx`
- Modify: `src/app/create/page.tsx`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`

- [ ] **Step 1: Update billing to use shared catalog**

Replace local `PLANS` and `Plan` definitions with `PLAN_CATALOG`, `PlanKey`, `normalizePlan`, and `setCurrentPlan`. Rename visible usage copy from `AI 채점 크레딧` to `AI 정답 인식`.

- [ ] **Step 2: Update answer import modal**

Use lucide icons instead of emoji text, add `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, dark-mode-safe colors via CSS variables, and call `incrementAiRecognitionUsage()` only after a successful AI result.

- [ ] **Step 3: Update remaining plan labels**

Replace legacy `school` checks with `academy` through `normalizePlan` and `canArchiveHandwriting`. Remove touched emoji labels in create/import surfaces.

- [ ] **Step 4: Verify targeted integration**

Run: `npm test -- src/utils/plans.test.ts src/services/answerParser.test.ts src/lib/persistenceIntegration.test.ts`
Expected: PASS.

## Task 4: Supabase Alpha Schema Foundations

**Files:**
- Modify: `supabase/schema.sql`
- Modify: `supabase/README.md`
- Modify: `README.md`

- [ ] **Step 1: Extend schema**

Add development-safe tables for `omr_organizations`, `omr_organization_members`, `omr_classes`, and `omr_audit_logs`. Add nullable `organization_id` and `class_id` to `omr_exams` and `omr_attempts`, plus indexes.

- [ ] **Step 2: Document RLS and alpha setup**

Document that current policies are open only for alpha/local testing and list the exact tightening steps required before real student data.

- [ ] **Step 3: Verify SQL/doc presence by tests**

Extend `src/lib/persistenceIntegration.test.ts` with file-level assertions for `organization_id`, `omr_organizations`, and the open-policy warning.

Run: `npm test -- src/lib/persistenceIntegration.test.ts`
Expected: PASS.

## Task 5: Full Verification

**Files:**
- All touched files

- [ ] **Step 1: Run unit tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `npm run lint`
Expected: PASS with no new errors.

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: PASS.

- [ ] **Step 4: Browser QA**

Start: `npm run dev`
Open: `http://localhost:3003/teacher/billing` and `http://localhost:3003/create`.
Expected: Billing shows Free/Pro/Academy and AI answer-key recognition usage; create page answer import modal is usable without text overlap.
