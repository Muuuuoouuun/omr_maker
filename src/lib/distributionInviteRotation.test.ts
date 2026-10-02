import { describe, expect, it, vi } from "vitest";
import {
    confirmExistingGroupInviteRotation,
    isGroupInviteShareUrl,
    normalizeDistributionShareResult,
    resolveInviteRotationExamId,
} from "@/lib/distributionInviteRotation";

const metadata = {
    inviteId: "exam_invite_0123456789abcdef0123456789abcdef",
    examId: "exam-1",
    targetType: "groups" as const,
    targetIds: ["group-1"],
    generation: 2,
    issuedAt: "2026-08-08T02:00:00.000Z",
    expiresAt: "2026-08-08T03:00:00.000Z",
    revokedAt: null,
};

describe("existing group invite rotation", () => {
    it("does not call the rotate-and-save action when the teacher cancels", async () => {
        const rotateAndSave = vi.fn(async () => ({
            shareUrl: "https://exam.example/solve/exam-1?invite=new-token",
            expiresAt: "2026-08-08T03:00:00.000Z",
        }));

        const result = await confirmExistingGroupInviteRotation({
            needsConfirmation: true,
            confirm: () => false,
            rotateAndSave,
        });

        expect(result).toEqual({ status: "cancelled" });
        expect(rotateAndSave).not.toHaveBeenCalled();
    });

    it("calls the rotate-and-save action once after explicit confirmation", async () => {
        const issued = {
            shareUrl: "https://exam.example/solve/exam-1?invite=new-token",
            expiresAt: "2026-08-08T03:00:00.000Z",
        };
        const rotateAndSave = vi.fn(async () => issued);

        const result = await confirmExistingGroupInviteRotation({
            needsConfirmation: true,
            confirm: () => true,
            rotateAndSave,
        });

        expect(result).toEqual({ status: "saved", result: issued });
        expect(rotateAndSave).toHaveBeenCalledOnce();
    });

    it("preserves the issued expiry while accepting the legacy string result", () => {
        expect(normalizeDistributionShareResult({
            shareUrl: "https://exam.example/solve/exam-1?invite=new-token",
            expiresAt: "2026-08-08T03:00:00.000Z",
        })).toEqual({
            shareUrl: "https://exam.example/solve/exam-1?invite=new-token",
            expiresAt: "2026-08-08T03:00:00.000Z",
        });
        expect(normalizeDistributionShareResult("https://exam.example/solve/exam-1")).toEqual({
            shareUrl: "https://exam.example/solve/exam-1",
        });
    });

    it("preserves authoritative metadata atomically with the one-time raw URL", () => {
        expect(normalizeDistributionShareResult({
            shareUrl: "https://exam.example/solve/exam-1#invite=new-token",
            expiresAt: metadata.expiresAt,
            examId: metadata.examId,
            metadata,
        })).toEqual({
            shareUrl: "https://exam.example/solve/exam-1#invite=new-token",
            expiresAt: metadata.expiresAt,
            examId: metadata.examId,
            metadata,
        });
    });

    it("distinguishes a group bearer URL from a valid public URL", () => {
        expect(isGroupInviteShareUrl("https://exam.example/solve/exam-1#invite=secret"))
            .toBe(true);
        expect(isGroupInviteShareUrl("https://exam.example/solve/exam-1"))
            .toBe(false);
    });

    it("rejects a self-consistent exam-B rotate result while editing exam A", () => {
        const examBMetadata = { ...metadata, examId: "exam-b" };

        expect(resolveInviteRotationExamId({
            shareUrl: "https://exam.example/solve/exam-b#invite=secret",
            examId: "exam-b",
            metadata: examBMetadata,
        }, "exam-a")).toBeNull();
        expect(resolveInviteRotationExamId({
            shareUrl: "https://exam.example/solve/exam-a#invite=secret",
            examId: "exam-a",
            metadata: { ...metadata, examId: "exam-a" },
        }, "exam-a")).toBe("exam-a");
        expect(resolveInviteRotationExamId({
            shareUrl: "https://exam.example/solve/exam-b#invite=secret",
            examId: "exam-b",
            metadata: examBMetadata,
        })).toBe("exam-b");
    });
});
