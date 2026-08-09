// @vitest-environment jsdom
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("@/lib/retakeRecovery", () => ({ buildAttemptRetakeRecovery: () => null, buildSourceAttemptRecovery: () => null }));
vi.mock("@/components/Toast", () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock("@/components/ThemeToggle", () => ({ default: () => null }));
vi.mock("@/components/dashboard/CountUp", () => ({ default: ({ value }: { value: number }) => <>{value}</> }));
vi.mock("@/components/student/HandwritingUploadRecoveryCard", () => ({ default: () => null }));

import ReviewPage from "./page";

describe("official student review page", () => {
    beforeEach(() => {
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
});
