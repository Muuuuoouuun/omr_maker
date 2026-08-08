// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExamAnalyticsReportOverview, {
    type ExamAnalyticsReportOverviewProps,
} from "./ExamAnalyticsReportOverview";
import ExamAnalyticsTab, { QuestionCorrectRateTooltip } from "./ExamAnalyticsTab";
import type { Attempt, Exam, QuestionResult } from "@/types/omr";

afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-motion");
});

function buildUngradedExamAnalyticsFixture(): { exam: Exam; attempts: Attempt[] } {
    const exam: Exam = {
        id: "exam-ungraded",
        title: "미채점 진단",
        createdAt: "2026-08-08T09:00:00.000Z",
        questions: [{
            id: 1,
            number: 1,
            label: "문법",
            score: 10,
            choices: 4,
            tags: { concept: "시제" },
        }],
    };
    const attempts = Array.from({ length: 5 }, (_, index) => {
        const id = `attempt-ungraded-${index + 1}`;
        const finishedAt = `2026-08-08T09:${String(index + 10).padStart(2, "0")}:00.000Z`;
        const result: QuestionResult = {
            schemaVersion: 1,
            attemptId: id,
            examId: exam.id,
            examTitle: exam.title,
            studentName: `학생 ${index + 1}`,
            questionId: 1,
            questionNumber: 1,
            label: "문법",
            concept: "시제",
            score: 0,
            earnedScore: 0,
            status: "ungraded",
            isCorrect: false,
            isWrong: false,
            isUnanswered: false,
            finishedAt,
        };

        return {
            id,
            examId: exam.id,
            examTitle: exam.title,
            studentName: result.studentName,
            startedAt: "2026-08-08T09:00:00.000Z",
            finishedAt,
            score: 0,
            totalScore: 0,
            answers: {},
            questionResults: [result],
            status: "completed" as const,
        };
    });

    return { exam, attempts };
}

function buildProps(
    overrides: Partial<ExamAnalyticsReportOverviewProps> = {},
): ExamAnalyticsReportOverviewProps {
    return {
        metrics: [
            { id: "mean", label: "평균", value: 74, unit: "점" },
            { id: "median", label: "중앙값", value: 76, unit: "점" },
            { id: "maximum", label: "최고", value: 98, unit: "점" },
            { id: "minimum", label: "최저", value: 32, unit: "점", tone: "grade" },
            { id: "submissions", label: "응시", value: 18, unit: "명" },
            { id: "elapsed", label: "평균 시간", value: "18분 20초" },
        ],
        headline: {
            tone: "action",
            title: "‘이차함수’ 보강이 가장 효과적입니다",
            detail: "정답률 48% · 지원 학생 4명 · 점검 문항 3개",
        },
        distribution: [
            { label: "0-10", min: 0, max: 10, count: 1 },
            { label: "10-20", min: 10, max: 20, count: 2 },
            { label: "20-30", min: 20, max: 30, count: 4 },
            { label: "30-40", min: 30, max: 40, count: 2 },
        ],
        weakQuestions: [
            {
                key: "q-7",
                questionNumber: 7,
                title: "이차함수",
                correctRate: 32,
                evidence: "가장 많이 선택한 오답 3번 · 44%",
            },
            {
                key: "q-12",
                questionNumber: 12,
                title: "확률",
                correctRate: 57,
                evidence: "미응답 2명",
            },
        ],
        achievementBands: [
            { key: "under-40", label: "40점 미만", count: 2, percent: 11, tone: "grade" },
            { key: "under-60", label: "40~59점", count: 4, percent: 22, tone: "warning" },
            { key: "under-80", label: "60~79점", count: 6, percent: 33, tone: "neutral" },
            { key: "over-80", label: "80~100점", count: 6, percent: 33, tone: "success" },
        ],
        actions: [
            {
                key: "questions",
                title: "취약 문항 보기",
                detail: "문항 근거를 자세히 확인합니다.",
                href: "/teacher/retake?question=7",
            },
        ],
        hasPerformanceEvidence: true,
        ...overrides,
    };
}

describe("ExamAnalyticsReportOverview", () => {
    it("renders a fully ungraded question as neutral evidence without actions or percentages", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        render(<ExamAnalyticsTab exams={[exam]} attempts={attempts} currentPlan="free" />);

        expect(screen.getByRole("heading", { name: "채점 가능한 문항 근거가 더 필요합니다" })).toBeInTheDocument();
        expect(screen.queryByRole("heading", { name: /보강이 가장 효과적/ })).not.toBeInTheDocument();
        expect(screen.queryByText("보강 세트 만들기")).not.toBeInTheDocument();

        const metricsRegion = screen.getByRole("region", { name: "시험 핵심 지표" });
        expect(within(metricsRegion).getByText("평균").parentElement).toHaveTextContent("평균-");
        expect(within(metricsRegion).getByText("중앙값").parentElement).toHaveTextContent("중앙값-");
        expect(within(metricsRegion).getByText("최고").parentElement).toHaveTextContent("최고-");
        expect(within(metricsRegion).getByText("최저").parentElement).toHaveTextContent("최저-");
        expect(within(metricsRegion).getByText("채점 응시").parentElement).toHaveTextContent("채점 응시0명전체 제출 5건");
        expect(within(screen.getByRole("region", { name: "점수 분포" })).getByRole("status"))
            .toHaveTextContent("채점 가능한 점수 근거가 없습니다.");
        expect(within(screen.getByRole("region", { name: "성취 구간" })).getByRole("status"))
            .toHaveTextContent("채점 가능한 점수 근거가 없습니다.");

        fireEvent.click(screen.getByRole("tab", { name: "문항 분석" }));
        const row = screen.getByRole("row", { name: /1번.*시제/ });
        const cells = within(row).getAllByRole("cell");

        expect(cells[1]).toHaveTextContent("미채점");
        expect(cells[1]).not.toHaveTextContent("보강");
        expect(cells[2]).toHaveTextContent(/^-$|^근거 없음$/);
        expect(cells[4]).toHaveTextContent(/^-$|^근거 없음$/);
        expect(within(row).queryByText("0%")).not.toBeInTheDocument();
        expect(screen.getByText("문항별 상세 정답률 데이터: 1번 미채점.")).toBeInTheDocument();

        const chart = screen.getByRole("img", { name: "문항별 상세 정답률" });
        expect(chart.querySelector(".recharts-tooltip-wrapper")).not.toBeNull();
    });

    it("renders an active ungraded chart payload as a neutral tooltip", () => {
        const { container } = render(
            <QuestionCorrectRateTooltip
                active
                label={1}
                payload={[{ value: null }]}
            />,
        );

        expect(within(container).getByRole("status")).toHaveTextContent("1번 문항정답률: 미채점");
        expect(within(container).queryByText("0%")).not.toBeInTheDocument();

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain("filterNull={false}");
        expect(source).toContain("content={<QuestionCorrectRateTooltip />}");
    });

    it("keeps premium class aggregates and ungraded student rows neutral", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const mixedAttempts = attempts.map((attempt, index) => ({
            ...attempt,
            studentId: `student-${index + 1}`,
            groupId: "class-a",
            groupName: "A반",
            score: index === 0 ? 10 : 0,
            totalScore: index === 0 ? 10 : 0,
            questionResults: attempt.questionResults?.map(result => index === 0 ? {
                ...result,
                score: 10,
                earnedScore: 10,
                selectedAnswer: 2,
                status: "correct" as const,
                isCorrect: true,
            } : result),
        }));
        document.documentElement.dataset.motion = "off";
        render(<ExamAnalyticsTab exams={[exam]} attempts={mixedAttempts} currentPlan="pro" />);

        expect(screen.getByText("전체 제출 5건 중 채점 가능한 1명 기준입니다.")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("tab", { name: "학생·반" }));

        const classScoreRegion = screen.getByRole("heading", { name: "반별 점수 비교" }).closest<HTMLElement>(".card");
        expect(classScoreRegion).not.toBeNull();
        expect(within(classScoreRegion!).getByText("최저 100% · 중앙값 100% · 평균 100% · 최고 100% · 1명"))
            .toBeInTheDocument();

        const matrixRow = screen.getByRole("row", { name: /A반.*제출 5건/ });
        expect(matrixRow).toHaveTextContent("채점 1명");
        expect(matrixRow).toHaveTextContent("100%");

        const ungradedStudentRow = screen.getByRole("row", { name: /학생 2/ });
        expect(ungradedStudentRow).toHaveTextContent("미채점");
        expect(ungradedStudentRow).not.toHaveTextContent("0점");
        expect(ungradedStudentRow).not.toHaveTextContent("(0%)");
        expect(ungradedStudentRow).not.toHaveTextContent("정답률 0%");
    });

    it.each([
        ["partial" as const, "일부 제출 기준의 중간 결과입니다."],
        ["stale" as const, "최신 제출이 아직 반영되지 않았을 수 있습니다."],
    ])("keeps the %s qualifier persistent and links it to the metric section", (sampleStatus, copy) => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        render(
            <ExamAnalyticsTab
                exams={[exam]}
                attempts={attempts}
                currentPlan="free"
                sampleStatus={sampleStatus}
            />,
        );

        const contextRegion = screen.getByRole("region", { name: "시험별 통계" });
        const qualifier = within(contextRegion).getByText(copy);
        expect(qualifier).toHaveAttribute("id", "exam-analytics-sample-qualifier");
        expect(screen.getAllByText(copy)).toHaveLength(1);
        expect(screen.getByRole("region", { name: "시험 핵심 지표" })).toHaveAttribute(
            "aria-describedby",
            "exam-analytics-sample-qualifier",
        );

        for (const tabName of ["문항 분석", "학생·반", "운영", "요약"]) {
            fireEvent.click(screen.getByRole("tab", { name: tabName }));
            expect(within(contextRegion).getByText(copy)).toBeInTheDocument();
            expect(screen.getAllByText(copy)).toHaveLength(1);
        }
    });

    it("keeps graded question diagnostics and percentages unchanged", () => {
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        exam.questions[0] = { ...exam.questions[0], answer: 2 };
        const gradedAttempts = attempts.map(attempt => ({
            ...attempt,
            score: 10,
            totalScore: 10,
            answers: { 1: 2 },
            questionResults: attempt.questionResults?.map(result => ({
                ...result,
                score: 10,
                earnedScore: 10,
                selectedAnswer: 2,
                correctAnswer: 2,
                status: "correct" as const,
                isCorrect: true,
            })),
        }));
        render(<ExamAnalyticsTab exams={[exam]} attempts={gradedAttempts} currentPlan="free" />);

        fireEvent.click(screen.getByRole("tab", { name: "문항 분석" }));
        const row = screen.getByRole("row", { name: /1번.*시제/ });
        const cells = within(row).getAllByRole("cell");

        expect(cells[1]).toHaveTextContent("쉬움");
        expect(cells[2]).toHaveTextContent("100%");
        expect(cells[4]).toHaveTextContent("0%");
        expect(within(row).getAllByText("100%").length).toBeGreaterThanOrEqual(2);
    });

    it("excludes ungraded submissions without depressing mixed performance aggregates", () => {
        document.documentElement.setAttribute("data-motion", "off");
        const { exam, attempts } = buildUngradedExamAnalyticsFixture();
        const mixedAttempts = attempts.map((attempt, index) => index === 0 ? {
            ...attempt,
            score: 10,
            totalScore: 10,
        } : attempt);
        render(<ExamAnalyticsTab exams={[exam]} attempts={mixedAttempts} currentPlan="free" />);

        const metricsRegion = screen.getByRole("region", { name: "시험 핵심 지표" });
        expect(within(metricsRegion).getByText("평균").parentElement).toHaveTextContent("평균100점");
        expect(within(metricsRegion).getByText("최저").parentElement).toHaveTextContent("최저100점");
        expect(within(metricsRegion).getByText("채점 응시").parentElement).toHaveTextContent("채점 응시1명전체 제출 5건");
        expect(screen.getByRole("img", { name: "점수 구간별 응시 인원" })).toHaveAccessibleDescription(
            "90-100점 구간이 1명으로 가장 많습니다. 총 1명입니다.",
        );

        const achievementRegion = screen.getByRole("region", { name: "성취 구간" });
        expect(within(achievementRegion).getByText("40점 미만").closest("li")).toHaveTextContent("0명0%");
        expect(within(achievementRegion).getByText("80~100점").closest("li")).toHaveTextContent("1명100%");
    });

    it("renders the approved editorial report regions in exact reading order", () => {
        render(<ExamAnalyticsReportOverview {...buildProps()} />);

        const orderedRegions = [
            screen.getByRole("region", { name: "시험 핵심 지표" }),
            screen.getByRole("region", { name: "시험 핵심 해석" }),
            screen.getByRole("region", { name: "점수 분포" }),
            screen.getByRole("region", { name: "성취 구간" }),
            screen.getByRole("region", { name: "취약 문항" }),
            screen.getByRole("region", { name: "다음 행동" }),
        ];

        for (let index = 1; index < orderedRegions.length; index += 1) {
            expect(
                orderedRegions[index - 1].compareDocumentPosition(orderedRegions[index])
                & Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        }

        const headline = screen.getByRole("heading", {
            name: "‘이차함수’ 보강이 가장 효과적입니다",
        });
        expect(
            headline.compareDocumentPosition(screen.getByRole("region", { name: "점수 분포" }))
            & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
    });

    it("exposes score distribution and weak-question evidence as accessible tables", () => {
        render(<ExamAnalyticsReportOverview {...buildProps()} />);

        expect(screen.getByRole("img", { name: "점수 구간별 응시 인원" })).toHaveAccessibleDescription(
            "20-30점 구간이 4명으로 가장 많습니다. 총 9명입니다.",
        );
        expect(screen.getByRole("table", { name: "점수 분포 데이터" })).toBeInTheDocument();

        const weakTable = screen.getByRole("table", { name: "취약 문항 근거" });
        expect(weakTable).toContainElement(screen.getByRole("columnheader", { name: "문항" }));
        expect(weakTable).toContainElement(screen.getByRole("columnheader", { name: "정답률" }));
        expect(weakTable).toContainElement(screen.getByRole("columnheader", { name: "근거" }));
        expect(screen.getByRole("row", { name: /7번 이차함수 32%/ })).toBeInTheDocument();

        const gradeRate = screen.getByText("32%");
        expect(gradeRate.className).toContain("rateGrade");
    });

    it("links one external sample qualifier without duplicating its copy", () => {
        render(
            <>
                <p id="sample-note">일부 제출 기준의 중간 결과입니다.</p>
                <ExamAnalyticsReportOverview
                    {...buildProps({ sampleStatusDescriptionId: "sample-note" })}
                />
            </>,
        );

        expect(screen.getByRole("region", { name: "시험 핵심 지표" })).toHaveAttribute(
            "aria-describedby",
            "sample-note",
        );
        expect(screen.getAllByText("일부 제출 기준의 중간 결과입니다.")).toHaveLength(1);
    });

    it("preserves linked and callback actions", () => {
        const onAction = vi.fn();
        render(
            <ExamAnalyticsReportOverview
                {...buildProps({
                    actions: [
                        {
                            key: "retake",
                            title: "보강 세트 만들기",
                            detail: "취약 문항으로 재시험을 구성합니다.",
                            href: "/teacher/retake?question=7",
                        },
                        {
                            key: "students",
                            title: "지원 학생 보기",
                            detail: "60점 미만 학생을 확인합니다.",
                            onAction,
                        },
                    ],
                })}
            />,
        );

        expect(screen.getByRole("link", { name: /보강 세트 만들기/ })).toHaveAttribute(
            "href",
            "/teacher/retake?question=7",
        );
        fireEvent.click(screen.getByRole("button", { name: /지원 학생 보기/ }));
        expect(onAction).toHaveBeenCalledOnce();
    });
});

describe("exam overview wiring", () => {
    it("delegates only the overview workspace to the editorial report component", () => {
        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );

        expect(source).toMatch(/import ExamAnalyticsReportOverview,[\s\S]*?from "\.\/ExamAnalyticsReportOverview"/);
        expect(source).toContain("buildExamHeadlineInsight({");
        expect(source).toContain("<ExamAnalyticsReportOverview");
        expect(source).toContain('activeWorkspaceView === "questions"');
        expect(source).toContain('activeWorkspaceView === "students"');
        expect(source).toContain('activeWorkspaceView === "operations"');
    });

    it("hides the generic next-action strip only on the exam analytics tab", () => {
        const source = readFileSync(
            path.join(process.cwd(), "src/app/teacher/dashboard/page.tsx"),
            "utf8",
        );

        expect(source).toContain(
            '!isDashboardResolving && !isRealDashboardEmpty && !isMockupAccount && activeTab !== "overview" && activeTab !== "exam"',
        );
        expect(source).toContain("questionResultRepairPlan.repairableCount > 0");
    });

    it("threads loader completeness from the dashboard into the report sample note", () => {
        const dashboardSource = readFileSync(
            path.join(process.cwd(), "src/app/teacher/dashboard/page.tsx"),
            "utf8",
        );
        const tabSource = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );

        expect(dashboardSource).toContain("sampleStatus={detailedAttemptSampleStatus}");
        expect(tabSource).toContain("sampleStatus = \"ready\"");
        expect(tabSource).toContain("examAnalyticsSampleStatusNote(sampleStatus)");
        expect(tabSource).toContain("EXAM_ANALYTICS_SAMPLE_QUALIFIER_ID");
    });

    it("excludes zero-denominator questions from actionable evidence", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const filterGradableQuestionEvidence = (
            examAnalyticsModule as unknown as {
                filterGradableQuestionEvidence?: <T extends { totalCount: number }>(items: T[]) => T[];
            }
        ).filterGradableQuestionEvidence;
        const items = [
            { id: "ungraded", totalCount: 0 },
            { id: "graded", totalCount: 4 },
        ];

        expect(filterGradableQuestionEvidence).toBeTypeOf("function");
        expect(filterGradableQuestionEvidence?.(items)).toEqual([items[1]]);

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain("const gradableQuestionAnalytics = useMemo");
        expect(source).toContain("hasGradableEvidence: gradableQuestionAnalytics.length > 0");
        expect(source).not.toContain("questionAnalytics.slice(0, 5).map");
    });

    it("uses null chart values and a neutral label for questions without a denominator", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const buildQuestionCorrectRateChartData = (
            examAnalyticsModule as unknown as {
                buildQuestionCorrectRateChartData?: <T extends {
                    index: number;
                    totalCount: number;
                    correctRate: number;
                }>(items: T[]) => Array<T & { correctRate: number | null; correctRateLabel: string }>;
            }
        ).buildQuestionCorrectRateChartData;
        const input = [
            { index: 1, totalCount: 0, correctRate: 0 },
            { index: 2, totalCount: 5, correctRate: 60 },
        ];

        expect(buildQuestionCorrectRateChartData).toBeTypeOf("function");
        expect(buildQuestionCorrectRateChartData?.(input)).toEqual([
            { index: 1, totalCount: 0, correctRate: null, correctRateLabel: "미채점" },
            { index: 2, totalCount: 5, correctRate: 60, correctRateLabel: "60%" },
        ]);
    });

    it("uses the shared denominator policy for stored and computed scores", async () => {
        const { hasGradableAttemptScore } = await import("@/lib/premiumAnalytics");

        expect(hasGradableAttemptScore({ totalScore: 10, scorePercent: 0 })).toBe(true);
        expect(hasGradableAttemptScore({ totalScore: 0, scorePercent: 0 })).toBe(false);
        expect(hasGradableAttemptScore({ totalScore: Number.NaN, scorePercent: 80 })).toBe(false);
        expect(hasGradableAttemptScore({ totalScore: 10, scorePercent: Number.NaN })).toBe(false);
    });

    it("keeps the true risky-question total while capping the overview evidence list", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const summarizeRiskyQuestions = (
            examAnalyticsModule as unknown as {
                summarizeRiskyQuestions?: <T>(items: T[]) => {
                    displayQuestions: T[];
                    totalCount: number;
                };
            }
        ).summarizeRiskyQuestions;
        const riskyQuestions = Array.from({ length: 7 }, (_, index) => ({ id: index + 1 }));

        expect(summarizeRiskyQuestions).toBeTypeOf("function");
        expect(summarizeRiskyQuestions?.(riskyQuestions)).toEqual({
            displayQuestions: riskyQuestions.slice(0, 5),
            totalCount: 7,
        });

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain("riskyQuestionCount: teachingInsights?.riskyQuestionCount ?? 0");
    });

    it("uses the uncapped risky total in the question-quality action title", async () => {
        const examAnalyticsModule = await import("./ExamAnalyticsTab");
        const buildQuestionQualityActionTitle = (
            examAnalyticsModule as unknown as {
                buildQuestionQualityActionTitle?: (
                    riskyQuestionCount: number,
                    tooEasyCount: number,
                ) => string;
            }
        ).buildQuestionQualityActionTitle;

        expect(buildQuestionQualityActionTitle).toBeTypeOf("function");
        expect(buildQuestionQualityActionTitle?.(7, 2)).toBe("문항 품질 9개 점검");

        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );
        expect(source).toContain(
            "buildQuestionQualityActionTitle(teachingInsights.riskyQuestionCount, teachingInsights.tooEasyCount)",
        );
        expect(source).not.toContain(
            "teachingInsights.riskyQuestions.length + teachingInsights.tooEasyCount",
        );
    });

    it("uses the semantic warning text token for partial and stale sample notes", () => {
        const css = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.module.css"),
            "utf8",
        );
        const ruleStart = css.lastIndexOf(".reportSampleNote {");
        const sampleNoteRule = css.slice(ruleStart, css.indexOf("}", ruleStart));

        expect(sampleNoteRule).toContain("color: var(--text-warning)");
        expect(sampleNoteRule).not.toContain("color: var(--warning)");
    });
});
