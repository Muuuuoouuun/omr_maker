import { describe, expect, it, vi } from "vitest";
import type { StudentAttemptSessionState } from "./studentAttemptSessionContract";
import { observeLatestAttemptSession, takeoverRequestFromLatestSession } from "./studentAttemptConflictRecovery";

function session(revision: number, leaseEpoch: number): StudentAttemptSessionState {
    return {
        sessionId: "session-1", examId: "exam-1", status: "in_progress", revision, leaseEpoch,
        startedAt: "2026-08-06T00:00:00.000Z", deadlineAt: "2026-08-06T01:00:00.000Z",
        serverNow: "2026-08-06T00:10:00.000Z", answers: {}, subQuestionAnswers: {},
        progressPayload: {}, allowedQuestionIds: [1],
    };
}

describe("durable attempt conflict recovery", () => {
    it("observes the server-latest revision before building a takeover CAS", async () => {
        const latest = session(9, 4);
        const observe = vi.fn(async () => ({ status: "lease_conflict" as const, session: latest }));
        const result = await observeLatestAttemptSession("old-device-token", observe);
        expect(observe).toHaveBeenCalledWith("old-device-token");
        expect(result.status).toBe("lease_conflict");
        if (result.status !== "lease_conflict") throw new Error("expected conflict");
        expect(takeoverRequestFromLatestSession(result.session)).toEqual({
            sessionId: "session-1", examId: "exam-1", expectedRevision: 9, expectedLeaseEpoch: 4,
        });
    });
});
