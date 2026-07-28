import { afterEach, describe, expect, it, vi } from "vitest";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";
import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { Attempt, Exam } from "@/types/omr";
import {
    localResultCacheFromServerReceipt,
    pendingSubmissionReceiptIds,
    persistSubmissionReceipt,
    queuePendingSubmissionReceipt,
    readSubmissionReceipt,
    retryPendingSubmissionReceipt,
    submissionReceiptLabel,
} from "./studentAttemptReceipt";

function createStorage(initial: Record<string, string> = {}): Storage {
    const data = new Map(Object.entries(initial));
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) { data.set(key, value); },
    } as Storage;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

const receipt: ServerGradedAttemptReceipt = {
    attemptId: "attempt-ticket-1",
    examId: "exam-1",
    score: 5,
    totalScore: 10,
    correctCount: 1,
    incorrectCount: 1,
    unansweredCount: 0,
    ungradedCount: 0,
    finishedAt: "2026-07-14T01:00:00.000Z",
    questionResults: [
        { questionId: 1, questionNumber: 1, selectedAnswer: 3, score: 5, earnedScore: 5, status: "correct" },
        { questionId: 2, questionNumber: 2, selectedAnswer: 2, score: 5, earnedScore: 0, status: "wrong" },
    ],
};

describe("student attempt receipt cache", () => {
    it("uses the exact authoritative persistence labels", () => {
        expect(submissionReceiptLabel({ status: "confirmed" })).toBe("서버 반영 완료");
        expect(submissionReceiptLabel({ status: "pending" })).toBe("서버 반영 대기 · 자동 재시도");
        expect(submissionReceiptLabel({ status: "local_only" })).toBe("이 기기에만 저장됨");
    });

    it("persists the authoritative status independently of navigation and reload", () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });

        persistSubmissionReceipt({
            attemptId: "attempt-local-1",
            status: "local_only",
            updatedAt: "2026-07-28T00:00:00.000Z",
        });

        expect(readSubmissionReceipt("attempt-local-1")).toEqual({
            attemptId: "attempt-local-1",
            status: "local_only",
            updatedAt: "2026-07-28T00:00:00.000Z",
        });
    });

    it("keeps a failed idempotent retry pending with honest feedback", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        }, "2026-07-28T00:01:00.000Z");

        const result = await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async () => ({ status: "error" }),
        });

        expect(result).toEqual({
            status: "pending",
            error: "서버에 아직 반영하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.",
        });
        expect(readSubmissionReceipt("attempt-local-1")?.status).toBe("pending");
        expect(pendingSubmissionReceiptIds()).toEqual(["attempt-local-1"]);
    });

    it("confirms and cleans up only after the intended server request succeeds", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        }, "2026-07-28T00:01:00.000Z");

        const authoritativeAttempt: Attempt = {
            id: "attempt-server-1",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "학생",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:02:00.000Z",
            score: 10,
            totalScore: 10,
            answers: { 1: 2 },
            status: "completed",
        };
        const result = await retryPendingSubmissionReceipt("attempt-local-1", {
            submitSignedSessionAttempt: async input => {
                expect(input.submissionId).toBe("submission-1");
                return { status: "ok", attempt: authoritativeAttempt };
            },
        });

        expect(result).toEqual({ status: "confirmed", attempt: authoritativeAttempt });
        expect(readSubmissionReceipt("attempt-local-1")?.status).toBe("confirmed");
        expect(pendingSubmissionReceiptIds()).toEqual([]);
    });

    it("coalesces concurrent retry triggers for the same idempotent submission", async () => {
        const storage = createStorage();
        vi.stubGlobal("window", { localStorage: storage });
        queuePendingSubmissionReceipt({
            attemptId: "attempt-local-1",
            input: {
                examId: "exam-1",
                submissionId: "submission-1",
                answers: {},
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        });
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const deps = {
            submitSignedSessionAttempt: async () => {
                calls += 1;
                await gate;
                return { status: "error" as const };
            },
        };

        const first = retryPendingSubmissionReceipt("attempt-local-1", deps);
        const second = retryPendingSubmissionReceipt("attempt-local-1", deps);
        release();
        await Promise.all([first, second]);

        expect(calls).toBe(1);
    });

    it("ignores a tampered retry request whose stored attempt id does not match its key", () => {
        const storage = createStorage({
            omr_student_submission_receipts_v1: JSON.stringify({
                receipts: {
                    "attempt-local-1": {
                        attemptId: "attempt-local-1",
                        status: "pending",
                        updatedAt: "2026-07-28T00:00:00.000Z",
                    },
                },
                requests: {
                    "attempt-local-1": {
                        attemptId: "another-attempt",
                        input: {
                            examId: "exam-1",
                            submissionId: "submission-1",
                            answers: {},
                            startedAt: "2026-07-28T00:00:00.000Z",
                        },
                    },
                },
            }),
        });
        vi.stubGlobal("window", { localStorage: storage });

        expect(pendingSubmissionReceiptIds()).toEqual([]);
    });

    it("caches only server-authoritative selections and grading without an answer key", () => {
        const cached = localResultCacheFromServerReceipt(receipt, {
            examTitle: "학생용 시험",
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
        });
        expect(cached.answers).toEqual({ 1: 3, 2: 2 });
        expect(cached.questionResults.map(result => ({
            questionId: result.questionId,
            status: result.status,
            score: result.score,
            earnedScore: result.earnedScore,
        }))).toEqual([
            { questionId: 1, status: "correct", score: 5, earnedScore: 5 },
            { questionId: 2, status: "wrong", score: 5, earnedScore: 0 },
        ]);
        expect(JSON.stringify(cached)).not.toContain("correctAnswer");
    });

    it("keeps official statuses when review uses an answer-key-free student exam", () => {
        const safeExam: Exam = {
            id: "exam-1",
            title: "학생용 시험",
            createdAt: "2026-07-14T00:00:00.000Z",
            questions: [
                { id: 1, number: 1, choices: 5 },
                { id: 2, number: 2, choices: 4 },
            ],
        };
        const cached = localResultCacheFromServerReceipt(receipt, {
            examTitle: safeExam.title,
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
        });
        const attempt: Attempt = {
            id: receipt.attemptId,
            examId: receipt.examId,
            examTitle: safeExam.title,
            studentName: "학생 1",
            studentId: "student-1",
            identityType: "registered",
            startedAt: "2026-07-14T00:00:00.000Z",
            finishedAt: receipt.finishedAt,
            score: receipt.score,
            totalScore: receipt.totalScore,
            answers: cached.answers,
            questionResults: cached.questionResults,
            status: "completed",
        };

        expect(getAttemptQuestionResults(safeExam, attempt).map(result => ({
            status: result.status,
            score: result.score,
            earnedScore: result.earnedScore,
            correctAnswer: result.correctAnswer,
        }))).toEqual([
            { status: "correct", score: 5, earnedScore: 5, correctAnswer: undefined },
            { status: "wrong", score: 5, earnedScore: 0, correctAnswer: undefined },
        ]);
    });
});
