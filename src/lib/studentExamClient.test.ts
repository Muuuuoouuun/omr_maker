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

    it("treats an explicit denied as a hard stop — never reads the local answer-bearing copy", async () => {
        const server = vi.fn().mockResolvedValue({ status: "denied" });
        const readLocalExam = vi.fn(() => LOCAL_EXAM);
        const evaluateLocalAccess = vi.fn();
        const res = await loadExamForSolvingClient("e1", undefined, { server, readLocalExam, evaluateLocalAccess });
        expect(res).toMatchObject({ status: "denied", source: "server" });
        expect(res.exam).toBeUndefined();
        expect(readLocalExam).not.toHaveBeenCalled();
        expect(evaluateLocalAccess).not.toHaveBeenCalled();
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
            { examId: "e1", answers: {}, startedAt: "x" }, "1234",
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "ok", source: "server" });
        expect(server).toHaveBeenCalledWith({ examId: "e1", answers: {}, startedAt: "x" }, "1234");
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("forwards the client idempotency key to the server action", async () => {
        const server = vi.fn().mockResolvedValue({ status: "ok", attempt: ATTEMPT });
        const input = { examId: "e1", answers: {}, startedAt: "x", idempotencyKey: "idem-1" };
        await submitAttemptClient(input, undefined, {
            server, localFallback: vi.fn(), allowLocalFallback: false,
        });
        expect(server).toHaveBeenCalledWith(
            expect.objectContaining({ idempotencyKey: "idem-1" }),
            undefined,
        );
    });

    it("grades locally when the server is degraded and fallback is allowed", async () => {
        const server = vi.fn().mockResolvedValue({ status: "degraded_local" });
        const localFallback = vi.fn().mockResolvedValue(ATTEMPT);
        const res = await submitAttemptClient(
            { examId: "e1", answers: {}, startedAt: "x" }, undefined,
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "ok", source: "local" });
    });

    it("never grades locally for a server-sourced session (answers absent)", async () => {
        const server = vi.fn().mockRejectedValue(new Error("network"));
        const localFallback = vi.fn();
        const res = await submitAttemptClient(
            { examId: "e1", answers: {}, startedAt: "x" }, undefined,
            { server, localFallback, allowLocalFallback: false },
        );
        expect(res.status).toBe("error");
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("treats denied as a hard stop even when local fallback is allowed", async () => {
        const server = vi.fn().mockResolvedValue({ status: "denied" });
        const localFallback = vi.fn();
        const res = await submitAttemptClient(
            { examId: "e1", answers: {}, startedAt: "x" }, undefined,
            { server, localFallback, allowLocalFallback: true },
        );
        expect(res).toMatchObject({ status: "denied", source: "server" });
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("passes access rejections through (pin_required)", async () => {
        const server = vi.fn().mockResolvedValue({ status: "pin_required" });
        const res = await submitAttemptClient(
            { examId: "e1", answers: {}, startedAt: "x" }, undefined,
            { server, localFallback: vi.fn(), allowLocalFallback: true },
        );
        expect(res.status).toBe("pin_required");
    });
});

describe("listMyAssignmentsClient", () => {
    it("uses the server list when available", async () => {
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({ status: "ok", attempts: [ATTEMPT] }),
            localFallback: vi.fn(),
        });
        expect(res).toMatchObject({ status: "ok", source: "server" });
        expect(res.attempts).toHaveLength(1);
    });

    it("falls back to the local list on degraded/error/throw", async () => {
        for (const server of [
            vi.fn().mockResolvedValue({ status: "degraded_local" }),
            vi.fn().mockResolvedValue({ status: "error" }),
            vi.fn().mockRejectedValue(new Error("network")),
        ]) {
            const res = await listMyAssignmentsClient({
                server,
                localFallback: vi.fn().mockResolvedValue([ATTEMPT]),
            });
            expect(res).toMatchObject({ status: "ok", source: "local" });
            expect(res.attempts).toHaveLength(1);
        }
    });

    it("treats denied as a hard stop with an empty list", async () => {
        const localFallback = vi.fn();
        const res = await listMyAssignmentsClient({
            server: vi.fn().mockResolvedValue({ status: "denied" }),
            localFallback,
        });
        expect(res).toMatchObject({ status: "denied", source: "server" });
        expect(res.attempts).toHaveLength(0);
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

    it("falls back to the local exam on degraded/throw", async () => {
        for (const server of [
            vi.fn().mockResolvedValue({ status: "degraded_local" }),
            vi.fn().mockRejectedValue(new Error("network")),
        ]) {
            const res = await loadReviewExamClient("a1", {
                server,
                localFallback: vi.fn().mockResolvedValue(LOCAL_EXAM),
            });
            expect(res).toMatchObject({ status: "ok", source: "local" });
        }
    });

    it("treats denied as a hard stop — the answer-bearing local exam stays unread", async () => {
        const localFallback = vi.fn();
        const res = await loadReviewExamClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "denied" }),
            localFallback,
        });
        expect(res).toMatchObject({ status: "denied", source: "server" });
        expect(res.exam).toBeUndefined();
        expect(localFallback).not.toHaveBeenCalled();
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

    it("falls back to a device-local attempt when the server degrades", async () => {
        const res = await loadMyAttemptClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "degraded_local" }),
            localFallback: vi.fn().mockResolvedValue(ATTEMPT),
        });
        expect(res).toMatchObject({ status: "ok", source: "local" });
    });

    it("treats denied as a hard stop even when the device has a copy", async () => {
        const localFallback = vi.fn().mockResolvedValue(ATTEMPT);
        const res = await loadMyAttemptClient("a1", {
            server: vi.fn().mockResolvedValue({ status: "denied" }),
            localFallback,
        });
        expect(res).toMatchObject({ status: "denied", source: "server" });
        expect(res.attempt).toBeUndefined();
        expect(localFallback).not.toHaveBeenCalled();
    });

    it("reports error when the server fails and the device has no copy", async () => {
        const res = await loadMyAttemptClient("a1", {
            server: vi.fn().mockRejectedValue(new Error("network")),
            localFallback: vi.fn().mockResolvedValue(null),
        });
        expect(res.status).toBe("error");
    });
});
