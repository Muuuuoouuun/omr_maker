# Student Results Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing teacher attempt detail route into a discoverable student-results hub with answer, handwriting, report, and analytics tabs plus original/retake switching.

**Architecture:** Keep `/teacher/attempt/[attemptId]` as the canonical route and add pure helpers for view parsing, student identity matching, and attempt-series ordering. Split the current 1,200-line detail surface into focused result panels under `src/components/teacher/student-results`, keep existing persistence and analytics functions, and deep-link every related teacher entry point to the appropriate tab.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, CSS Modules, Lucide React, Vitest, Playwright.

---

## Execution safety

The repository had unrelated staged and unstaged work when this plan was written. Before every task:

```bash
git status --short
git diff --check
git diff --cached --stat
```

Do not discard, unstage, reformat, or commit unrelated work. Re-read any overlapping file immediately before patching it. If unrelated edits remain staged, use `git commit --only -- <feature paths>` only after verifying `git diff -- <feature paths>` and `git diff --cached -- <feature paths>`; do not create a broad commit.

## File map

**Create**

- `src/lib/studentResultHub.ts` — canonical tab, identity, URL, attempt-series, and score-delta helpers.
- `src/lib/studentResultHub.test.ts` — pure helper coverage, including legacy identity collision cases.
- `src/components/teacher/student-results/StudentResultHeader.tsx` — breadcrumb, student/test summary, and attempt switcher.
- `src/components/teacher/student-results/StudentResultTabs.tsx` — accessible tab navigation synchronized to `view`.
- `src/components/teacher/student-results/LockedFeaturePanel.tsx` — shared locked-feature explanation and upgrade link.
- `src/components/teacher/student-results/AnswersPanel.tsx` — answer evidence, sub-question review, and student questions.
- `src/components/teacher/student-results/HandwritingPanel.tsx` — archive state, PDF handwriting, markup, and feedback controls.
- `src/components/teacher/student-results/ReportPanel.tsx` — printable current-exam summary and gated growth summary.
- `src/components/teacher/student-results/AnalyticsPanel.tsx` — current-exam diagnosis and supplementary cumulative insight.
- `src/components/teacher/student-results/StudentResultHub.module.css` — desktop/mobile layout, tabs, states, and print rules.

**Modify**

- `src/app/teacher/attempt/[attemptId]/page.tsx` — orchestration, data loading, URL state, lazy resources, and panel composition.
- `src/app/teacher/exam/[id]/page.tsx` — one clear `학생 결과 보기` action plus handwriting/retake indicators.
- `src/app/teacher/users/page.tsx` — handwriting and report deep links.
- `src/components/dashboard/tabs/StudentAnalyticsTab.tsx` — analytics deep links from detailed attempt rows.
- `src/lib/uiSurface.test.ts` — static discoverability/deep-link contract.
- `e2e/teacher-pages.spec.ts` — desktop result-hub workflow.
- `e2e/teacher-mobile.spec.ts` — 2×2 mobile tabs, attempt selector, and overflow regression.

## Task 1: Add the pure student-result model

**Files:**

- Create: `src/lib/studentResultHub.ts`
- Create: `src/lib/studentResultHub.test.ts`

- [ ] **Step 1: Write failing tests for view parsing, identity, and series ordering**

```ts
import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import {
    buildStudentAttemptSeries,
    buildStudentResultHref,
    parseStudentResultView,
    sameStudentAttempt,
} from "./studentResultHub";

function makeAttempt(partial: Partial<Attempt>): Attempt {
    return {
        id: partial.id || "base",
        examId: partial.examId || "exam-1",
        examTitle: partial.examTitle || "중간고사",
        studentName: partial.studentName || "김학생",
        studentProfileId: partial.studentProfileId,
        studentId: partial.studentId,
        groupId: partial.groupId,
        groupName: partial.groupName,
        guestId: partial.guestId,
        startedAt: partial.startedAt || "2026-07-22T00:00:00.000Z",
        finishedAt: partial.finishedAt || "2026-07-22T00:30:00.000Z",
        score: partial.score ?? 70,
        totalScore: partial.totalScore ?? 100,
        answers: partial.answers || {},
        retake: partial.retake,
        status: "completed",
    };
}

describe("student result hub", () => {
    it("normalizes missing and invalid views to answers", () => {
        expect(parseStudentResultView(null)).toBe("answers");
        expect(parseStudentResultView("handwriting")).toBe("handwriting");
        expect(parseStudentResultView("unknown")).toBe("answers");
    });

    it("builds encoded deep links", () => {
        expect(buildStudentResultHref("attempt/a", "analytics"))
            .toBe("/teacher/attempt/attempt%2Fa?view=analytics");
    });

    it("matches stable ids before a guarded group-and-name fallback", () => {
        const anchor = makeAttempt({ studentProfileId: "profile-1", studentId: "legacy-1" });
        expect(sameStudentAttempt(anchor, makeAttempt({ studentId: "profile-1" }))).toBe(true);
        expect(sameStudentAttempt(
            makeAttempt({ studentId: undefined, groupId: "class-a", studentName: "동명이인" }),
            makeAttempt({ id: "legacy", studentId: undefined, groupId: "class-a", studentName: "동명이인" }),
        )).toBe(true);
        expect(sameStudentAttempt(
            makeAttempt({ studentId: undefined, groupId: "class-a", studentName: "동명이인" }),
            makeAttempt({ id: "other", studentId: undefined, groupId: "class-b", studentName: "동명이인" }),
        )).toBe(false);
        expect(sameStudentAttempt(
            makeAttempt({ studentId: undefined, groupId: undefined, studentName: "동명이인" }),
            makeAttempt({ id: "unsafe", studentId: undefined, groupId: undefined, studentName: "동명이인" }),
        )).toBe(false);
    });

    it("orders the source before retakes and reports source score delta", () => {
        const base = makeAttempt({ id: "base", studentId: "student-1", score: 60 });
        const retake = makeAttempt({
            id: "retake",
            studentId: "student-1",
            score: 80,
            finishedAt: "2026-07-22T01:00:00.000Z",
            retake: {
                sourceAttemptId: "base",
                questionIds: [2, 4],
                mode: "wrong",
                createdAt: "2026-07-22T00:40:00.000Z",
            },
        });
        const otherExam = makeAttempt({ id: "other", examId: "exam-2", studentId: "student-1" });

        expect(buildStudentAttemptSeries(retake, [retake, otherExam, base])).toEqual([
            expect.objectContaining({ attempt: base, kind: "original", scoreDelta: null }),
            expect.objectContaining({ attempt: retake, kind: "retake", scoreDelta: 20 }),
        ]);
    });
});
```

- [ ] **Step 2: Run the focused test and verify it fails because the module is absent**

Run: `npm test -- src/lib/studentResultHub.test.ts`

Expected: FAIL with a module-resolution error for `./studentResultHub`.

- [ ] **Step 3: Implement the pure model**

```ts
import type { Attempt } from "@/types/omr";
import { safeScorePercent } from "@/lib/scoreUtils";

export const STUDENT_RESULT_VIEWS = ["answers", "handwriting", "report", "analytics"] as const;
export type StudentResultView = (typeof STUDENT_RESULT_VIEWS)[number];

export interface StudentAttemptSeriesItem {
    attempt: Attempt;
    kind: "original" | "retake";
    ordinal: number;
    scorePercent: number;
    scoreDelta: number | null;
}

export function parseStudentResultView(value: string | null | undefined): StudentResultView {
    return STUDENT_RESULT_VIEWS.includes(value as StudentResultView)
        ? value as StudentResultView
        : "answers";
}

export function buildStudentResultHref(attemptId: string, view: StudentResultView): string {
    return `/teacher/attempt/${encodeURIComponent(attemptId)}?view=${view}`;
}

function ids(attempt: Attempt): Set<string> {
    return new Set([attempt.studentProfileId, attempt.studentId].map(value => value?.trim()).filter(Boolean) as string[]);
}

function groupKeys(attempt: Attempt): Set<string> {
    return new Set([attempt.groupId, attempt.groupName].map(value => value?.trim()).filter(Boolean) as string[]);
}

export function sameStudentAttempt(left: Attempt, right: Attempt): boolean {
    const leftIds = ids(left);
    const rightIds = ids(right);
    if (leftIds.size > 0 && rightIds.size > 0) {
        return [...leftIds].some(id => rightIds.has(id));
    }
    if (left.guestId && right.guestId) return left.guestId === right.guestId;
    if (left.studentName.trim() !== right.studentName.trim()) return false;
    const leftGroups = groupKeys(left);
    const rightGroups = groupKeys(right);
    return leftGroups.size > 0 && rightGroups.size > 0
        && [...leftGroups].some(group => rightGroups.has(group));
}

export function buildStudentAttemptSeries(anchor: Attempt, attempts: Attempt[]): StudentAttemptSeriesItem[] {
    const matching = attempts
        .filter(attempt => attempt.examId === anchor.examId && sameStudentAttempt(anchor, attempt))
        .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
    const byId = new Map(matching.map(attempt => [attempt.id, attempt]));
    return matching
        .sort((a, b) => Number(!!a.retake) - Number(!!b.retake)
            || Date.parse(a.finishedAt) - Date.parse(b.finishedAt))
        .map((attempt, index) => {
            const source = attempt.retake ? byId.get(attempt.retake.sourceAttemptId) : undefined;
            const scorePercent = safeScorePercent(attempt.score, attempt.totalScore);
            return {
                attempt,
                kind: attempt.retake ? "retake" : "original",
                ordinal: index + 1,
                scorePercent,
                scoreDelta: source
                    ? Math.round((scorePercent - safeScorePercent(source.score, source.totalScore)) * 10) / 10
                    : null,
            };
        });
}
```

- [ ] **Step 4: Run the helper tests**

Run: `npm test -- src/lib/studentResultHub.test.ts`

Expected: 4 tests PASS.

- [ ] **Step 5: Commit only the helper files if the index is safe**

```bash
git add -- src/lib/studentResultHub.ts src/lib/studentResultHub.test.ts
git diff --cached -- src/lib/studentResultHub.ts src/lib/studentResultHub.test.ts
git commit --only -- src/lib/studentResultHub.ts src/lib/studentResultHub.test.ts -m "feat: add student result hub model"
```

## Task 2: Build accessible navigation primitives

**Files:**

- Create: `src/components/teacher/student-results/StudentResultTabs.tsx`
- Create: `src/components/teacher/student-results/StudentResultHeader.tsx`
- Create: `src/components/teacher/student-results/LockedFeaturePanel.tsx`
- Create: `src/components/teacher/student-results/StudentResultHub.module.css`

- [ ] **Step 1: Add the tab component with URL-preserving links and arrow-key focus**

The exported API must be:

```tsx
type StudentResultTabsProps = {
    attemptId: string;
    activeView: StudentResultView;
};

export default function StudentResultTabs({ attemptId, activeView }: StudentResultTabsProps) {
    const refs = useRef<Array<HTMLAnchorElement | null>>([]);
    return (
        <nav className={styles.tabs} role="tablist" aria-label="학생 결과 보기">
            {TAB_ITEMS.map((item, index) => (
                <Link
                    key={item.view}
                    ref={node => { refs.current[index] = node; }}
                    id={`student-result-tab-${item.view}`}
                    role="tab"
                    aria-selected={activeView === item.view}
                    aria-controls={`student-result-panel-${item.view}`}
                    tabIndex={activeView === item.view ? 0 : -1}
                    href={buildStudentResultHref(attemptId, item.view)}
                    className={activeView === item.view ? styles.tabActive : styles.tab}
                    onKeyDown={event => focusAdjacentTab(event, refs.current, index)}
                >
                    <item.Icon size={17} aria-hidden="true" />
                    {item.label}
                </Link>
            ))}
        </nav>
    );
}
```

Use the exact labels `답안`, `필기`, `리포트`, `분석`, and icons `ListChecks`, `PenLine`, `FileText`, `BarChart3`. `focusAdjacentTab` handles `ArrowLeft`, `ArrowRight`, `Home`, and `End` without changing the selected URL until the focused link is activated.

```tsx
function focusAdjacentTab(
    event: React.KeyboardEvent<HTMLAnchorElement>,
    tabs: Array<HTMLAnchorElement | null>,
    index: number,
) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    tabs[next]?.focus();
}
```

- [ ] **Step 2: Add the result header and responsive attempt selector**

The component accepts `attempt`, optional `examTitle`, `series`, and `activeView`. Render:

```tsx
<header className={styles.resultHeader}>
    <div className={styles.breadcrumbs}>
        <Link href={`/teacher/exam/${encodeURIComponent(attempt.examId)}`}>시험 상세</Link>
        <ChevronRight size={14} aria-hidden="true" />
        <span>{attempt.studentName}</span>
    </div>
    <div className={styles.resultHeaderMain}>
        <div>
            <p className={styles.examTitle}>{examTitle || attempt.examTitle}</p>
            <h1>{attempt.studentName}</h1>
            <p>{formatKoreanDateTime(attempt.finishedAt)} 제출</p>
        </div>
        <div className={styles.scoreSummary} aria-label={`점수 ${scorePercent}점`}>
            <strong>{scorePercent}</strong><span>점</span>
        </div>
        <AttemptSwitcher series={series} activeAttemptId={attempt.id} activeView={activeView} />
    </div>
</header>
```

`AttemptSwitcher` renders linked buttons on desktop and a labeled `<select aria-label="응시 회차 선택">` on compact layouts. Each option/link says `원시험`, `재시험 1`, `재시험 2`; include `+20점` or `-5점` when `scoreDelta` is not null.

- [ ] **Step 3: Add the shared locked-feature panel**

```tsx
export default function LockedFeaturePanel({
    title,
    description,
    previewItems,
}: {
    title: string;
    description: string;
    previewItems: string[];
}) {
    return (
        <div className={styles.lockedPanel} role="note" aria-label={`${title} 제한`}>
            <Lock size={22} aria-hidden="true" />
            <h2>{title}</h2>
            <p>{description}</p>
            <ul>{previewItems.map(item => <li key={item}>{item}</li>)}</ul>
            <Link href="/teacher/billing" className="btn btn-primary">플랜 보기</Link>
        </div>
    );
}
```

- [ ] **Step 4: Add CSS Module rules for a four-column desktop tab bar and 2×2 mobile tabs**

Include these non-negotiable selectors and behaviors:

```css
.tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.tab, .tabActive { min-height: 48px; display: inline-flex; align-items: center; justify-content: center; }
.tabActive { color: white; background: var(--primary); }
.panel { min-width: 0; }
.attemptSelect { display: none; min-height: 44px; }
@media (max-width: 760px) {
  .tabs { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .attemptLinks { display: none; }
  .attemptSelect { display: block; width: 100%; }
  .resultHeaderMain { grid-template-columns: 1fr; }
}
@media print {
  .screenOnly, .tabs { display: none !important; }
}
```

Use theme variables only; do not add light-only hard-coded panel backgrounds.

- [ ] **Step 5: Run lint on the new primitives**

Run: `npx eslint src/components/teacher/student-results/StudentResultTabs.tsx src/components/teacher/student-results/StudentResultHeader.tsx src/components/teacher/student-results/LockedFeaturePanel.tsx`

Expected: exit 0.

- [ ] **Step 6: Commit only the new primitive files if safe**

```bash
git add -- src/components/teacher/student-results
git diff --cached -- src/components/teacher/student-results
git commit --only -- src/components/teacher/student-results -m "feat: add student result navigation"
```

## Task 3: Wire the canonical route and attempt-series data

**Files:**

- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`
- Modify: `src/lib/uiSurface.test.ts`

- [ ] **Step 1: Add a failing surface contract**

Add to the existing teacher surface describe block:

```ts
it("exposes the four-view student results hub on the canonical attempt route", () => {
    const page = readProjectFile("src/app/teacher/attempt/[attemptId]/page.tsx");
    expect(page).toContain("parseStudentResultView");
    expect(page).toContain("buildStudentAttemptSeries");
    expect(page).toContain("StudentResultHeader");
    expect(page).toContain("StudentResultTabs");
    expect(page).toContain("loadTeacherAttempts(found.examId)");
});
```

- [ ] **Step 2: Run the surface contract and verify failure**

Run: `npm test -- src/lib/uiSurface.test.ts`

Expected: FAIL because the attempt page does not yet import the hub shell.

- [ ] **Step 3: Parse `view`, load peer attempts, and compose the shell**

In the page:

```tsx
const searchParams = useSearchParams();
const activeView = parseStudentResultView(searchParams.get("view"));
const [peerAttempts, setPeerAttempts] = useState<Attempt[]>([]);

// Inside the existing successful attempt load, in parallel with exam/feedback work:
const peerResult = await loadTeacherAttempts(found.examId);
if (!cancelled) setPeerAttempts(peerResult.items);

const attemptSeries = useMemo(
    () => attempt ? buildStudentAttemptSeries(attempt, peerAttempts.length ? peerAttempts : [attempt]) : [],
    [attempt, peerAttempts],
);
```

Replace the old header title block with:

```tsx
<StudentResultHeader
    attempt={attempt}
    examTitle={exam?.title}
    series={attemptSeries}
    activeView={activeView}
/>
<StudentResultTabs attemptId={attempt.id} activeView={activeView} />
```

Wrap the active content with correct tabpanel semantics:

```tsx
<section
    id={`student-result-panel-${activeView}`}
    role="tabpanel"
    aria-labelledby={`student-result-tab-${activeView}`}
    className={styles.panel}
>
    {/* active panel in Tasks 4–6 */}
</section>
```

Import the CSS Module into the page for the panel wrapper. During this shell-only task, keep the legacy detail body rendered inside the tabpanel so no existing result function disappears before the focused panels are extracted. Do not release or hand off the intermediate shell state.

Keep access-denied, loading, not-found, organization-boundary, feedback-save, and sub-question-save behavior unchanged.

- [ ] **Step 4: Run the focused tests and lint**

Run: `npm test -- src/lib/studentResultHub.test.ts src/lib/uiSurface.test.ts && npx eslint 'src/app/teacher/attempt/[attemptId]/page.tsx'`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the route shell only if no unrelated attempt-page change would be included**

Inspect: `git diff -- 'src/app/teacher/attempt/[attemptId]/page.tsx' src/lib/uiSurface.test.ts`

If either file contains unrelated work, leave this task uncommitted and continue without staging. Otherwise commit only those paths.

## Task 4: Split answer and current-exam analytics panels

**Files:**

- Create: `src/components/teacher/student-results/AnswersPanel.tsx`
- Create: `src/components/teacher/student-results/AnalyticsPanel.tsx`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`

- [ ] **Step 1: Define shared calculated props in the page**

Keep `getAttemptQuestionResults`, `summarizeAttemptScore`, `buildStudentWeaknessGroups`, `buildLearningRecommendations`, timing maps, and retake-link creation in the page memo for now. Pass serializable calculated data and callbacks to panels; do not duplicate grading logic.

The answer panel interface must include:

```ts
export interface AnswersPanelProps {
    attempt: Attempt;
    exam: Exam | null;
    questionResults: QuestionResult[];
    counts: { correctCount: number; incorrectCount: number; unansweredCount: number; ungradedCount: number };
    subQuestionFilter: "needs_review" | "all";
    onSubQuestionFilterChange(value: "needs_review" | "all"): void;
    onSetSubQuestionReviewed(questionId: number, subQuestionId: string, reviewed: boolean): Promise<void>;
    savingSubQuestionKey: string | null;
    answerDrafts: Record<number, string>;
    onAnswerDraftChange(questionId: number, value: string): void;
    onAnswerQuestion(questionId: number): Promise<void>;
    savingAnswerFor: number | null;
}
```

The analytics panel interface must include the current attempt, optional exam, wrong results, weakness groups, recommendations, retake IDs/href, and behavior/timing data.

- [ ] **Step 2: Move answer evidence without changing mutation behavior**

`AnswersPanel` owns these existing visible blocks in this order:

1. score/count summary;
2. all-question filter and rows;
3. sub-question response review;
4. student questions and teacher replies.

The page remains responsible for asynchronous mutations and updates its `attempt` state after success. The panel only invokes callbacks.

- [ ] **Step 3: Move diagnostic content into `AnalyticsPanel`**

`AnalyticsPanel` owns:

1. missing-exam warning;
2. wrong/type analysis;
3. weakness/recommendation groups;
4. slow/revisited/answer-change/focus-loss signals;
5. recommended retake action.

When `exam` is null, render a scoped empty state while preserving stored score and submission metadata.

- [ ] **Step 4: Render only the selected panel**

```tsx
{activeView === "answers" && <AnswersPanel {...answerPanelProps} />}
{activeView === "analytics" && <AnalyticsPanel {...analyticsPanelProps} />}
{(activeView === "handwriting" || activeView === "report") && legacyDetailBody}
```

`legacyDetailBody` is the unchanged current handwriting/report surface kept only as an intermediate compatibility branch. Task 5 removes it for `handwriting`; Task 6 removes the last branch for `report`. Do not hand off until all four real panels are present.

- [ ] **Step 5: Run unit tests, lint, and type checking through build**

Run: `npm test -- src/lib/studentResultHub.test.ts src/lib/studentQuestions.test.ts src/lib/studentProfileAnalytics.test.ts`

Run: `npx eslint 'src/app/teacher/attempt/[attemptId]/page.tsx' src/components/teacher/student-results/AnswersPanel.tsx src/components/teacher/student-results/AnalyticsPanel.tsx`

Expected: all tests PASS; ESLint exits 0.

- [ ] **Step 6: Commit new panels separately when safe**

Commit the new panel files first. Include the page only if its diff contains no unrelated changes.

## Task 5: Add the handwriting panel with lazy resources and distinct locked/empty/error states

**Files:**

- Create: `src/components/teacher/student-results/HandwritingPanel.tsx`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`

- [ ] **Step 1: Separate base loading from handwriting loading**

Remove PDF and archived drawing restoration from the initial attempt load. Add an idempotent loader:

```tsx
const [handwritingStatus, setHandwritingStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");

const loadHandwritingResources = useCallback(async () => {
    if (!attempt || handwritingStatus === "loading" || handwritingStatus === "ready") return;
    setHandwritingStatus("loading");
    try {
        const loadedExam = exam || await loadTeacherExam(attempt.examId);
        if (loadedExam && !exam) setExam(loadedExam);
        const file = loadedExam ? await loadTeacherPdfFile(loadedExam) : null;
        const restored = await loadAttemptDrawings(attempt);
        setPdfFile(file);
        setDrawings(restored);
        setHandwritingStatus(file && (hasDrawings(restored) || feedbackViewMode === "markup") ? "ready" : "error");
    } catch {
        setHandwritingStatus("error");
    }
}, [attempt, exam, feedbackViewMode, handwritingStatus]);

useEffect(() => {
    if (activeView === "handwriting" && handwritingArchiveEnabled && attempt?.handwritingArchived) {
        void loadHandwritingResources();
    }
}, [activeView, attempt, handwritingArchiveEnabled, loadHandwritingResources]);
```

Extract `loadTeacherPdfFile(exam)` and `loadAttemptDrawings(attempt)` as private async helpers in the page using the existing remote signed-URL and IndexedDB logic. Reset handwriting state when `attemptId` changes.

```tsx
async function loadTeacherPdfFile(exam: Exam): Promise<File | null> {
    const pdfData = exam.pdfDataRef?.store === "remote"
        ? await getTeacherRemoteAssetUrl(exam.pdfDataRef)
            .then(result => result.status === "signed" ? result.signedUrl : undefined)
        : exam.pdfData;
    return storedDataUrlToFile("problem.pdf", pdfData, exam.pdfDataRef);
}

async function loadAttemptDrawings(attempt: Attempt): Promise<PdfDrawings | undefined> {
    if (hasDrawings(attempt.drawings)) return attempt.drawings;
    const ref = attempt.handwriting?.strokesRef || attempt.drawingsRef;
    if (!ref) return undefined;
    if (ref.store !== "remote") return (await loadJsonRecord<PdfDrawings>(ref)) || undefined;
    const signed = await getTeacherRemoteAssetUrl(ref);
    if (signed.status !== "signed") return undefined;
    const response = await fetch(signed.signedUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("handwriting_download_failed");
    return response.json() as Promise<PdfDrawings>;
}
```

- [ ] **Step 2: Move handwriting metadata, viewer, and feedback controls**

`HandwritingPanel` receives current plan flags, `handwritingStatus`, PDF/drawing props, view-mode setters, markup callback, feedback fields, save callback, and retry callback. Preserve the existing `PDFViewer` options exactly.

- [ ] **Step 3: Implement the three different non-ready states**

```tsx
if (!handwritingArchiveEnabled) {
    return <LockedFeaturePanel
        title="학생 필기 보관"
        description="Pro 이상에서는 이후 제출부터 PDF 필기를 자동으로 보관합니다."
        previewItems={["문항별 필기 위치", "교사 첨삭", "합쳐 보기와 파일 저장"]}
    />;
}
if (!attempt.handwritingArchived) {
    return <EmptyState title="저장된 필기가 없습니다" description="이 제출에는 보관된 필기 원본이 없습니다." />;
}
if (handwritingStatus === "error") {
    return <ErrorState title="필기 원본을 불러오지 못했습니다" onRetry={onRetry} />;
}
```

Define both local state components in `HandwritingPanel.tsx` so the names above are concrete:

```tsx
function EmptyState({ title, description }: { title: string; description: string }) {
    return <div className={styles.state} role="status"><h2>{title}</h2><p>{description}</p></div>;
}

function ErrorState({ title, onRetry }: { title: string; onRetry(): void }) {
    return (
        <div className={styles.state} role="alert">
            <h2>{title}</h2>
            <p>네트워크 상태를 확인한 뒤 다시 시도해 주세요.</p>
            <button type="button" className="btn btn-secondary" onClick={onRetry}>다시 시도</button>
        </div>
    );
}
```

Loading uses `role="status"`; errors use `role="alert"`. A failed handwriting load must not alter answer/report/analytics state.

- [ ] **Step 4: Verify focused regressions**

Run: `npm test -- src/lib/studentResultHub.test.ts src/lib/premiumFeatureReadiness.test.ts src/lib/studentQuestions.test.ts`

Run: `npx eslint 'src/app/teacher/attempt/[attemptId]/page.tsx' src/components/teacher/student-results/HandwritingPanel.tsx`

Expected: PASS and exit 0.

- [ ] **Step 5: Commit the handwriting panel when safe**

Commit the new file. Include the route page only after confirming it does not bundle unrelated edits.

## Task 6: Add the printable report and supplementary cumulative insight

**Files:**

- Create: `src/components/teacher/student-results/ReportPanel.tsx`
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx`

- [ ] **Step 1: Lazily load cumulative sources for report/analytics**

Add state for all attempts, exams, roster student, load status, and error. On first `report` or `analytics` view, run:

```tsx
const [attemptResult, examResult, rosterResult] = await Promise.all([
    loadTeacherAttempts(),
    loadTeacherExams(),
    loadTeacherRosterSnapshot(window.localStorage),
]);
const matchedStudent = rosterResult.students.find(student => attemptMatchesStudentProfile(attempt, student));
setCumulativeAttempts(attemptResult.items);
setCumulativeExams(examResult.items);
setRosterStudent(matchedStudent || null);
```

If `matchedStudent` is absent, keep the current-exam report available and display `누적 이력을 학생 명단과 안정적으로 연결할 수 없습니다.` in only the cumulative section. Do not synthesize or merge by bare name.

- [ ] **Step 2: Build the existing student profile insight only when the roster match is stable**

```tsx
const cumulativeInsight = useMemo(() => {
    if (!rosterStudent) return null;
    return buildStudentProfileInsight(
        rosterStudent,
        cumulativeAttempts,
        new Map(cumulativeExams.map(item => [item.id, item])),
        { recentLimit: 8, weaknessLimit: 6 },
    );
}, [cumulativeAttempts, cumulativeExams, rosterStudent]);
```

- [ ] **Step 3: Implement the current-exam report**

Render in this fixed order:

1. student, exam, submission and selected attempt summary;
2. score and answer counts;
3. top wrong questions and weakness groups;
4. original-to-retake score delta when selected attempt is a retake;
5. teacher feedback summary;
6. cumulative growth block.

The base report is always visible. When `studentGrowthReports` is unavailable, replace only item 6 with `LockedFeaturePanel`. When `pdfExport` is unavailable, keep the report readable but replace the print button with the existing Pro link.

- [ ] **Step 4: Scope print output to the report panel**

Add `.reportPrintRoot` and hide `.screenOnly` navigation in the CSS Module. Preserve `window.print()` and ensure answer, handwriting, and analytics panels do not appear in printed output.

- [ ] **Step 5: Extend analytics with the same supplementary insight**

Pass `cumulativeInsight`, loading state, and cumulative error to `AnalyticsPanel`. Add a bottom `누적 성장` section showing latest score, trend delta, repeated weaknesses, and recent base attempts. Keep current-exam diagnosis first.

- [ ] **Step 6: Run analytics/report regressions**

Run: `npm test -- src/lib/studentProfileAnalytics.test.ts src/lib/studentResultHub.test.ts src/lib/premiumAnalytics.test.ts`

Run: `npx eslint 'src/app/teacher/attempt/[attemptId]/page.tsx' src/components/teacher/student-results/ReportPanel.tsx src/components/teacher/student-results/AnalyticsPanel.tsx`

Expected: PASS and exit 0.

- [ ] **Step 7: Commit the report/cumulative changes when safe**

Commit new files first; include overlapping existing files only after a clean feature-only diff review.

## Task 7: Make every related entry point discoverable

**Files:**

- Modify: `src/app/teacher/exam/[id]/page.tsx`
- Modify: `src/app/teacher/users/page.tsx`
- Modify: `src/components/dashboard/tabs/StudentAnalyticsTab.tsx`
- Modify: `src/lib/uiSurface.test.ts`

- [ ] **Step 1: Add failing static link contracts**

```ts
it("deep-links result entry points to the intended hub views", () => {
    const examPage = readProjectFile("src/app/teacher/exam/[id]/page.tsx");
    const usersPage = readProjectFile("src/app/teacher/users/page.tsx");
    const analytics = readProjectFile("src/components/dashboard/tabs/StudentAnalyticsTab.tsx");
    expect(examPage).toContain("학생 결과 보기");
    expect(usersPage).toContain("view=handwriting");
    expect(usersPage).toContain("view=report");
    expect(analytics).toContain("view=analytics");
});
```

- [ ] **Step 2: Run and verify the contract fails**

Run: `npm test -- src/lib/uiSurface.test.ts`

Expected: FAIL on the new labels/query strings.

- [ ] **Step 3: Unify the exam-detail row action**

Replace the conditional `필기 보기`/`OMR 보기` label with `학생 결과 보기`. Keep the href at the canonical attempt route. Add adjacent non-button metadata:

```tsx
{attempt.handwritingArchived && (
    <span style={{ color: "#7c3aed", fontSize: "0.75rem", fontWeight: 800 }}>필기 저장됨</span>
)}
{attempt.retake && (
    <span style={{ color: "#0f766e", fontSize: "0.75rem", fontWeight: 800 }}>
        재시험 {attempt.retake.questionIds.length}문항
    </span>
)}
```

Do not add four competing row buttons.

- [ ] **Step 4: Update user-management links**

- Recent-attempt handwriting `열람` → `buildStudentResultHref(a.id, "handwriting")`.
- Growth-report modal attempt `리포트 열기` → `buildStudentResultHref(attempt.id, "report")`.
- The selected student card's `상세 보기` should open the most recent stable attempt's report when one exists; keep the existing empty/profile behavior when no attempt exists.

- [ ] **Step 5: Add analytics links to detailed student rows**

In `StudentAnalyticsTab`, make the attempt title or a new `결과 분석` link point to `buildStudentResultHref(detail.attemptId, "analytics")`. Preserve the existing retake action as a separate action.

- [ ] **Step 6: Run link contracts and lint**

Run: `npm test -- src/lib/uiSurface.test.ts src/lib/studentResultHub.test.ts`

Run: `npx eslint 'src/app/teacher/exam/[id]/page.tsx' src/app/teacher/users/page.tsx src/components/dashboard/tabs/StudentAnalyticsTab.tsx`

Expected: PASS and exit 0.

- [ ] **Step 7: Commit entry-point changes only after overlap review**

Inspect each existing-file diff separately. Do not commit unrelated work already present in the users, analytics, or global UI files.

## Task 8: Add desktop E2E coverage

**Files:**

- Modify: `e2e/teacher-pages.spec.ts`

- [ ] **Step 1: Seed one exam, one original, and one retake**

Add a helper based on the existing local teacher seed pattern. Use stable `studentProfileId: "result-hub-student"` on both attempts, archived handwriting metadata only on the original, and a retake with `sourceAttemptId` pointing to the original.

- [ ] **Step 2: Add the main workflow test**

```ts
test("opens one student result hub and preserves the selected view across attempts", async ({ page, baseURL }) => {
    await authenticateTeacher(page, baseURL);
    await seedStudentResultHub(page);
    await page.goto("/teacher/exam/result-hub-exam");

    await page.getByRole("link", { name: "학생 결과 보기" }).first().click();
    await expect(page).toHaveURL(/\/teacher\/attempt\/result-hub-original/);
    await expect(page.getByRole("tab", { name: "답안" })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "분석" }).click();
    await expect(page).toHaveURL(/view=analytics/);
    await page.getByRole("link", { name: /재시험 1/ }).click();
    await expect(page).toHaveURL(/result-hub-retake\?view=analytics/);
    await expect(page.getByText(/\+20점/)).toBeVisible();

    await page.getByRole("tab", { name: "리포트" }).click();
    await expect(page.getByRole("tabpanel", { name: "리포트" })).toBeVisible();
});
```

- [ ] **Step 3: Add direct-link and browser-history assertions**

Open `?view=handwriting`, confirm the handwriting tab is selected, switch to answers, call `page.goBack()`, and confirm handwriting selection returns. Open `?view=invalid` and confirm answers is selected.

- [ ] **Step 4: Run the focused desktop E2E test**

Run: `npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "student result hub"`

Expected: PASS.

- [ ] **Step 5: Commit E2E coverage only if the test file has no unrelated staged edits**

If it does, leave the E2E addition uncommitted and report the overlap.

## Task 9: Add mobile and accessibility regression coverage

**Files:**

- Modify: `e2e/teacher-mobile.spec.ts`

- [ ] **Step 1: Update the existing mobile attempt-review assertion**

The old test expects `학생 풀이 필기` immediately. Change it to:

```ts
await expect(page.getByRole("tab", { name: "답안" })).toBeVisible();
await page.getByRole("tab", { name: "필기" }).click();
await expect(page.getByRole("heading", { name: "학생 풀이 필기" })).toBeVisible();
```

- [ ] **Step 2: Assert 2×2 tabs, mobile selector, touch size, and no overflow**

At 390×844:

```ts
const tabs = page.getByRole("tablist", { name: "학생 결과 보기" });
const boxes = await Promise.all(["답안", "필기", "리포트", "분석"].map(
    label => tabs.getByRole("tab", { name: label }).boundingBox(),
));
expect(new Set(boxes.map(box => Math.round(box!.y))).size).toBe(2);
for (const box of boxes) expect(box!.height).toBeGreaterThanOrEqual(44);
await expect(page.getByLabel("응시 회차 선택")).toBeVisible();
await expectNoHorizontalOverflow(page);
```

- [ ] **Step 3: Assert keyboard tab focus on desktop Chromium**

Focus `답안`, press `ArrowRight`, and verify `필기` has focus without changing `aria-selected`; press Enter and verify the URL changes to `view=handwriting`.

- [ ] **Step 4: Run the focused mobile test**

Run: `npx playwright test e2e/teacher-mobile.spec.ts --project=teacher-mobile-chrome --grep "attempt review|result tabs"`

Expected: PASS with no horizontal overflow.

## Task 10: Full verification and handoff

**Files:**

- Verify all feature paths above.

- [ ] **Step 1: Run focused unit suites**

```bash
npm test -- \
  src/lib/studentResultHub.test.ts \
  src/lib/studentProfileAnalytics.test.ts \
  src/lib/studentQuestions.test.ts \
  src/lib/premiumAnalytics.test.ts \
  src/lib/uiSurface.test.ts
```

Expected: all PASS.

- [ ] **Step 2: Run lint on every touched implementation file**

```bash
npx eslint \
  'src/app/teacher/attempt/[attemptId]/page.tsx' \
  'src/app/teacher/exam/[id]/page.tsx' \
  src/app/teacher/users/page.tsx \
  src/components/dashboard/tabs/StudentAnalyticsTab.tsx \
  src/components/teacher/student-results/*.tsx \
  src/lib/studentResultHub.ts \
  src/lib/studentResultHub.test.ts
```

Expected: exit 0.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: Next.js build completes successfully.

- [ ] **Step 4: Run desktop and mobile result-hub E2E tests**

```bash
npx playwright test e2e/teacher-pages.spec.ts --project=chromium --grep "student result hub"
npx playwright test e2e/teacher-mobile.spec.ts --project=teacher-mobile-chrome --grep "attempt review|result tabs"
```

Expected: both commands PASS.

- [ ] **Step 5: Perform a manual browser check**

Verify at 1440×900 and 390×844:

- exam row exposes one `학생 결과 보기` action;
- all four tabs are visible;
- original/retake switch preserves `view`;
- handwriting locked, empty, loading-error, and ready states are distinct;
- current report remains readable when growth/PDF export is locked;
- analytics keeps current exam first and cumulative context second;
- back navigation returns to the correct exam;
- no horizontal overflow or clipped primary action.

- [ ] **Step 6: Review final diff without disturbing unrelated work**

```bash
git diff --check
git status --short
git diff -- src/lib/studentResultHub.ts src/lib/studentResultHub.test.ts src/components/teacher/student-results
git diff -- 'src/app/teacher/attempt/[attemptId]/page.tsx' 'src/app/teacher/exam/[id]/page.tsx'
git diff -- src/app/teacher/users/page.tsx src/components/dashboard/tabs/StudentAnalyticsTab.tsx
git diff -- e2e/teacher-pages.spec.ts e2e/teacher-mobile.spec.ts src/lib/uiSurface.test.ts
```

Expected: no whitespace errors; every feature diff maps to this plan; unrelated pre-existing changes remain intact and explicitly excluded from feature commits.
