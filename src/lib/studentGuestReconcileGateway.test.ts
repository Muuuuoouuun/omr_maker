import { describe, expect, it, vi } from "vitest";
import type { Exam } from "@/types/omr";
import type { StudentServerIdentity } from "./studentServerSession";
import {
    guestAttemptToReconcileItem,
    reconcileGuestAttemptSubmissions,
} from "./studentGuestReconcileGateway";

const student: StudentServerIdentity = {
    kind: "student",
    studentId: "student-1",
    organizationId: "org-1",
    name: "김학생",
    groupId: "class-1",
    groupName: "1반",
    identityType: "temporary",
    issuedAt: 1,
    expiresAt: 9e15,
};

const exam = {
    id: "exam-1",
    title: "시험",
    organizationId: "org-1",
    questions: [{
        id: 1,
        number: 4,
        answer: 2,
        correctAnswer: 2,
        score: 5,
        type: "multiple_choice",
        choices: ["1", "2", "3", "4"],
    }],
    createdAt: "2026-07-28T00:00:00.000Z",
} as unknown as Exam;

describe("purpose-limited guest reconciliation gateway", () => {
    it("regrades an allowed local-only guest attempt and returns a per-local-id authoritative ACK", async () => {
        const item = guestAttemptToReconcileItem({
            id: "local-1",
            examId: "exam-1",
            examTitle: "조작된 제목",
            studentName: "Guest",
            studentId: "guest:guest-1",
            guestId: "guest-1",
            identityType: "guest",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:10:00.000Z",
            score: 999,
            totalScore: 999,
            answers: { 1: 2 },
            status: "completed",
        }, "guest-1");
        const save = vi.fn(async (attempt) => attempt);

        await expect(reconcileGuestAttemptSubmissions({
            capability: {
                audience: "omr-guest-claim",
                schemaVersion: 1,
                guestId: "guest-1",
                studentId: "student-1",
                organizationId: "org-1",
                classId: "class-1",
                attemptIds: ["local-1"],
                issuedAt: 1,
                expiresAt: 9e15,
            },
            student,
            items: [item!],
        }, {
            attemptIdFor: () => "canonical-1",
            loadExam: async () => exam,
            loadExisting: async () => null,
            save,
        })).resolves.toEqual({
            status: "ok",
            acknowledgements: [{
                localAttemptId: "local-1",
                canonicalAttemptId: "canonical-1",
            }],
        });

        expect(save).toHaveBeenCalledWith(expect.objectContaining({
            id: "canonical-1",
            examId: "exam-1",
            examTitle: "시험",
            studentId: "student-1",
            studentProfileId: "student-1",
            score: 5,
            totalScore: 5,
            mergedFromGuestId: "guest-1",
        }));
    });

    it("is idempotent and never ingests an id outside the signed capability", async () => {
        const allowed = {
            localAttemptId: "local-1",
            submission: {
                examId: "exam-1",
                submissionId: "local-1",
                answers: { 1: 2 },
                startedAt: "2026-07-28T00:00:00.000Z",
            },
        };
        const denied = {
            ...allowed,
            localAttemptId: "local-2",
            submission: { ...allowed.submission, submissionId: "local-2" },
        };
        const existing = {
            id: "canonical-1",
            examId: "exam-1",
            examTitle: "시험",
            studentName: "김학생",
            studentId: "student-1",
            startedAt: "2026-07-28T00:00:00.000Z",
            finishedAt: "2026-07-28T00:10:00.000Z",
            score: 5,
            totalScore: 5,
            answers: { 1: 2 },
            status: "completed" as const,
        };
        const save = vi.fn();

        await expect(reconcileGuestAttemptSubmissions({
            capability: {
                audience: "omr-guest-claim",
                schemaVersion: 1,
                guestId: "guest-1",
                studentId: "student-1",
                organizationId: "org-1",
                classId: "class-1",
                attemptIds: ["local-1"],
                issuedAt: 1,
                expiresAt: 9e15,
            },
            student,
            items: [allowed, denied],
        }, {
            attemptIdFor: localId => `canonical-${localId.slice(-1)}`,
            loadExam: async () => exam,
            loadExisting: async id => id === "canonical-1" ? existing : null,
            save,
        })).resolves.toEqual({
            status: "partial",
            acknowledgements: [{
                localAttemptId: "local-1",
                canonicalAttemptId: "canonical-1",
            }],
        });
        expect(save).not.toHaveBeenCalled();
    });
});
