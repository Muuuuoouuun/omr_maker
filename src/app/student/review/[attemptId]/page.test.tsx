// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const detailMock = vi.hoisted(() => vi.fn());
const routerMock = vi.hoisted(() => ({ back: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
    useParams: () => ({ attemptId: "attempt-1" }),
    useRouter: () => routerMock,
}));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
vi.mock("next/dynamic", () => ({ default: () => () => <div data-testid="pdf-viewer" /> }));
vi.mock("@/lib/studentAttemptClient", () => ({ loadStudentOfficialAttempt: detailMock }));
vi.mock("@/utils/storage", () => ({
    getSession: () => ({ studentId: "student-1", studentName: "학생", identityType: "registered", isGuest: false }),
    attemptBelongsToSession: () => true,
}));
vi.mock("@/lib/omrPersistence", () => ({
    readLocalAttempts: () => [], saveLocalAttempt: async () => true, saveLocalServerConfirmedAttempt: async () => true,
}));
vi.mock("@/lib/studentAttemptReceipt", () => ({
    SUBMISSION_RECEIPT_RECONCILED_EVENT: "omr:submission-receipt-reconciled",
    isSubmissionReceiptStorageKey: () => false,
    persistSubmissionReceipt: async () => undefined,
    readReconciledSubmissionAttemptId: () => null,
    readSubmissionReceipt: () => null,
    retryPendingSubmissionReceipt: vi.fn(),
    submissionReceiptForAttempt: () => ({ attemptId: "attempt-1", status: "confirmed", updatedAt: "2026-08-10T00:00:00.000Z" }),
    submissionReceiptLabel: () => "서버 반영 확인",
}));
vi.mock("@/lib/studentQuestionOutbox", () => ({
    flushPendingStudentQuestions: vi.fn(), pendingStudentQuestionNotesById: () => ({}), queuePendingStudentQuestion: vi.fn(), readPendingStudentQuestions: () => [],
}));
vi.mock("@/lib/studentQuestions", () => ({ studentQuestionsByQuestionId: () => ({}), upsertStudentQuestion: vi.fn() }));
vi.mock("@/app/actions/studentExam", () => ({ askAttemptQuestion: vi.fn(), loadMyAttemptHandwriting: vi.fn(), submitAttempt: vi.fn() }));
vi.mock("@/lib/studentFeedbackClient", () => ({ loadStudentReturnedFeedbackForAttempt: async () => null, markStudentFeedbackOpened: vi.fn() }));
vi.mock("@/lib/feedbackPersistence", () => ({
    buildFeedbackDownloadText: vi.fn(), buildFeedbackMarkupDownloadJson: vi.fn(), canDownloadReturnedFeedback: () => false,
    canDownloadReturnedMarkup: () => false, loadFeedbackMarkupDrawings: vi.fn(), mergePdfDrawings: (a: unknown) => a,
}));
vi.mock("@/utils/blobStore", () => ({ loadJsonRecord: vi.fn(), storedDataUrlToFile: async () => null }));
vi.mock("@/lib/studentRemoteHandwritingClient", () => ({ downloadRemoteStudentHandwriting: vi.fn() }));
const retakeRecoveryMock = vi.hoisted(() => vi.fn((): unknown => null));
vi.mock("@/lib/retakeRecovery", () => ({ buildAttemptRetakeRecovery: retakeRecoveryMock, buildSourceAttemptRecovery: () => null }));
vi.mock("@/components/Toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/components/dashboard/CountUp", () => ({ default: ({ value }: { value: number }) => <>{value}</> }));
vi.mock("@/components/student/HandwritingUploadRecoveryCard", () => ({ default: () => null }));

import ReviewPage from "./page";

type ReviewQuestionFixture = { id: number; selected: number | null; answer: number };

function trustedDetail(questions: ReviewQuestionFixture[], attemptExtras: Record<string, unknown> = {}) {
    const results = questions.map(question => {
        const status = question.selected === null
            ? "unanswered"
            : question.selected === question.answer ? "correct" : "wrong";
        return {
            questionId: question.id, questionNumber: question.id, selectedAnswer: question.selected ?? undefined,
            correctAnswer: question.answer, score: 5, earnedScore: status === "correct" ? 5 : 0, status,
        };
    });
    const earned = results.reduce((sum, result) => sum + result.earnedScore, 0);
    const total = questions.length * 5;
    return {
        source: "server",
        attempt: {
            id: "attempt-1", examId: "exam-1", examTitle: "공식 시험", studentId: "student-1", studentName: "학생",
            identityType: "registered", startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:10:00.000Z",
            score: earned, totalScore: total, answers: {}, status: "completed", questionResults: [],
            ...attemptExtras,
        },
        exam: { id: "exam-1", title: "공식 시험", createdAt: "2026-08-10T00:00:00.000Z", questions: [] },
        retakeEligibleQuestionIds: [],
        trustedReview: {
            gradingSource: "canonical_submission",
            questions: questions.map(question => ({ id: question.id, number: question.id, choices: 4, score: 5, answer: question.answer })),
            questionResults: results,
            scoreSummary: { earnedScore: earned, totalScore: total, scorePercent: Math.round((earned / total) * 100), gradedQuestionCount: questions.length, ungradedQuestionCount: 0 },
            weaknessGroups: [], recommendations: [],
            behavior: {
                elapsedTimeSec: 600, totalTrackedTimeSec: 0, averageTimeSec: 0, slowQuestionNumbers: [], rushedQuestionNumbers: [],
                revisitedQuestionNumbers: [], answerChangedQuestionNumbers: [], focusLossCount: 0, focusLossQuestionNumbers: [],
            },
        },
    };
}

const questionTabs = () => within(screen.getByRole("tablist", { name: "문항 바로가기" })).getAllByRole("tab");

describe("official student review page", () => {
    afterEach(() => cleanup());

    beforeEach(() => {
        retakeRecoveryMock.mockReset();
        retakeRecoveryMock.mockReturnValue(null);
        detailMock.mockReset();
        detailMock.mockResolvedValue({
            source: "server",
            attempt: {
                id: "attempt-1", examId: "exam-1", examTitle: "공식 시험", studentId: "student-1", studentName: "학생",
                identityType: "registered", startedAt: "2026-08-10T00:00:00.000Z", finishedAt: "2026-08-10T00:10:00.000Z",
                score: 5, totalScore: 5, answers: { 1: 2 }, status: "completed", questionResults: [],
            },
            exam: { id: "exam-1", title: "공식 시험", createdAt: "2026-08-10T00:00:00.000Z", questions: [] },
            retakeEligibleQuestionIds: [],
            trustedReview: {
                gradingSource: "canonical_submission",
                questions: [{ id: 1, number: 1, choices: 4, score: 5, answer: 2, explanation: "서버 검증 해설" }],
                questionResults: [{ questionId: 1, questionNumber: 1, selectedAnswer: 2, correctAnswer: 2, score: 5, earnedScore: 5, status: "correct" }],
                scoreSummary: { earnedScore: 5, totalScore: 5, scorePercent: 100, gradedQuestionCount: 1, ungradedQuestionCount: 0 },
                weaknessGroups: [], recommendations: [],
                behavior: {
                    elapsedTimeSec: 600, totalTrackedTimeSec: 0, averageTimeSec: 0, slowQuestionNumbers: [], rushedQuestionNumbers: [],
                    revisitedQuestionNumbers: [], answerChangedQuestionNumbers: [], focusLossCount: 0, focusLossQuestionNumbers: [],
                },
            },
        });
    });

    it("renders the authenticated safe DTO questions/results/explanation without digest fields", async () => {
        render(<ReviewPage />);
        await waitFor(() => expect(screen.getByText("문항 1")).toBeTruthy());
        expect(screen.getAllByText("2번").length).toBeGreaterThan(0);
        fireEvent.click(screen.getByRole("button", { name: /해설/ }));
        expect(screen.getByText("서버 검증 해설")).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/questionResults(?:DefinitionManifest|FullEvidence)Hash/);
    });

    it("opens on the first wrong or unanswered question and labels the filter to match the summary", async () => {
        detailMock.mockResolvedValue(trustedDetail([
            { id: 1, selected: 2, answer: 2 },
            { id: 2, selected: 3, answer: 1 },
            { id: 3, selected: null, answer: 4 },
        ]));
        render(<ReviewPage />);
        await waitFor(() => expect(questionTabs()).toHaveLength(3));
        const tabs = questionTabs();
        expect(tabs[0].getAttribute("aria-selected")).toBe("false");
        expect(tabs[1].getAttribute("aria-selected")).toBe("true");
        expect(screen.getByRole("button", { name: "오답·미응답 2" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: /^오답 \d/ })).toBeNull();
        fireEvent.click(screen.getByRole("button", { name: "다음 오답 →" }));
        expect(questionTabs()[2].getAttribute("aria-selected")).toBe("true");
        expect(screen.queryByText("모두 맞혔어요")).toBeNull();
    });

    it("replaces the next-wrong jump with a success pill on a perfect score", async () => {
        detailMock.mockResolvedValue(trustedDetail([
            { id: 1, selected: 2, answer: 2 },
            { id: 2, selected: 1, answer: 1 },
        ]));
        render(<ReviewPage />);
        await waitFor(() => expect(questionTabs()).toHaveLength(2));
        expect(questionTabs()[0].getAttribute("aria-selected")).toBe("true");
        expect(screen.getByRole("button", { name: "오답·미응답 0" })).toBeTruthy();
        expect(screen.queryByRole("button", { name: "다음 오답 →" })).toBeNull();
        expect(screen.getByText("모두 맞혔어요")).toBeTruthy();
    });

    it("reports a retake as re-answered questions, not a celebrated recovery", async () => {
        retakeRecoveryMock.mockReturnValue({
            targetCount: 2, recoveredCount: 1, regressedCount: 0, recoveryRate: 50,
            recoveredQuestionIds: [1], unrecoveredQuestionIds: [2], regressedQuestionIds: [],
        });
        detailMock.mockResolvedValue(trustedDetail([
            { id: 1, selected: 2, answer: 2 },
            { id: 2, selected: 3, answer: 1 },
        ], {
            retake: { sourceAttemptId: "attempt-0", questionIds: [1, 2], mode: "wrong", sourceScore: 0, sourceTotalScore: 10 },
        }));
        render(<ReviewPage />);
        await waitFor(() => expect(screen.getByText("재시험 결과")).toBeTruthy());
        expect(screen.getByText("원시험에서 틀린 2문항 중 1문항을 다시 풀어 맞혔어요.")).toBeTruthy();
        expect(screen.getByText("같은 문제를 해설을 본 뒤 다시 맞힌 결과예요. 실력이 늘었는지는 비슷한 유형의 새 문제로 확인해보세요.")).toBeTruthy();
        expect(screen.getByText("다시 맞힘")).toBeTruthy();
        expect(screen.getByText("재시험 범위 점수")).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/회복 성공|🚀|재시험 회복/);
    });
});
