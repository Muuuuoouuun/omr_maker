// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import ExamAnalyticsReportOverview, {
    type ExamAnalyticsReportOverviewProps,
} from "./ExamAnalyticsReportOverview";

afterEach(cleanup);

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
        sampleStatus: "ready",
        ...overrides,
    };
}

describe("ExamAnalyticsReportOverview", () => {
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

    it("shows concise sample notes for partial and stale data only", () => {
        const { rerender } = render(
            <ExamAnalyticsReportOverview {...buildProps({ sampleStatus: "partial" })} />,
        );

        expect(screen.getByText("일부 제출만 반영된 중간 결과입니다.")).toBeInTheDocument();

        rerender(<ExamAnalyticsReportOverview {...buildProps({ sampleStatus: "stale" })} />);
        expect(screen.getByText("최신 제출이 아직 반영되지 않았을 수 있습니다.")).toBeInTheDocument();

        rerender(<ExamAnalyticsReportOverview {...buildProps({ sampleStatus: "ready" })} />);
        expect(screen.queryByText("일부 제출만 반영된 중간 결과입니다.")).not.toBeInTheDocument();
        expect(screen.queryByText("최신 제출이 아직 반영되지 않았을 수 있습니다.")).not.toBeInTheDocument();
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

    it("uses a ready sample status when the tab has no completeness or freshness metadata", () => {
        const source = readFileSync(
            path.join(process.cwd(), "src/components/dashboard/tabs/ExamAnalyticsTab.tsx"),
            "utf8",
        );

        expect(source).toContain('sampleStatus="ready"');
        expect(source).not.toContain('sampleStatus={examStats.count < 5 ? "partial" : "ready"}');
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
