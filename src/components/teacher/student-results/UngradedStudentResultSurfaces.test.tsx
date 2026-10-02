// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/types/omr";

vi.mock("next/link", () => ({
    default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
        <a href={href} {...props}>{children}</a>
    ),
}));

vi.mock("next/navigation", () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

import AnswersPanel from "./AnswersPanel";
import StudentResultHeader from "./StudentResultHeader";

const ungradedAttempt: Attempt = {
    id: "ungraded-attempt",
    examId: "exam-1",
    examTitle: "서술형 진단",
    studentName: "김학생",
    startedAt: "2026-08-08T00:00:00.000Z",
    finishedAt: "2026-08-08T00:30:00.000Z",
    score: 0,
    totalScore: 0,
    answers: {},
    status: "completed",
};

afterEach(cleanup);

describe("ungraded student result surfaces", () => {
    it("uses the canonical series score in the header for a legacy stored zero-over-zero attempt", () => {
        render(
            <StudentResultHeader
                attempt={ungradedAttempt}
                series={[{
                    attempt: ungradedAttempt,
                    kind: "original",
                    ordinal: 1,
                    scorePercent: 100,
                    scoreDelta: null,
                    scoreSummary: { earnedScore: 10, totalScore: 10, scorePercent: 100, source: "canonical_submission", gradedQuestionCount: 1, ungradedQuestionCount: 0 },
                    comparisonScore: { totalScore: 10, scorePercent: 100 },
                }]}
                activeView="answers"
            />,
        );

        expect(screen.getByLabelText("점수 100점")).toHaveTextContent("100점");
        expect(screen.queryByText("미채점")).not.toBeInTheDocument();
    });

    it("labels the result header as ungraded instead of zero points", () => {
        render(
            <StudentResultHeader
                attempt={ungradedAttempt}
                series={[{
                    attempt: ungradedAttempt,
                    kind: "original",
                    ordinal: 1,
                    scorePercent: null,
                    scoreDelta: null,
                    scoreSummary: { earnedScore: 0, totalScore: 0, scorePercent: 0, source: "canonical_submission", gradedQuestionCount: 0, ungradedQuestionCount: 1 },
                    comparisonScore: { totalScore: 0, scorePercent: 0 },
                }]}
                activeView="answers"
            />,
        );

        expect(screen.getByLabelText("점수 미채점")).toHaveTextContent("미채점");
        expect(screen.queryByText("0점")).not.toBeInTheDocument();
    });

    it("labels the answer summary as ungraded instead of zero percent", () => {
        render(
            <AnswersPanel
                attempt={ungradedAttempt}
                questionResults={[]}
                counts={{ correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 1 }}
                score={{ earnedScore: 0, totalScore: 0, scorePercent: 0, gradedQuestionCount: 0, ungradedQuestionCount: 1 }}
                subQuestionFilter="needs_review"
                onSubQuestionFilterChange={() => {}}
                onReviewSubQuestion={async () => {}}
                savingSubQuestionKey={null}
                answerDrafts={{}}
                onAnswerDraftChange={() => {}}
                onAnswerStudentQuestion={async () => {}}
                savingQuestionId={null}
            />,
        );

        const summary = screen.getByRole("region", { name: "제출 채점 요약" });
        expect(summary).toHaveTextContent("미채점");
        expect(summary).not.toHaveTextContent("0%");
        expect(summary).not.toHaveTextContent("0 / 0점");
    });

    it("labels current-exam derivation as legacy compatibility evidence", () => {
        render(
            <AnswersPanel
                attempt={ungradedAttempt}
                gradingSource="legacy_derived_current_exam"
                questionResults={[]}
                counts={{ correctCount: 1, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 }}
                score={{ earnedScore: 10, totalScore: 10, scorePercent: 100, gradedQuestionCount: 1, ungradedQuestionCount: 0 }}
                subQuestionFilter="needs_review"
                onSubQuestionFilterChange={() => {}}
                onReviewSubQuestion={async () => {}}
                savingSubQuestionKey={null}
                answerDrafts={{}}
                onAnswerDraftChange={() => {}}
                onAnswerStudentQuestion={async () => {}}
                savingQuestionId={null}
            />,
        );

        const summary = screen.getByRole("region", { name: "제출 채점 요약" });
        const notice = screen.getByRole("note", { name: "채점 근거 안내" });
        expect(summary).toHaveTextContent("100%");
        expect(notice).toHaveTextContent("과거 기록 · 현재 시험지 기준 참고 채점");
        expect(notice).toHaveTextContent("문항별 제출 채점 결과가 저장되기 전 기록으로, 현재 시험지에서 산출한 참고값입니다.");
        expect(summary).not.toHaveTextContent("재채점됨");
    });

    it.each([
        ["stored_totals_only", "문항별 채점 근거 불완전", "문항별 결과 없이 제출 당시 저장된 총점만 표시합니다."],
        ["incomplete_or_invalid", "채점 근거 확인 필요", "불완전한 문항 결과는 현재 시험지와 섞지 않고 미채점으로 표시합니다."],
    ] as const)("shows visible grading evidence for %s", (gradingSource, label, detail) => {
        render(
            <AnswersPanel
                attempt={ungradedAttempt}
                gradingSource={gradingSource}
                questionResults={[]}
                counts={{ correctCount: 0, incorrectCount: 0, unansweredCount: 0, ungradedCount: 1 }}
                score={{ earnedScore: 0, totalScore: 0, scorePercent: 0, gradedQuestionCount: 0, ungradedQuestionCount: 1 }}
                subQuestionFilter="needs_review"
                onSubQuestionFilterChange={() => {}}
                onReviewSubQuestion={async () => {}}
                savingSubQuestionKey={null}
                answerDrafts={{}}
                onAnswerDraftChange={() => {}}
                onAnswerStudentQuestion={async () => {}}
                savingQuestionId={null}
            />,
        );

        const notice = screen.getByRole("note", { name: "채점 근거 안내" });
        expect(notice).toHaveTextContent(label);
        expect(notice).toHaveTextContent(detail);
    });

    it("does not advertise automatic regrading for canonical submission rows", () => {
        render(
            <AnswersPanel
                attempt={{ ...ungradedAttempt, score: 10, totalScore: 10 }}
                gradingSource="canonical_submission"
                questionResults={[]}
                counts={{ correctCount: 1, incorrectCount: 0, unansweredCount: 0, ungradedCount: 0 }}
                score={{ earnedScore: 10, totalScore: 10, scorePercent: 100, gradedQuestionCount: 1, ungradedQuestionCount: 0 }}
                subQuestionFilter="needs_review"
                onSubQuestionFilterChange={() => {}}
                onReviewSubQuestion={async () => {}}
                savingSubQuestionKey={null}
                answerDrafts={{}}
                onAnswerDraftChange={() => {}}
                onAnswerStudentQuestion={async () => {}}
                savingQuestionId={null}
            />,
        );

        const summary = screen.getByRole("region", { name: "제출 채점 요약" });
        expect(summary).toHaveTextContent("100%");
        expect(screen.queryByRole("note", { name: "채점 근거 안내" })).not.toBeInTheDocument();
        expect(summary).not.toHaveTextContent("현재 정답 기준 재채점됨");
        expect(summary).not.toHaveTextContent("과거 기록");
    });
});
