import { describe, expect, it } from "vitest";
import {
    remainingAttemptSeconds,
    studentAttemptSessionStateFromRpc,
} from "./studentAttemptSessionContract";
import { leaseTokenHash } from "./studentAttemptSessionCrypto.server";

describe("student attempt session contract", () => {
    it("derives the countdown from the server clock and immutable deadline", () => {
        const serverNow = Date.parse("2026-08-06T00:00:10.000Z");
        const deadline = "2026-08-06T00:01:10.000Z";

        const observedAtClient = serverNow + 10 * 60_000;
        expect(remainingAttemptSeconds(
            deadline,
            new Date(serverNow).toISOString(),
            observedAtClient,
            observedAtClient + 20_000,
        )).toBe(40);
        expect(remainingAttemptSeconds(
            deadline,
            new Date(serverNow).toISOString(),
            observedAtClient,
            observedAtClient + 90_000,
        )).toBe(0);

        const slowClientObservedAt = serverNow - 10 * 60_000;
        expect(remainingAttemptSeconds(
            deadline,
            new Date(serverNow).toISOString(),
            slowClientObservedAt,
            slowClientObservedAt + 20_000,
        )).toBe(40);
    });

    it("hashes lease tokens without exposing the token in database parameters", () => {
        expect(leaseTokenHash("lease-secret", "server-secret")).toMatch(/^[a-f0-9]{64}$/);
        expect(leaseTokenHash("lease-secret", "server-secret")).toBe(
            leaseTokenHash("lease-secret", "server-secret"),
        );
        expect(leaseTokenHash("other", "server-secret")).not.toBe(
            leaseTokenHash("lease-secret", "server-secret"),
        );
    });

    it("parses only the answer-safe session projection", () => {
        expect(studentAttemptSessionStateFromRpc({
            session_id: "session-1",
            status: "in_progress",
            revision: 4,
            lease_epoch: 2,
            started_at: "2026-08-06T00:00:00.000Z",
            deadline_at: "2026-08-06T00:30:00.000Z",
            server_now: "2026-08-06T00:02:00.000Z",
            answers: { 1: 3 },
            sub_question_answers: {},
            allowed_question_ids: [1, 2],
            grading_snapshot: { questions: [{ answer: 3 }] },
        })).toEqual({
            sessionId: "session-1",
            status: "in_progress",
            revision: 4,
            leaseEpoch: 2,
            startedAt: "2026-08-06T00:00:00.000Z",
            deadlineAt: "2026-08-06T00:30:00.000Z",
            serverNow: "2026-08-06T00:02:00.000Z",
            answers: { 1: 3 },
            subQuestionAnswers: {},
            progressPayload: {},
            allowedQuestionIds: [1, 2],
        });
    });

    it("drops answers and subanswers outside the authorized bounded scope", () => {
        const parsed = studentAttemptSessionStateFromRpc({
            session_id: "session-1",
            status: "in_progress",
            revision: 1,
            lease_epoch: 1,
            started_at: "2026-08-06T00:00:00.000Z",
            deadline_at: "2026-08-06T00:30:00.000Z",
            server_now: "2026-08-06T00:01:00.000Z",
            allowed_question_ids: [1, 2],
            answers: { 1: 5, 2: 6, 999: 3 },
            sub_question_answers: {
                1: { reason: { schemaVersion: 1, body: "근거", reviewStatus: "needs_review" } },
                999: { forged: { schemaVersion: 1, body: "x", reviewStatus: "needs_review" } },
                2: { malformed: { schemaVersion: 2, body: "x", reviewStatus: "needs_review" } },
            },
        });
        expect(parsed?.answers).toEqual({ 1: 5 });
        expect(parsed?.subQuestionAnswers).toEqual({
            1: { reason: { schemaVersion: 1, body: "근거", reviewStatus: "needs_review" } },
        });
    });

    it("restores only canonical bounded handwriting from the lease checkpoint", () => {
        const stroke = JSON.stringify({
            mode: "pen",
            color: "#123456",
            width: 2,
            points: [{ x: 0.1, y: 0.2 }, { x: 0.2, y: 0.3, p: 0.5 }],
        });
        const parsed = studentAttemptSessionStateFromRpc({
            session_id: "session-1",
            status: "in_progress",
            revision: 2,
            lease_epoch: 2,
            started_at: "2026-08-06T00:00:00.000Z",
            deadline_at: "2026-08-06T00:30:00.000Z",
            server_now: "2026-08-06T00:01:00.000Z",
            allowed_question_ids: [1],
            answers: {},
            sub_question_answers: {},
            progress_payload: {
                currentQuestionId: 1,
                studentName: "must-not-cross-device",
                handwritingCheckpoint: {
                    schemaVersion: 1,
                    drawings: { 1: [stroke] },
                    hiddenNote: "must-not-cross-device",
                },
            },
        });

        expect(parsed?.progressPayload).toEqual({
            currentQuestionId: 1,
            handwritingCheckpoint: {
                schemaVersion: 1,
                drawings: { 1: [stroke] },
                pageCount: 1,
                strokeCount: 1,
            },
        });
        expect(JSON.stringify(parsed?.progressPayload)).not.toContain("studentName");
        expect(JSON.stringify(parsed?.progressPayload)).not.toContain("hiddenNote");
    });

    it("drops a forged free-text handwriting checkpoint instead of reflecting it to another device", () => {
        const parsed = studentAttemptSessionStateFromRpc({
            session_id: "session-1",
            status: "in_progress",
            revision: 2,
            lease_epoch: 2,
            started_at: "2026-08-06T00:00:00.000Z",
            deadline_at: "2026-08-06T00:30:00.000Z",
            server_now: "2026-08-06T00:01:00.000Z",
            allowed_question_ids: [1],
            answers: {},
            sub_question_answers: {},
            progress_payload: {
                currentQuestionId: 1,
                handwritingCheckpoint: {
                    schemaVersion: 1,
                    drawings: { 1: ["student medical note"] },
                },
            },
        });

        expect(parsed?.progressPayload).toEqual({ currentQuestionId: 1 });
    });
});
