import { describe, expect, it, vi } from "vitest";
import {
    loadExamForSolvingClient,
    loadMyAttemptClient,
    loadReviewExamClient,
    listMyAssignmentsClient,
    submitAttemptClient,
} from "./studentExamClient";
import type { Attempt, Exam } from "@/types/omr";

const LOCAL_EXAM: Exam = {
    id: "e1",
    title: "로컬 시험",
    createdAt: "2026-07-01T00:00:00.000Z",
    questions: [{ id: 1, number: 1, answer: 3, choices: 5, score: 10 }],
};

const ATTEMPT = { id: "a1", examId: "e1" } as Attempt;
const SUBMISSION = { examId: "e1", submissionId: "550e8400-e29b-41d4-a716-446655440000", answers: {}, startedAt: "x" };

describe("loadExamForSolvingClient", () => {
    const okDeps = {
        readLocalExam: vi.fn(() => LOCAL_EXAM),
        evaluateLocalAccess: vi.fn(() => "ok" as const),
    };

    it("returns the server exam without touching the local path", async () => {
        const server = vi.fn().mockResolvedValue({ status: "ok", exam: { id: "e1", questions: [] } });
        const readLocalExam = vi.fn();
        const res = await loadExamForSolvingClient("e1", undefined, { ...okDeps, server, readLocalExam });
        expect(res).toMatchObject({ status: "ok", source: "server" });
        expect(res.exam).toMatchObject({ id: "e1" });
        expect(readLocalExam).not.toHaveBeenCalled();
    });

    it("passes blocked server statuses through (no local bypass)", async () => {
        const server = vi.fn().mockResolvedValue({ status: "ended" });
        const readLocalExam = vi.fn(() => LOCAL_EXAM);
        const res = await loadExamForSolvingClient("e1", undefined, { ...okDeps, server, readLocalExam });
        expect(res).toMatchObject({ status: "ended", source: "server" });
        expect(readLocalExam).not.toHaveBeenCalled();
    });

    it("falls back to the local exam on degraded_local and evaluates access locally", async () => {
        const server = vi.fn().mockResolvedValue({ status: "degraded_local" });
        const evaluateLocalAccess = vi.fn(() => "pin_required" as const);
        const res = await loadExamForSolvingClient("e1", undefined, {
            server, readLocalExam: () => LOCAL_EXAM, evaluateLocalAccess,
        });
        expect(res).toMatchObject({ status: "pin_required", source: "local" });
        expect(res.exam).toMatchObject({ id: "e1" });
        expect(evaluateLocalAccess).toHaveBeenCalledWith(LOCAL_EXAM);
    });

    it("falls back to the local exam when the server has no such exam", async () => {
        const server = vi.fn().mockResolvedValue({ status: "not_found" });
        const res = await loadExamForSolvingClient("e1", undefined, { ...okDeps, server });
        expect(res).toMatchObject({ status: "ok", source: "local" });
    });

    it("falls back to the local exam when the server action throws (offline)", async () => {
        const server = vi.fn().mockRejectedValue(new Error("network"));
        const res = await loadExamForSolvingClient("e1", undefined, { ...okDeps, server });
        expect(res).toMatchObject({ status: "ok", source: "local" });
    });

    it("reports not_found when neither server nor device has the exam", async () => {
        const server = vi.fn().mockResolvedValue({ status: "not_found" });
        const res = await loadExamForSolvingClient("e1", undefined, {
            server, readLocalExam: () => null, evaluateLocalAccess: vi.fn(),
        });
        expect(res).toMatchObject({ status: "not_found", source: "local" });
        expect(res.exam).toBeUndefined();
    });
});

describe("submitAttemptClient", () => {
    it("returns the server-graded attempt", async () => {
        const server = vi.fn().mockResolvedValue({ status: "ok", attempt: ATTEMPT });
        const localFallback = vi.fn();
        const res = await submitAttemptClient(
            SUBMISSION, "1234",
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "ok", source: "server", receiptStatus: "confirmed" });
        expect(server).toHaveBeenCalledWith(SUBMISSION, "1234");
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("grades locally when the server is degraded and fallback is allowed", async () => {
        const server = vi.fn().mockResolvedValue({ status: "degraded_local" });
        const localFallback = vi.fn().mockResolvedValue(ATTEMPT);
        const res = await submitAttemptClient(
            SUBMISSION, undefined,
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "ok", source: "local", receiptStatus: "local_only" });
    });

    it("grades locally and marks the receipt pending when the server request fails", async () => {
        const server = vi.fn().mockRejectedValue(new Error("network"));
        const localFallback = vi.fn().mockResolvedValue(ATTEMPT);
        const res = await submitAttemptClient(
            SUBMISSION, undefined,
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "ok", source: "local", receiptStatus: "pending" });
    });

    it("grades locally and marks the receipt pending on a retryable server error", async () => {
        const server = vi.fn().mockResolvedValue({ status: "error" });
        const localFallback = vi.fn().mockResolvedValue(ATTEMPT);
        const res = await submitAttemptClient(
            SUBMISSION, undefined,
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "ok", source: "local", receiptStatus: "pending" });
    });

    it("never grades locally for a server-sourced session (answers absent)", async () => {
        const server = vi.fn().mockRejectedValue(new Error("network"));
        const localFallback = vi.fn();
        await expect(submitAttemptClient(
            SUBMISSION,
            undefined,
            { server, localFallback, allowLocalFallback: false },
        )).rejects.toThrow("network");
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("keeps known server business statuses as results for server-sourced sessions", async () => {
        const res = await submitAttemptClient(
            SUBMISSION,
            undefined,
            {
                server: vi.fn().mockResolvedValue({ status: "pin_required" }),
                localFallback: vi.fn(),
                allowLocalFallback: false,
            },
        );

        expect(res).toMatchObject({ status: "pin_required", source: "server" });
    });

    it("passes access rejections through (pin_required)", async () => {
        const server = vi.fn().mockResolvedValue({ status: "pin_required" });
        const res = await submitAttemptClient(
            SUBMISSION, undefined,
            { server, localFallback: vi.fn(), allowLocalFallback: true },
        );
        expect(res.status).toBe("pin_required");
    });
});

describe("listMyAssignmentsClient", () => {
    it("uses the server list when available", async () => {
        const serverNow = "2026-08-09T12:34:56.789Z";
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({
                status: "ok",
                attempts: [ATTEMPT],
                exams: [{ id: "e1", title: "서버 시험", questions: [] }],
                serverNow,
            }),
            localFallback: vi.fn(),
        });
        expect(res).toMatchObject({ status: "ok", source: "server", serverNow });
        expect(res.attempts).toHaveLength(1);
        expect(res.exams).toEqual([expect.objectContaining({ id: "e1" })]);
    });

    it("captures the request start and receipt performance anchors around the exact server promise", async () => {
        const samples = [100, 460];
        const res = await listMyAssignmentsClient({
            monotonicNow: () => samples.shift()!,
            server: vi.fn().mockResolvedValue({
                status: "ok", attempts: [], exams: [], serverNow: "2026-08-09T12:00:00.000Z",
            }),
            localFallback: vi.fn(),
        });
        expect(res).toMatchObject({
            source: "server",
            serverClock: {
                serverNow: "2026-08-09T12:00:00.000Z",
                requestStartedMonotonicMs: 100,
                receivedMonotonicMs: 460,
            },
        });
    });

    it("fails closed to a remoteFailed local result when an ok response omits its classification clock", async () => {
        const localFallback = vi.fn().mockResolvedValue([ATTEMPT]);
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({ status: "ok", attempts: [ATTEMPT], exams: [] }),
            localFallback,
        });

        expect(res).toMatchObject({ status: "ok", source: "local", remoteFailed: true });
        expect(res.serverNow).toBeUndefined();
        expect(localFallback).toHaveBeenCalledOnce();
    });

    it("normalizes the local fallback to the same minimal summary contract", async () => {
        const localAttempt = {
            ...ATTEMPT,
            examTitle: "로컬 시험",
            studentName: "학생 비밀",
            startedAt: "2026-08-06T00:00:00.000Z",
            finishedAt: "2026-08-06T00:10:00.000Z",
            status: "completed",
            score: 9,
            totalScore: 10,
            answers: { 1: 3 },
            questionResults: [{ correctAnswer: 3 }],
            studentQuestions: [{
                questionId: 1,
                questionNumber: 1,
                body: "private-question",
                createdAt: "2026-08-06T00:05:00.000Z",
                status: "answered",
                answer: { body: "private-answer", createdAt: "2026-08-06T00:09:00.000Z" },
            }],
            drawingsRef: { store: "indexeddb", key: "drawing-secret" },
        } as unknown as Attempt;
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({ status: "degraded_local" }),
            localFallback: vi.fn().mockResolvedValue([localAttempt]),
        });

        expect(res.attempts).toEqual([{
            id: "a1",
            examId: "e1",
            examTitle: "로컬 시험",
            status: "completed",
            score: 9,
            totalScore: 10,
            startedAt: "2026-08-06T00:00:00.000Z",
            finishedAt: "2026-08-06T00:10:00.000Z",
            answeredQuestionCount: 1,
            latestAnsweredAt: "2026-08-06T00:09:00.000Z",
        }]);
        expect(JSON.stringify(res.attempts)).not.toMatch(/학생 비밀|private-question|private-answer|answers|correctAnswer|drawing-secret/);
    });

    it("falls back to the local list on degraded/error/throw", async () => {
        for (const [server, remoteFailed] of [
            [vi.fn().mockResolvedValue({ status: "degraded_local" }), false],
            [vi.fn().mockResolvedValue({ status: "error" }), true],
            [vi.fn().mockRejectedValue(new Error("network")), true],
        ] as const) {
            const res = await listMyAssignmentsClient({
                server,
                localFallback: vi.fn().mockResolvedValue([ATTEMPT]),
            });
            expect(res).toMatchObject({ status: "ok", source: "local", remoteFailed });
            expect(res.attempts).toHaveLength(1);
        }
    });

    it("does not use a local identity when the server explicitly rejects the session", async () => {
        const localFallback = vi.fn().mockResolvedValue([ATTEMPT]);
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({ status: "unauthenticated" }),
            localFallback,
        });
        expect(res).toMatchObject({ status: "unauthenticated", source: "server", attempts: [] });
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("preserves the stable server capacity error without a local success fallback", async () => {
        const localFallback = vi.fn().mockResolvedValue([ATTEMPT]);
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({ status: "error", error: "initial_capacity_exceeded" }),
            localFallback,
        });

        expect(res).toEqual({
            status: "error",
            attempts: [],
            exams: [],
            source: "server",
            error: "initial_capacity_exceeded",
        });
        expect(localFallback).not.toHaveBeenCalled();
    });
});

describe("loadReviewExamClient", () => {
    it("returns the server review exam without touching the local path", async () => {
        const localFallback = vi.fn();
        const res = await loadReviewExamClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "ok", exam: { id: "e1" } }),
            localFallback,
        });
        expect(res).toMatchObject({ status: "ok", source: "server" });
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("falls back to the local exam on degraded/denied/throw", async () => {
        for (const server of [
            vi.fn().mockResolvedValue({ status: "degraded_local" }),
            vi.fn().mockResolvedValue({ status: "denied" }),
            vi.fn().mockRejectedValue(new Error("network")),
        ]) {
            const res = await loadReviewExamClient("a1", {
                server,
                localFallback: vi.fn().mockResolvedValue(LOCAL_EXAM),
            });
            expect(res).toMatchObject({ status: "ok", source: "local" });
        }
    });

    it("reports error when neither source has the exam", async () => {
        const res = await loadReviewExamClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "not_found" }),
            localFallback: vi.fn().mockResolvedValue(null),
        });
        expect(res.status).toBe("error");
    });
});

describe("loadMyAttemptClient", () => {
    it("returns the server attempt when owned", async () => {
        const res = await loadMyAttemptClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "ok", attempt: ATTEMPT }),
            localFallback: vi.fn(),
        });
        expect(res).toMatchObject({ status: "ok", source: "server" });
    });

    it("falls back to a device-local attempt when the server denies or degrades", async () => {
        const res = await loadMyAttemptClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "degraded_local" }),
            localFallback: vi.fn().mockResolvedValue(ATTEMPT),
        });
        expect(res).toMatchObject({ status: "ok", source: "local" });
    });

    it("reports denied when the server denies and the device has no copy", async () => {
        const res = await loadMyAttemptClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "denied" }),
            localFallback: vi.fn().mockResolvedValue(null),
        });
        expect(res.status).toBe("denied");
    });
});
