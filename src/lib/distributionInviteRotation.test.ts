import { describe, expect, it, vi } from "vitest";
import {
    confirmExistingGroupInviteRotation,
    normalizeDistributionShareResult,
} from "@/lib/distributionInviteRotation";

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
});
