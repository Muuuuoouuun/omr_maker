// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import type { QuestionResult } from "@/types/omr";
import AnswersPanel from "./AnswersPanel";

afterEach(cleanup);
const results: QuestionResult[] = [1, 2].map(number => ({
    schemaVersion: 1, attemptId: "attempt", examId: "exam", examTitle: "시험", studentName: "학생",
    finishedAt: "2026-09-22", questionId: number + 10, questionNumber: number,
    score: 1, earnedScore: number === 1 ? 1 : 0, selectedAnswer: number, correctAnswer: 1,
    status: number === 1 ? "correct" : "wrong", isCorrect: number === 1, isWrong: number === 2, isUnanswered: false,
}));
const baseProps: ComponentProps<typeof AnswersPanel> = {
    attempt: { id: "attempt", examId: "exam", examTitle: "시험", studentName: "학생", startedAt: "2026-09-22", finishedAt: "2026-09-22", score: 1, totalScore: 2, answers: {}, status: "completed" },
    questionResults: results, counts: { correctCount: 1, incorrectCount: 1, unansweredCount: 0, ungradedCount: 0 },
    subQuestionFilter: "all", onSubQuestionFilterChange: () => {}, onReviewSubQuestion: async () => {}, savingSubQuestionKey: null,
    answerDrafts: {}, onAnswerDraftChange: () => {}, onAnswerStudentQuestion: async () => {}, savingQuestionId: null,
};

describe("AnswersPanel question deep links", () => {
    it("focuses the actual numbered result and follows query changes", () => {
        const { rerender } = render(<AnswersPanel {...baseProps} requestedQuestionNumber={2} />);
        expect(screen.getByRole("article", { name: "2번 문항 · 선택한 분석 근거" })).toHaveFocus();
        rerender(<AnswersPanel {...baseProps} requestedQuestionNumber={1} />);
        expect(screen.getByRole("article", { name: "1번 문항 · 선택한 분석 근거" })).toHaveFocus();
        expect(screen.getByRole("article", { name: "2번 문항" })).not.toHaveAttribute("tabindex");
    });

    it("keeps a selected correct answer reachable when the wrong-answer filter is active", () => {
        render(<AnswersPanel {...baseProps} requestedQuestionNumber={1} />);
        fireEvent.click(screen.getByRole("button", { name: "오답/미응답 1" }));
        expect(screen.getByRole("article", { name: "1번 문항 · 선택한 분석 근거" })).toBeInTheDocument();
        expect(screen.getByRole("status")).toHaveTextContent("선택한 문항은 필터와 함께 표시합니다.");
    });

    it("waits for asynchronously loaded results before focusing", () => {
        const { rerender } = render(<AnswersPanel {...baseProps} questionResults={[]} questionResultsLoading requestedQuestionNumber={2} />);
        expect(screen.getByRole("status")).toHaveTextContent("불러오는 중");
        rerender(<AnswersPanel {...baseProps} requestedQuestionNumber={2} />);
        expect(screen.getByRole("article", { name: "2번 문항 · 선택한 분석 근거" })).toHaveFocus();
    });

    it("explains missing or ambiguous question records without targeting another answer", () => {
        const { rerender } = render(<AnswersPanel {...baseProps} requestedQuestionNumber={11} />);
        expect(screen.getByRole("status")).toHaveTextContent("11번 문항 기록을 확인할 수 없습니다.");
        expect(screen.queryByRole("article", { name: /선택한 분석 근거/ })).not.toBeInTheDocument();
        rerender(<AnswersPanel {...baseProps} questionResults={[...results, { ...results[0], questionId: 99 }]} requestedQuestionNumber={1} />);
        expect(screen.getByRole("status")).toHaveTextContent("1번 문항 기록을 확인할 수 없습니다.");
        expect(screen.queryByRole("article", { name: /선택한 분석 근거/ })).not.toBeInTheDocument();
    });
});
