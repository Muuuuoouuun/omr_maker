// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt, Exam } from "@/types/omr";
import type {
    StudentProfileHeadlineWeaknessEvidence,
    StudentProfileInsight,
    StudentProfileWeaknessInsight,
} from "@/lib/studentProfileAnalytics";
import type { StudentGrowthReportModel } from "@/lib/studentGrowthReport";
import type { StudentGrowthReportState } from "./StudentGrowthReport";

vi.mock("next/link", () => ({
    default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
        <a href={href} {...props}>{children}</a>
    ),
}));

vi.mock("./StudentGrowthReport", () => ({
    default: () => <section aria-label="개인 성장 그래프 테스트 대역" />,
}));

import ReportPanel from "./ReportPanel";

const attempt: Attempt = {
    id: "attempt-2",
    examId: "exam-2",
    examTitle: "2차 진단",
    studentName: "김학생",
    startedAt: "2026-08-08T00:00:00.000Z",
    finishedAt: "2026-08-08T00:30:00.000Z",
    score: 82,
    totalScore: 100,
    answers: {},
    status: "completed",
};

const exam: Exam = {
    id: "exam-2",
    title: "2차 진단",
    createdAt: "2026-08-01T00:00:00.000Z",
    questions: [],
};

const growthModel: StudentGrowthReportModel = {
    status: "ready",
    rows: [{
        examId: "exam-2",
        examTitle: "2차 진단",
        finishedAt: attempt.finishedAt,
        studentScore: 82,
        classAverage: 76,
        gap: 6,
        rank: 2,
        participantCount: 12,
        isLatest: true,
    }],
    latestScore: 82,
    averageGap: 6,
    currentRank: 2,
    currentPercentile: 17,
    rankDelta: 1,
    trend: "up",
    omittedCount: 0,
    selectedAttemptIncluded: true,
};

function weakness(partial: Partial<StudentProfileWeaknessInsight>): StudentProfileWeaknessInsight {
    return {
        key: partial.key || "weakness",
        examId: partial.examId || "exam-1",
        examTitle: partial.examTitle || "1차 진단",
        kind: "concept",
        title: partial.title || "시제",
        basis: "같은 개념",
        wrongCount: 2,
        unansweredCount: 0,
        totalCount: 3,
        wrongRate: 67,
        questionNumbers: [1, 2],
        recommendedQuestionIds: [1, 2],
        severity: "review",
        reason: "오답이 반복됨",
        sourceAttemptId: partial.sourceAttemptId || "attempt-1",
        retakeMode: "similar",
        retakeQuestionIds: [1, 2],
        retakeLabels: [],
        retakeConcepts: [partial.title || "시제"],
        recommendedAction: partial.recommendedAction || "같은 개념 2문항 재추천",
    };
}

function cumulativeInsight(overrides: Partial<StudentProfileInsight> = {}): StudentProfileInsight {
    const weaknesses = [
        weakness({ examId: "exam-2", sourceAttemptId: "attempt-2" }),
        weakness({ examId: "exam-1", sourceAttemptId: "attempt-1" }),
    ];
    const defaultHeadlineEvidence: StudentProfileHeadlineWeaknessEvidence[] = [{
        kind: "concept",
        title: "시제",
        examIds: ["exam-1", "exam-2"],
        wrongCount: 4,
        maxWrongRate: 67,
        recommendedAction: "같은 개념 2문항 재추천",
    }];
    const headlineWeaknessGroups = overrides.headlineWeaknessGroups
        ?? (overrides.weaknessGroups ? [] : defaultHeadlineEvidence);
    return {
        attempts: [],
        averageScore: 76,
        bestScore: 82,
        latestScore: 82,
        trendDelta: 7,
        averageElapsedTimeSec: 1_845,
        averageQuestionTimeSec: 62,
        totalTrackedTimeSec: 3_690,
        focusLossCount: 0,
        wrongQuestionCount: 4,
        unansweredQuestionCount: 0,
        handwritingArchiveCount: 0,
        baseAttemptCount: 2,
        retakeAttemptCount: 0,
        weaknessGroups: weaknesses,
        headlineWeaknessGroups,
        mostMissedQuestions: [],
        tagStats: [],
        ...overrides,
    };
}

function renderReport({
    insight = cumulativeInsight(),
    model = growthModel,
    status = "ready",
    enabled = true,
}: {
    insight?: StudentProfileInsight | null;
    model?: StudentGrowthReportModel;
    status?: StudentGrowthReportState["status"];
    enabled?: boolean;
} = {}) {
    const growthReportState: StudentGrowthReportState = status === "error"
        ? { status, message: "연결에 실패했습니다." }
        : status === "empty"
            ? { status, message: "표시할 성장 데이터가 없습니다." }
            : status === "idle" || status === "loading"
                ? { status }
                : { status, model };
    return render(
        <ReportPanel
            attempt={attempt}
            exam={exam}
            analytics={{
                score: { earnedScore: 82, totalScore: 100, scorePercent: 82, gradedQuestionCount: 10, ungradedQuestionCount: 0 },
                counts: { correctCount: 8, incorrectCount: 2, unansweredCount: 0, ungradedCount: 0 },
                wrongResults: [],
                weaknessGroups: [],
            }}
            selectedAttemptLabel="원시험"
            feedbackSummary=""
            retakeScoreDelta={null}
            cumulativeInsight={insight}
            growthReportState={growthReportState}
            studentGrowthReportsEnabled={enabled}
            pdfExportEnabled={false}
            onRetryCumulative={() => {}}
        />,
    );
}

afterEach(cleanup);

describe("ReportPanel", () => {
    it("labels a completely ungraded attempt without publishing a false zero-percent headline", () => {
        const ungradedAttempt = { ...attempt, score: 0, totalScore: 0 };
        render(
            <ReportPanel
                attempt={ungradedAttempt}
                exam={exam}
                analytics={{
                    score: { earnedScore: 0, totalScore: 0, scorePercent: 0, gradedQuestionCount: 0, ungradedQuestionCount: 10 },
                    counts: { correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 10 },
                    wrongResults: [],
                    weaknessGroups: [],
                }}
                selectedAttemptLabel="원시험"
                feedbackSummary=""
                retakeScoreDelta={null}
                cumulativeInsight={null}
                growthReportState={{ status: "empty", message: "표시할 성장 데이터가 없습니다." }}
                studentGrowthReportsEnabled
                pdfExportEnabled={false}
                onRetryCumulative={() => {}}
            />,
        );

        const scoreSection = screen.getByRole("region", { name: "점수와 답안 현황" });
        expect(scoreSection).toHaveTextContent("미채점");
        expect(scoreSection).toHaveTextContent("비교 불가");
        expect(scoreSection).not.toHaveTextContent("0%");
        expect(screen.getByRole("region", { name: "핵심 해석" })).not.toHaveTextContent("0%를 기록");
        const weaknessSection = screen.getByRole("region", { name: "주요 오답과 약점" });
        expect(weaknessSection).toHaveTextContent("근거 없음");
        expect(weaknessSection).toHaveTextContent("미채점");
        expect(weaknessSection).not.toHaveTextContent("뚜렷한 약점 없음");
    });

    it("renders all five personal report signals together with the cumulative headline", () => {
        renderReport();
        const signals = screen.getByRole("group", { name: "개인 리포트 핵심 지표" });

        for (const [label, value] of [
            ["최근 점수", "82점"],
            ["반 백분위", "상위 17%"],
            ["성장 추세", "상승"],
            ["반복 약점", "시제 · 2회 반복"],
            ["평균 풀이 시간", "30분 45초"],
        ]) {
            const term = within(signals).getByText(label);
            expect(term.closest("div")).toHaveTextContent(value);
        }
        expect(screen.getByText(/‘시제’ 약점이 2개 시험에 반복/)).toHaveTextContent("추천 학습 순서");
        expect(screen.getByText(/‘시제’ 약점이 2개 시험에 반복/)).toHaveTextContent("후 관련 오답 재풀이");
        expect(screen.getByRole("region", { name: "핵심 해석" })).not.toHaveTextContent("일부 제출 기준");
        expect(signals).not.toHaveTextContent("저장된 데이터 기준");
    });

    it.each([
        ["partial", "일부 제출 기준"],
        ["stale", "저장된 데이터 기준"],
    ] as const)("qualifies the top headline and KPI group when growth data is %s", (status, qualifier) => {
        renderReport({ status });

        expect(screen.getByRole("region", { name: "핵심 해석" })).toHaveTextContent(qualifier);
        expect(screen.getByRole("group", { name: "개인 리포트 핵심 지표" })).toHaveTextContent(qualifier);
    });

    it("states unavailable and zero-duration signals truthfully", () => {
        const unavailableModel = { ...growthModel, latestScore: null, currentPercentile: null, trend: "insufficient" as const };
        renderReport({
            insight: cumulativeInsight({ averageElapsedTimeSec: 0, weaknessGroups: [] }),
            model: unavailableModel,
        });
        const signals = screen.getByRole("group", { name: "개인 리포트 핵심 지표" });

        expect(within(signals).getByText("최근 점수").closest("div")).toHaveTextContent("기록 없음");
        expect(within(signals).getByText("반 백분위").closest("div")).toHaveTextContent("비교 불가");
        expect(within(signals).getByText("성장 추세").closest("div")).toHaveTextContent("비교 자료 부족");
        expect(within(signals).getByText("반복 약점").closest("div")).toHaveTextContent("뚜렷한 반복 없음");
        expect(within(signals).getByText("평균 풀이 시간").closest("div")).toHaveTextContent("기록 없음");
        expect(screen.getByText("82%를 기록했고, 현재 시험에서 확인된 오답·미응답이 없습니다.")).toBeInTheDocument();
    });

    it("keeps ungraded cumulative activity visible without rendering null as a score", () => {
        renderReport({
            insight: cumulativeInsight({
                averageScore: null,
                bestScore: null,
                latestScore: null,
                trendDelta: null,
                attempts: [{
                    id: "ungraded-history",
                    examId: "exam-ungraded",
                    examTitle: "미채점 서술형",
                    finishedAt: "2026-08-07T00:30:00.000Z",
                    scorePercent: null,
                    elapsedTimeSec: 1_800,
                    totalTrackedTimeSec: 1_800,
                    averageQuestionTimeSec: 60,
                    wrongQuestionNumbers: [],
                    unansweredQuestionNumbers: [],
                    slowQuestionNumbers: [],
                    revisitedQuestionNumbers: [],
                    answerChangedQuestionNumbers: [],
                    focusLossCount: 1,
                    handwritingArchived: true,
                    handwritingLabel: "1쪽",
                    detailHref: "/teacher/attempt/ungraded-history",
                    isRetake: false,
                    retakeQuestionCount: 0,
                }],
            }),
        });

        const history = screen.getByRole("region", { name: "상세 응시 이력" });
        expect(history).toHaveTextContent("평균확인 불가");
        expect(history).toHaveTextContent("최고확인 불가");
        expect(history).toHaveTextContent("미채점 서술형");
        expect(history).toHaveTextContent("미채점");
        expect(history).not.toHaveTextContent("null%");
    });

    it("does not leak cumulative weakness or elapsed time when growth reports are locked", () => {
        renderReport({ enabled: false, status: "stale" });
        const headline = screen.getByRole("region", { name: "핵심 해석" });
        const signals = screen.getByRole("group", { name: "개인 리포트 핵심 지표" });

        expect(headline).toHaveTextContent("82%를 기록했고, 현재 시험에서 확인된 오답·미응답이 없습니다.");
        expect(headline).not.toHaveTextContent("시제");
        expect(headline).not.toHaveTextContent("재추천");
        expect(headline).not.toHaveTextContent("저장된 데이터 기준");
        expect(signals).not.toHaveTextContent("저장된 데이터 기준");
        expect(within(signals).getByText("반복 약점").closest("div")).toHaveTextContent("뚜렷한 반복 없음");
        expect(within(signals).getByText("평균 풀이 시간").closest("div")).toHaveTextContent("확인 불가");
        expect(screen.queryByText("반복 약점과 추천")).not.toBeInTheDocument();
    });

    it.each(["idle", "loading", "error", "empty"] as const)(
        "ignores retained cumulative insight while growth data is %s",
        status => {
            renderReport({ status });
            const headline = screen.getByRole("region", { name: "핵심 해석" });
            const signals = screen.getByRole("group", { name: "개인 리포트 핵심 지표" });

            expect(headline).toHaveTextContent("82%를 기록했고, 현재 시험에서 확인된 오답·미응답이 없습니다.");
            expect(headline).not.toHaveTextContent("시제");
            expect(within(signals).getByText("최근 점수").closest("div")).toHaveTextContent("확인 불가");
            expect(within(signals).getByText("반복 약점").closest("div")).toHaveTextContent("뚜렷한 반복 없음");
            expect(within(signals).getByText("평균 풀이 시간").closest("div")).toHaveTextContent("확인 불가");
            expect(screen.queryByText("반복 약점과 추천")).not.toBeInTheDocument();
        },
    );
});
