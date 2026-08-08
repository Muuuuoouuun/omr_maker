# Analytics Report Design Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn teacher exam analytics and individual student reports into one editorial report experience with reliable class-comparison growth metrics, a dense personal report, and a responsive animated Summary/Trend chart.

**Architecture:** Keep the existing dashboard and student-result routes, deep links, print root, plan gates, and dynamic imports. Add pure report-model builders, share only presentation primitives, then replace the exam overview and cumulative-growth presentation behind their existing route boundaries. Rich cohort calculations remain framework-free; React components consume small discriminated view models.

**Tech Stack:** Next.js 16, React 19, TypeScript, CSS Modules, Recharts 3, Vitest 4, Testing Library/jsdom, Playwright.

---

## File map

Create:

- `src/lib/studentGrowthReport.ts` — pure base-attempt cohort, score-gap, rank, and summary projection.
- `src/lib/studentGrowthReport.test.ts` — identity, cohort, rank, partial-data, chronology, and rounding contracts.
- `src/lib/examAnalyticsReport.ts` — deterministic headline-insight projection from existing exam metrics.
- `src/lib/examAnalyticsReport.test.ts` — insight priority and small-sample wording contracts.
- `src/components/AnalyticsReportSection.tsx` — semantic report section surface.
- `src/components/AnalyticsMetricGrid.tsx` — consistent numeric metric grammar.
- `src/components/AnalyticsChartFrame.tsx` — stable chart frame, state copy, accessible fallback, and overflow boundary.
- `src/components/AnalyticsReportPrimitives.module.css` — shared report presentation tokens.
- `src/components/AnalyticsReportPrimitives.test.tsx` — rendered DOM and accessibility contracts.
- `src/components/dashboard/tabs/ExamAnalyticsReportOverview.tsx` — editorial exam overview composition.
- `src/components/dashboard/tabs/ExamAnalyticsReportOverview.test.tsx` — DOM order and state contracts.
- `src/components/teacher/student-results/StudentGrowthReport.tsx` — loading/locked/state boundary and Summary/Trend tabs.
- `src/components/teacher/student-results/GrowthTrendChart.tsx` — student/class lines, gaps, ranks, summary rail, and accessible table.
- `src/components/teacher/student-results/StudentGrowthReport.test.tsx` — tab, zero/one/many point, and reduced-motion contracts.

Modify:

- `package.json`, `package-lock.json` — DOM test dependencies.
- `src/components/dashboard/tabs/ExamAnalyticsTab.tsx` — consume headline model and extracted overview.
- `src/components/dashboard/tabs/ExamAnalyticsTab.module.css` — editorial overview, responsive, and focus styles.
- `src/app/teacher/dashboard/page.tsx` — stop parent action strips competing with the exam report.
- `src/app/teacher/attempt/[attemptId]/page.tsx` — retain cohort attempts/groups and build the growth report model.
- `src/components/teacher/student-results/ReportPanel.tsx` — dense editorial report composition.
- `src/components/teacher/student-results/AnalyticsPanel.tsx` — remove duplicated cumulative-growth block.
- `src/components/teacher/student-results/StudentResultHub.module.css` — dense report, chart, scroll, print, and motion styles.
- `src/lib/uiSurface.test.ts` — update structural contracts for the nonduplicated growth report.
- `e2e/teacher-pages.spec.ts` — personal report navigation, Summary/Trend, and print continuity.
- `e2e/ui-ux-audit.spec.ts` — motion-off and overflow contracts.

## Task 1: Add the DOM component-test harness

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Test: `src/components/AnalyticsReportPrimitives.test.tsx`

- [ ] **Step 1: Install the component-test dependencies**

Run:

```bash
npm install --save-dev @testing-library/react @testing-library/jest-dom jsdom
```

Expected: `package.json` and `package-lock.json` add the three dev dependencies without changing production dependencies.

- [ ] **Step 2: Write a failing jsdom smoke test**

Create `src/components/AnalyticsReportPrimitives.test.tsx`:

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import AnalyticsReportSection from "./AnalyticsReportSection";

afterEach(cleanup);

describe("AnalyticsReportSection", () => {
    it("links the section to its visible title", () => {
        render(<AnalyticsReportSection id="growth" title="개인 성장">내용</AnalyticsReportSection>);
        expect(screen.getByRole("region", { name: "개인 성장" })).toHaveAttribute(
            "aria-labelledby",
            "growth-title",
        );
    });
});
```

- [ ] **Step 3: Run the smoke test and verify RED**

Run:

```bash
npx vitest run src/components/AnalyticsReportPrimitives.test.tsx
```

Expected: FAIL because `./AnalyticsReportSection` does not exist.

- [ ] **Step 4: Add the smallest component needed to verify the harness**

Create `src/components/AnalyticsReportSection.tsx`:

```tsx
import type { ReactNode } from "react";

export default function AnalyticsReportSection(props: {
    id: string;
    title: ReactNode;
    children: ReactNode;
}) {
    const titleId = `${props.id}-title`;
    return (
        <section aria-labelledby={titleId}>
            <h2 id={titleId}>{props.title}</h2>
            {props.children}
        </section>
    );
}
```

- [ ] **Step 5: Run the smoke test and the existing component tests**

Run:

```bash
npx vitest run src/components/AnalyticsReportPrimitives.test.tsx src/components/AnswerImportModal.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the harness**

```bash
git add package.json package-lock.json src/components/AnalyticsReportSection.tsx src/components/AnalyticsReportPrimitives.test.tsx
git commit -m "test: add analytics component harness"
```

## Task 2: Build the pure student-growth report model

**Files:**
- Create: `src/lib/studentGrowthReport.ts`
- Create: `src/lib/studentGrowthReport.test.ts`
- Read: `src/lib/studentProfileAnalytics.ts`
- Read: `src/lib/scoreDistribution.ts`
- Read: `src/utils/storage.ts`

- [ ] **Step 1: Write failing cohort and chronology tests**

Create `src/lib/studentGrowthReport.test.ts` with minimal `Attempt` fixtures and these assertions:

```ts
import { describe, expect, it } from "vitest";
import { buildStudentGrowthReport } from "./studentGrowthReport";

describe("buildStudentGrowthReport", () => {
    it("uses base attempts from the same class and returns oldest to newest", () => {
        const report = buildStudentGrowthReport({
            selectedStudentId: "s1",
            selectedClassKey: "class-a",
            dataStatus: "ready",
            attempts: [
                attempt("a2", "e2", "s1", "class-a", 70, "2026-02-01"),
                attempt("peer2", "e2", "s2", "class-a", 90, "2026-02-01"),
                attempt("other", "e2", "s3", "class-b", 10, "2026-02-01"),
                attempt("a1", "e1", "s1", "class-a", 60, "2026-01-01"),
                attempt("peer1", "e1", "s2", "class-a", 80, "2026-01-01"),
            ],
            exams: [exam("e1", "1차"), exam("e2", "2차")],
        });

        expect(report.rows.map(row => row.examId)).toEqual(["e1", "e2"]);
        expect(report.rows.map(row => row.classAverage)).toEqual([70, 80]);
        expect(report.rows.map(row => row.gap)).toEqual([-10, -10]);
    });

    it("excludes retakes and gives tied students the same rank", () => {
        const report = buildStudentGrowthReport({
            selectedStudentId: "s1",
            selectedClassKey: "class-a",
            dataStatus: "ready",
            attempts: [
                attempt("base", "e1", "s1", "class-a", 80, "2026-01-01"),
                { ...attempt("retake", "e1", "s1", "class-a", 100, "2026-01-02"), retake: { sourceAttemptId: "base", questionIds: [1], mode: "wrong" } },
                attempt("peer", "e1", "s2", "class-a", 80, "2026-01-01"),
            ],
            exams: [exam("e1", "1차")],
        });

        expect(report.rows[0]).toMatchObject({ studentScore: 80, rank: 1, participantCount: 2 });
    });
});
```

Define local `attempt(...)` and `exam(...)` fixture builders in the same test with all required `Attempt`/`Exam` fields. Keep fixtures in this file so production tests do not depend on E2E helpers.

```ts
function attempt(id: string, examId: string, studentId: string, classId: string, score: number, finishedAt: string): Attempt {
    return { id, examId, examTitle: examId, studentName: studentId, studentId, classId, startedAt: finishedAt, finishedAt, score, totalScore: 100, answers: {} } as Attempt;
}

function exam(id: string, title: string): Exam {
    return { id, title, questions: [], createdAt: "2026-01-01" } as Exam;
}
```

- [ ] **Step 2: Run the model test and verify RED**

Run:

```bash
npx vitest run src/lib/studentGrowthReport.test.ts
```

Expected: FAIL because `buildStudentGrowthReport` does not exist.

- [ ] **Step 3: Implement the view-model types and calculation**

Create `src/lib/studentGrowthReport.ts`:

```ts
import type { Attempt, Exam } from "@/types/omr";
import { resolveAttemptScore } from "@/lib/attemptScores";

export type GrowthDataStatus = "ready" | "partial" | "stale";

export interface StudentGrowthRow {
    examId: string;
    examTitle: string;
    finishedAt: string;
    studentScore: number;
    classAverage: number;
    gap: number;
    rank: number | null;
    participantCount: number;
    isLatest: boolean;
}

export interface StudentGrowthReportModel {
    status: GrowthDataStatus;
    rows: StudentGrowthRow[];
    latestScore: number | null;
    averageGap: number | null;
    currentRank: number | null;
    rankDelta: number | null;
    trend: "up" | "down" | "flat" | "insufficient";
}

function studentKey(attempt: Attempt): string {
    return attempt.studentProfileId || attempt.studentId || attempt.studentName.trim();
}

function classKey(attempt: Attempt): string {
    return attempt.classId || attempt.groupId || `${attempt.regionName || attempt.regionId || ""}::${attempt.groupName || ""}`;
}

export function buildStudentGrowthReport(input: {
    selectedStudentId: string;
    selectedClassKey: string;
    dataStatus: GrowthDataStatus;
    attempts: Attempt[];
    exams: Exam[];
}): StudentGrowthReportModel {
    const examById = new Map(input.exams.map(exam => [exam.id, exam]));
    const base = input.attempts.filter(attempt => !attempt.retake && classKey(attempt) === input.selectedClassKey);
    const selected = base
        .filter(attempt => studentKey(attempt) === input.selectedStudentId)
        .sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));

    const rows = selected.map(attempt => {
        const peers = base.filter(candidate => candidate.examId === attempt.examId);
        const scores = peers.map(candidate => resolveAttemptScore(candidate, examById.get(candidate.examId)).scorePercent);
        const studentScore = resolveAttemptScore(attempt, examById.get(attempt.examId)).scorePercent;
        const classAverage = Math.round(scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length));
        const rank = scores.length < 2 ? null : 1 + scores.filter(score => score > studentScore).length;
        return {
            examId: attempt.examId,
            examTitle: examById.get(attempt.examId)?.title || attempt.examTitle,
            finishedAt: attempt.finishedAt,
            studentScore,
            classAverage,
            gap: studentScore - classAverage,
            rank,
            participantCount: scores.length,
            isLatest: false,
        };
    });
    if (rows.length > 0) rows[rows.length - 1].isLatest = true;
    const latest = rows.at(-1);
    const previous = rows.at(-2);
    const averageGap = rows.length ? Math.round(rows.reduce((sum, row) => sum + row.gap, 0) / rows.length * 10) / 10 : null;
    const delta = latest && previous ? latest.studentScore - previous.studentScore : 0;
    return {
        status: input.dataStatus,
        rows,
        latestScore: latest?.studentScore ?? null,
        averageGap,
        currentRank: latest?.rank ?? null,
        rankDelta: latest?.rank && previous?.rank ? previous.rank - latest.rank : null,
        trend: rows.length < 2 ? "insufficient" : delta > 1 ? "up" : delta < -1 ? "down" : "flat",
    };
}
```

- [ ] **Step 4: Add edge-case tests**

Add tests for duplicate class names in different regions, one participant (`rank: null`), missing exam metadata, `partial` propagation, stable tie ranking, and rounded average gaps. Add a repeated-submission test that fixes the representative-attempt policy before changing the implementation.

- [ ] **Step 5: Run the model suite and verify GREEN**

Run:

```bash
npx vitest run src/lib/studentGrowthReport.test.ts src/lib/scoreDistribution.test.ts src/lib/studentProfileAnalytics.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the growth model**

```bash
git add src/lib/studentGrowthReport.ts src/lib/studentGrowthReport.test.ts
git commit -m "feat: model student growth comparisons"
```

## Task 3: Build deterministic exam headline insights

**Files:**
- Create: `src/lib/examAnalyticsReport.ts`
- Create: `src/lib/examAnalyticsReport.test.ts`

- [ ] **Step 1: Write failing priority and small-sample tests**

```ts
import { describe, expect, it } from "vitest";
import { buildExamHeadlineInsight } from "./examAnalyticsReport";

describe("buildExamHeadlineInsight", () => {
    it("prioritizes a supported weak concept", () => {
        expect(buildExamHeadlineInsight({
            submissionCount: 24,
            weakConcept: "이차방정식",
            weakConceptRate: 54,
            lowStudentCount: 9,
            riskyQuestionCount: 3,
        })).toMatchObject({ tone: "action", title: "‘이차방정식’ 보강이 가장 효과적입니다" });
    });

    it("uses observation language for fewer than five submissions", () => {
        expect(buildExamHeadlineInsight({
            submissionCount: 3,
            weakConcept: "확률",
            weakConceptRate: 40,
            lowStudentCount: 2,
            riskyQuestionCount: 1,
        }).title).toContain("표본이 더 필요합니다");
    });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/lib/examAnalyticsReport.test.ts`  
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the deterministic projection**

```ts
export interface ExamHeadlineInsightInput {
    submissionCount: number;
    weakConcept?: string;
    weakConceptRate?: number;
    lowStudentCount: number;
    riskyQuestionCount: number;
}

export interface ExamHeadlineInsight {
    tone: "action" | "observation" | "positive";
    title: string;
    detail: string;
}

export function buildExamHeadlineInsight(input: ExamHeadlineInsightInput): ExamHeadlineInsight {
    if (input.submissionCount < 5) {
        return { tone: "observation", title: "경향을 확정하려면 표본이 더 필요합니다", detail: `현재 ${input.submissionCount}명 제출 기준입니다.` };
    }
    if (input.weakConcept && (input.weakConceptRate ?? 100) < 70) {
        return { tone: "action", title: `‘${input.weakConcept}’ 보강이 가장 효과적입니다`, detail: `정답률 ${input.weakConceptRate}% · 지원 학생 ${input.lowStudentCount}명 · 점검 문항 ${input.riskyQuestionCount}개` };
    }
    if (input.riskyQuestionCount > 0) {
        return { tone: "observation", title: "문항별 정답률 차이를 먼저 점검해 주세요", detail: `재점검이 필요한 문항 ${input.riskyQuestionCount}개입니다.` };
    }
    return { tone: "positive", title: "현재 시험에서는 뚜렷한 위험 신호가 없습니다", detail: `${input.submissionCount}명 제출 기준입니다.` };
}
```

- [ ] **Step 4: Run tests and commit**

Run: `npx vitest run src/lib/examAnalyticsReport.test.ts`  
Expected: PASS.

```bash
git add src/lib/examAnalyticsReport.ts src/lib/examAnalyticsReport.test.ts
git commit -m "feat: derive exam report headlines"
```

## Task 4: Finish the shared report presentation primitives

**Files:**
- Modify: `src/components/AnalyticsReportSection.tsx`
- Create: `src/components/AnalyticsMetricGrid.tsx`
- Create: `src/components/AnalyticsChartFrame.tsx`
- Create: `src/components/AnalyticsReportPrimitives.module.css`
- Modify: `src/components/AnalyticsReportPrimitives.test.tsx`

- [ ] **Step 1: Expand the failing DOM contracts**

Add tests that assert compact/default density classes, metric label/value/unit/trend, loading `role=status`, error `role=alert`, ready chart summary, and an accessible fallback table:

```tsx
it("renders metric value, unit, and trend as one readable definition", () => {
    render(<AnalyticsMetricGrid metrics={[{ label: "평균 점수", value: 82.4, unit: "점", trend: { direction: "up", label: "+6.2" } }]} />);
    expect(screen.getByText("82.4")).toHaveClass("numeric-emphasis");
    expect(screen.getByText("점")).toBeVisible();
    expect(screen.getByText("+6.2")).toHaveAttribute("data-direction", "up");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/components/AnalyticsReportPrimitives.test.tsx`  
Expected: FAIL because metric/chart primitives are missing.

- [ ] **Step 3: Implement stable APIs**

Use these exported types exactly:

```ts
export type AnalyticsMetricTone = "neutral" | "success" | "warning" | "grade" | "retake";
export interface AnalyticsMetricItem {
    label: string;
    value: string | number;
    unit?: string;
    detail?: string;
    trend?: { direction: "up" | "down" | "flat"; label: string };
    tone?: AnalyticsMetricTone;
    animate?: boolean;
}

export type AnalyticsChartState =
    | { status: "loading"; message: string }
    | { status: "empty"; message: string }
    | { status: "error"; message: string; onRetry: () => void }
    | { status: "ready"; summary: string };
```

`AnalyticsReportSection` owns `<section aria-labelledby>`, heading/actions/meta layout, density, and print-break classes. `AnalyticsMetricGrid` renders a `<dl>`. `AnalyticsChartFrame` renders its state before children and keeps `min-width: 0`, a stable CSS minimum height, and an optional accessible table after the visual chart.

- [ ] **Step 4: Add CSS using existing tokens**

```css
.section { min-width: 0; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface); }
.metricValue { font-size: var(--type-metric); color: var(--foreground); font-variant-numeric: tabular-nums; }
.chartFrame { min-width: 0; min-height: 18rem; overflow: hidden; }
.scrollRegion { min-width: 0; overflow-x: auto; overscroll-behavior-x: contain; }
@media print { .section { break-inside: avoid; box-shadow: none; } }
```

- [ ] **Step 5: Run tests and commit**

Run: `npx vitest run src/components/AnalyticsReportPrimitives.test.tsx src/components/dashboard/CountUp.test.ts`  
Expected: PASS.

```bash
git add src/components/AnalyticsReportSection.tsx src/components/AnalyticsMetricGrid.tsx src/components/AnalyticsChartFrame.tsx src/components/AnalyticsReportPrimitives.module.css src/components/AnalyticsReportPrimitives.test.tsx
git commit -m "feat: add analytics report primitives"
```

## Task 5: Replace the exam overview with the editorial report composition

**Files:**
- Create: `src/components/dashboard/tabs/ExamAnalyticsReportOverview.tsx`
- Create: `src/components/dashboard/tabs/ExamAnalyticsReportOverview.test.tsx`
- Modify: `src/components/dashboard/tabs/ExamAnalyticsTab.tsx:668-959,1728-1992`
- Modify: `src/components/dashboard/tabs/ExamAnalyticsTab.module.css`
- Modify: `src/app/teacher/dashboard/page.tsx:927-1120`

- [ ] **Step 1: Write the failing report-order test**

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import ExamAnalyticsReportOverview from "./ExamAnalyticsReportOverview";

afterEach(cleanup);

it("orders metrics, headline, evidence, then actions", () => {
    render(<ExamAnalyticsReportOverview
        metrics={[{ label: "평균 점수", value: 82.4, unit: "점" }]}
        headline={{ tone: "action", title: "보강이 필요합니다", detail: "취약 문항 3개" }}
        distribution={[{ label: "80-89", min: 80, max: 90, count: 8 }]}
        weakQuestions={[{ questionNumber: 17, title: "이차방정식", correctRate: 32 }]}
        achievementBands={[{ label: "80-100점", count: 8, percent: 40, tone: "strong" }]}
        actions={[{ key: "retake", title: "재시험 세트", detail: "취약 문항 3개" }]}
        sampleStatus="ready"
    />);
    const names = screen.getAllByRole("region").map(region => region.getAttribute("aria-label") || region.getAttribute("aria-labelledby"));
    expect(names).toEqual(expect.arrayContaining(["시험 핵심 지표", "시험 핵심 해석", "점수 분포", "취약 문항", "다음 행동"]));
    expect(document.body.textContent?.indexOf("시험 핵심 해석")).toBeLessThan(document.body.textContent?.indexOf("점수 분포") ?? 0);
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/components/dashboard/tabs/ExamAnalyticsReportOverview.test.tsx`  
Expected: FAIL because the component does not exist.

- [ ] **Step 3: Create the overview composition**

Define one props object that contains already-derived data; do not move 3000 lines of calculations into the child:

```tsx
export interface ExamAnalyticsReportOverviewProps {
    metrics: AnalyticsMetricItem[];
    headline: ExamHeadlineInsight;
    distribution: ScoreBucket[];
    weakQuestions: Array<{ questionNumber: number; title: string; correctRate: number }>;
    achievementBands: Array<{ label: string; count: number; percent: number; tone: "support" | "watch" | "secure" | "strong" }>;
    actions: Array<{ key: string; title: string; detail: string; href?: string }>;
    sampleStatus: "ready" | "partial" | "stale";
}

export default function ExamAnalyticsReportOverview(props: ExamAnalyticsReportOverviewProps) {
    return (
        <div className={styles.reportOverview}>
            <AnalyticsReportSection id="exam-metrics" title="시험 핵심 지표"><AnalyticsMetricGrid metrics={props.metrics} /></AnalyticsReportSection>
            <AnalyticsReportSection id="exam-headline" title="시험 핵심 해석" density="compact">
                <p>{props.headline.title}</p><span>{props.headline.detail}</span>
            </AnalyticsReportSection>
            <div className={styles.evidenceGrid}>
                <ScoreDistributionEvidence data={props.distribution} />
                <AchievementBandsEvidence bands={props.achievementBands} />
            </div>
            <WeakQuestionsEvidence rows={props.weakQuestions} />
            <ExamNextActions actions={props.actions} />
        </div>
    );
}

function ScoreDistributionEvidence({ data }: { data: ScoreBucket[] }) {
    return <AnalyticsReportSection id="score-distribution" title="점수 분포"><div role="img" aria-label={`점수 분포 ${data.reduce((sum, bucket) => sum + bucket.count, 0)}명`} /></AnalyticsReportSection>;
}

function AchievementBandsEvidence({ bands }: { bands: ExamAnalyticsReportOverviewProps["achievementBands"] }) {
    return <AnalyticsReportSection id="achievement-bands" title="성취 구간"><ul>{bands.map(band => <li key={band.label}>{band.label} {band.count}명</li>)}</ul></AnalyticsReportSection>;
}

function WeakQuestionsEvidence({ rows }: { rows: ExamAnalyticsReportOverviewProps["weakQuestions"] }) {
    return <AnalyticsReportSection id="weak-questions" title="취약 문항"><table><tbody>{rows.map(row => <tr key={row.questionNumber}><th>{row.questionNumber}번</th><td>{row.title}</td><td>{row.correctRate}%</td></tr>)}</tbody></table></AnalyticsReportSection>;
}

function ExamNextActions({ actions }: { actions: ExamAnalyticsReportOverviewProps["actions"] }) {
    return <AnalyticsReportSection id="exam-actions" title="다음 행동"><ul>{actions.map(action => <li key={action.key}>{action.title}<span>{action.detail}</span></li>)}</ul></AnalyticsReportSection>;
}
```

Keep chart/table subcomponents in this file for the first pass; split only after the component test is green.

- [ ] **Step 4: Wire existing data without changing calculations**

In `ExamAnalyticsTab.tsx`, derive `headline` with `buildExamHeadlineInsight(...)`, build `metrics` from the existing `stats`, and replace only the `activeWorkspaceView === "overview"` JSX with `ExamAnalyticsReportOverview`. Preserve retake exclusion, region scoping, premium gates, selected exam behavior, and all other inner views.

- [ ] **Step 5: Remove parent-level competition only on the exam tab**

In `src/app/teacher/dashboard/page.tsx`, keep system repair warnings but wrap the existing generic “분석 다음 조치” JSX so it is hidden when `activeTab === "exam"`:

```diff
- {analyticsNextActions.length > 0 && (
+ {activeTab !== "exam" && analyticsNextActions.length > 0 && (
```

Do not remove the data-health repair surface.

- [ ] **Step 6: Run focused and performance tests**

Run:

```bash
npx vitest run src/components/dashboard/tabs/ExamAnalyticsReportOverview.test.tsx src/lib/examAnalyticsReport.test.ts src/lib/dashboardPerformanceSurface.test.ts src/lib/uiSurface.test.ts
```

Expected: PASS; analytics remains dynamically imported.

- [ ] **Step 7: Commit the exam report**

```bash
git add src/components/dashboard/tabs/ExamAnalyticsReportOverview.tsx src/components/dashboard/tabs/ExamAnalyticsReportOverview.test.tsx src/components/dashboard/tabs/ExamAnalyticsTab.tsx src/components/dashboard/tabs/ExamAnalyticsTab.module.css src/app/teacher/dashboard/page.tsx
git commit -m "feat: redesign exam analytics overview"
```

## Task 6: Build the dense student growth report and polished chart

**Files:**
- Create: `src/components/teacher/student-results/StudentGrowthReport.tsx`
- Create: `src/components/teacher/student-results/GrowthTrendChart.tsx`
- Create: `src/components/teacher/student-results/StudentGrowthReport.test.tsx`
- Modify: `src/components/teacher/student-results/StudentResultHub.module.css`

- [ ] **Step 1: Write failing Summary/Trend and accessibility tests**

```tsx
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import StudentGrowthReport from "./StudentGrowthReport";

afterEach(cleanup);

it("switches between summary and trend-only panels", () => {
    const model: StudentGrowthReportModel = {
        status: "ready",
        rows: [{ examId: "e1", examTitle: "1차", finishedAt: "2026-01-01", studentScore: 60, classAverage: 70, gap: -10, rank: 2, participantCount: 3, isLatest: true }],
        latestScore: 60,
        averageGap: -10,
        currentRank: 2,
        rankDelta: null,
        trend: "insufficient",
    };
    render(<StudentGrowthReport state={{ status: "ready", model }} enabled onRetry={() => {}} />);
    fireEvent.click(screen.getByRole("tab", { name: "추세만" }));
    expect(screen.getByRole("tab", { name: "추세만" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByLabelText("최근 시험 요약")).not.toBeInTheDocument();
    expect(screen.getByRole("table", { name: "개인 성장 데이터" })).toBeInTheDocument();
});

it("renders a readable one-point state without a misleading trend", () => {
    const model: StudentGrowthReportModel = {
        status: "ready",
        rows: [{ examId: "e1", examTitle: "1차", finishedAt: "2026-01-01", studentScore: 60, classAverage: 70, gap: -10, rank: null, participantCount: 1, isLatest: true }],
        latestScore: 60,
        averageGap: -10,
        currentRank: null,
        rankDelta: null,
        trend: "insufficient",
    };
    render(<StudentGrowthReport state={{ status: "ready", model }} enabled onRetry={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("비교할 시험이 더 필요합니다");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/components/teacher/student-results/StudentGrowthReport.test.tsx`  
Expected: FAIL because the components do not exist.

- [ ] **Step 3: Implement the state boundary and internal tabs**

Use this discriminated state:

```ts
export type StudentGrowthReportState =
    | { status: "idle" | "loading" }
    | { status: "error"; message: string }
    | { status: "empty"; message: string }
    | { status: "ready" | "stale" | "partial"; model: StudentGrowthReportModel; message?: string };
```

`StudentGrowthReport` keeps `mode: "summary" | "trend"`, renders `role=tablist`, and implements ArrowLeft/ArrowRight/Home/End plus Enter/Space. Locked plans continue to render `LockedFeaturePanel`.

- [ ] **Step 4: Implement the visual chart without duplicate animation ownership**

`GrowthTrendChart` uses Recharts `LineChart`, `Line`, `XAxis`, `YAxis`, `CartesianGrid`, and `ResponsiveContainer`. Set `isAnimationActive={false}` on both lines. Render:

```tsx
<Line dataKey="classAverage" stroke="var(--muted)" strokeDasharray="6 6" dot={false} isAnimationActive={false} />
<Line dataKey="studentScore" stroke="var(--primary)" strokeWidth={3} dot={<GrowthPoint />} isAnimationActive={false} className="growth-chart-target" />
```

Place gap pills and rank labels in deterministic custom SVG renderers. Wrap the chart in a named focusable horizontal-scroll region with a visible scroll hint. Provide a visually-hidden or print-visible `<table aria-label="개인 성장 데이터">` with exam, student score, class average, gap, rank, and participant count.

- [ ] **Step 5: Add purposeful reduced-motion-aware animation**

Create one hook inside `GrowthTrendChart.tsx` that exits when `matchMedia("(prefers-reduced-motion: reduce)").matches` or `document.documentElement.dataset.motion === "off"`. It adds one CSS class after mount; CSS owns line draw, point pop, gap reveal, and latest-point pulse. Cleanup removes the class. Do not poll for SVG nodes and do not replay on Summary/Trend toggles.

```css
.growthChartAnimated .studentLine { stroke-dasharray: 1000; animation: growth-line-draw var(--transition-smooth) var(--ease-out-soft) both; }
.latestPoint { animation: growth-point-pulse 2.4s ease-in-out 1.1s infinite; }
@media (prefers-reduced-motion: reduce) { .growthChartAnimated .studentLine, .latestPoint { animation: none; } }
html[data-motion="off"] .growthChartAnimated .studentLine,
html[data-motion="off"] .latestPoint { animation: none; }
```

- [ ] **Step 6: Add responsive and print CSS**

Desktop shows graph plus summary rail. Below 760px, place the rail below the graph; Trend-only hides it. Keep the graph canvas minimum width inside its own scroll region, add the Korean scroll hint, and set every grid child to `min-width: 0`. Under print, disable fixed chart height and show the data table.

- [ ] **Step 7: Run component tests and commit**

Run:

```bash
npx vitest run src/components/teacher/student-results/StudentGrowthReport.test.tsx src/lib/studentGrowthReport.test.ts src/components/PDFViewer.readiness.test.ts
```

Expected: PASS.

```bash
git add src/components/teacher/student-results/StudentGrowthReport.tsx src/components/teacher/student-results/GrowthTrendChart.tsx src/components/teacher/student-results/StudentGrowthReport.test.tsx src/components/teacher/student-results/StudentResultHub.module.css
git commit -m "feat: add student growth report chart"
```

## Task 7: Wire cohort data into the individual report and remove duplication

**Files:**
- Modify: `src/app/teacher/attempt/[attemptId]/page.tsx:315-455,745-830`
- Modify: `src/components/teacher/student-results/ReportPanel.tsx`
- Modify: `src/components/teacher/student-results/AnalyticsPanel.tsx`
- Modify: `src/lib/uiSurface.test.ts:1204-1290`

- [ ] **Step 1: Write failing wiring contracts**

Update `src/lib/uiSurface.test.ts` to require:

```ts
expect(attemptPageSource).toContain("buildStudentGrowthReport");
expect(reportPanelSource).toContain("StudentGrowthReport");
expect(analyticsPanelSource).not.toContain("CumulativeGrowthPanel");
expect(reportPanelSource).toContain("student-result-report-print-root");
```

- [ ] **Step 2: Run and verify RED**

Run: `npx vitest run src/lib/uiSurface.test.ts`  
Expected: FAIL on the new wiring expectations.

- [ ] **Step 3: Retain cohort inputs in the page load**

Replace selected-only cumulative storage with all-attempt and roster-group state:

```ts
const [cumulativeAttempts, setCumulativeAttempts] = useState<Attempt[]>([]);
const [cumulativeGroups, setCumulativeGroups] = useState<RosterGroup[]>([]);
```

After `loadTeacherRosterSnapshot`, keep `attemptResult.items` and `rosterResult.groups`; still use `filterCumulativeAttemptsForStudent(...)` only for `buildStudentProfileInsight`. Map `remotePartial` to `partial`, remote warnings to `stale`, and clean complete data to `ready`.

- [ ] **Step 4: Build one growth model in `useMemo`**

```ts
const growthReport = useMemo(() => {
    if (!attempt || !rosterStudent) return null;
    const selectedClassKey = attempt.classId || attempt.groupId || `${attempt.regionName || attempt.regionId || ""}::${attempt.groupName || rosterStudent.group}`;
    const selectedStudentId = attempt.studentProfileId || attempt.studentId || rosterStudent.id;
    return buildStudentGrowthReport({
        selectedStudentId,
        selectedClassKey,
        dataStatus: cumulativeStatus === "stale" ? "stale" : cumulativeStatus === "partial" ? "partial" : "ready",
        attempts: cumulativeAttempts,
        exams: cumulativeExams,
    });
}, [attempt, cumulativeAttempts, cumulativeExams, cumulativeStatus, rosterStudent]);
```

Extend `CumulativeLoadStatus` with `partial` until the old component is removed.

- [ ] **Step 5: Render the dense report and remove the duplicate**

In `ReportPanel`, keep the print root and current exam summary/feedback, replace `CumulativeGrowthPanel` with `StudentGrowthReport`, and reorder sections to context → metrics → headline → growth evidence → weakness/recommendations → detailed history. In `AnalyticsPanel`, remove its `CumulativeGrowthPanel` block so current-exam analytics remains focused.

- [ ] **Step 6: Run result-hub tests**

Run:

```bash
npx vitest run src/lib/uiSurface.test.ts src/lib/studentResultHub.test.ts src/components/teacher/student-results/StudentGrowthReport.test.tsx
```

Expected: PASS; print root and four existing deep-link views remain present.

- [ ] **Step 7: Commit the integration**

```bash
git add 'src/app/teacher/attempt/[attemptId]/page.tsx' src/components/teacher/student-results/ReportPanel.tsx src/components/teacher/student-results/AnalyticsPanel.tsx src/lib/uiSurface.test.ts
git commit -m "feat: integrate dense student reports"
```

## Task 8: Browser QA, visual fidelity, and full verification

**Files:**
- Modify: `e2e/teacher-pages.spec.ts`
- Modify: `e2e/ui-ux-audit.spec.ts`
- Modify: `src/components/dashboard/tabs/ExamAnalyticsReportOverview.tsx`
- Modify: `src/components/dashboard/tabs/ExamAnalyticsTab.module.css`
- Modify: `src/components/teacher/student-results/GrowthTrendChart.tsx`
- Modify: `src/components/teacher/student-results/StudentResultHub.module.css`

- [ ] **Step 1: Write failing E2E contracts**

Add tests that enter the demo/teacher dashboard, open exam analysis, verify DOM order, follow a student result link, switch Summary/Trend, and verify no document overflow at 1440, 1024, 760, 390, and 320 widths. Add app motion-off coverage:

```ts
await page.evaluate(() => document.documentElement.dataset.motion = "off");
await expect(page.getByRole("img", { name: /학생 점수와 반 평균/ })).toBeVisible();
await expect(page.locator(".latestPoint")).toHaveCSS("animation-name", "none");
```

- [ ] **Step 2: Run the new E2E tests and verify RED**

Run:

```bash
npx playwright test e2e/teacher-pages.spec.ts e2e/ui-ux-audit.spec.ts --project=chromium
```

Expected: FAIL until final selectors, motion, and responsive behavior are complete.

- [ ] **Step 3: Start the app and inspect native desktop first**

Run: `npm run dev`  
Inspect at 1440×900 in the in-app Browser. Compare against the accepted B-style report mockups saved under `.superpowers/brainstorm/`. Check context, large metrics, headline, evidence, actions, personal density, line/gap/rank readability, and Summary/Trend transition.

- [ ] **Step 4: Fix every visible mismatch**

Use only existing design tokens unless a missing semantic token is documented in `docs/design-system.md`. Keep Korean headings at no stronger than `-0.01em`; use `.numeric-emphasis`; keep grade/system-error colors separate. Repeat browser screenshots until no clipping, accidental wrapping, illegible labels, or page-level horizontal overflow remains.

- [ ] **Step 5: Verify responsive, print, and motion states**

Check 1024×768, 760px, 520px, 390px, 320px, 200% zoom, long Korean exam names, zero/one/eight points, partial data, OS reduced motion, app motion-off, and print preview. The graph may scroll only inside its named chart region at narrow widths.

- [ ] **Step 6: Run the complete verification set**

```bash
npm test
npm run lint
npm run build
npx playwright test e2e/teacher-pages.spec.ts e2e/ui-ux-audit.spec.ts --project=chromium
```

Expected: all commands exit 0. `npm run build` also passes the route performance budget postbuild check.

- [ ] **Step 7: Commit QA repairs**

```bash
git add e2e/teacher-pages.spec.ts e2e/ui-ux-audit.spec.ts src/components src/app/teacher src/lib
git commit -m "test: verify analytics report experience"
```

## Task 9: Final review and handoff

**Files:**
- Review: all files changed by Tasks 1–8

- [ ] **Step 1: Run whitespace and scope checks**

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and no unrelated user files staged.

- [ ] **Step 2: Review the final diff against the design spec**

Run:

```bash
git diff HEAD~8 -- docs/superpowers/specs/2026-08-08-analytics-report-design.md src/components src/lib src/app/teacher e2e
```

Confirm every acceptance criterion in the spec has an implementation or test and no non-goal was added.

- [ ] **Step 3: Request code review**

Use `superpowers:requesting-code-review` with the complete change range. Address only verified, actionable findings.

- [ ] **Step 4: Re-run verification after review fixes**

Run the complete verification commands from Task 8 Step 6 again.  
Expected: all commands exit 0 after review fixes.

- [ ] **Step 5: Prepare branch completion**

Use `superpowers:finishing-a-development-branch` to present merge/push/PR choices without changing remote state unless the user authorizes it.
