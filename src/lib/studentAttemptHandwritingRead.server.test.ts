import { describe, expect, it, vi } from "vitest";
import type { Attempt } from "@/types/omr";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import {
    createOwnedStudentHandwritingSignedUrlWithGateway,
    resolveOwnedStudentHandwritingRef,
} from "./studentAttemptHandwritingRead.server";

const identity: StudentServerIdentity = {
    kind: "student",
    organizationId: "org-1",
    studentId: "student-1",
    name: "학생 1",
    identityType: "registered",
    issuedAt: 1,
    expiresAt: 9_999,
};

const attempt: Attempt = {
    id: "attempt-1",
    examId: "exam-1",
    examTitle: "시험",
    organizationId: "org-1",
    studentProfileId: "student-1",
    studentId: "student-1",
    studentName: "학생 1",
    identityType: "registered",
    startedAt: "2026-08-07T00:00:00.000Z",
    finishedAt: "2026-08-07T01:00:00.000Z",
    score: 1,
    totalScore: 1,
    answers: { 1: 1 },
    status: "completed",
    drawingsRef: {
        store: "remote",
        key: "asset-handwriting-1",
        organizationId: "org-1",
        kind: "attempt_handwriting",
        attemptId: "attempt-1",
        mimeType: "application/json",
        size: 128,
        updatedAt: "2026-08-07T01:00:01.000Z",
    },
};

describe("student attempt handwriting read boundary", () => {
    it("accepts only a completed remote handwriting ref owned by the signed identity", () => {
        expect(resolveOwnedStudentHandwritingRef(attempt, identity)).toMatchObject({
            key: "asset-handwriting-1",
            organizationId: "org-1",
            kind: "attempt_handwriting",
            attemptId: "attempt-1",
        });
        expect(resolveOwnedStudentHandwritingRef({ ...attempt, status: "in_progress" }, identity)).toBeNull();
        expect(resolveOwnedStudentHandwritingRef({
            ...attempt,
            studentId: "other-student",
            studentProfileId: "other-student",
        }, identity)).toBeNull();
        expect(resolveOwnedStudentHandwritingRef({
            ...attempt,
            drawingsRef: { ...attempt.drawingsRef!, attemptId: "other-attempt" },
        }, identity)).toBeNull();
    });

    it("signs only the server-derived owned ref, never a caller-supplied asset id", async () => {
        const sign = vi.fn().mockResolvedValue({
            status: "signed",
            signedUrl: "https://storage.example/signed",
        });
        await expect(createOwnedStudentHandwritingSignedUrlWithGateway(
            {} as never,
            attempt,
            identity,
            sign,
        )).resolves.toEqual({ status: "signed", signedUrl: "https://storage.example/signed" });
        expect(sign).toHaveBeenCalledWith(expect.anything(), {
            assetId: "asset-handwriting-1",
            organizationId: "org-1",
            kind: "attempt_handwriting",
            attemptId: "attempt-1",
        });
    });
});
