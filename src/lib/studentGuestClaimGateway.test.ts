import { describe, expect, it, vi } from "vitest";
import { claimSignedGuestAttempts } from "./studentGuestClaimGateway";

describe("signed guest-attempt claim gateway", () => {
    it("atomically moves only the signed guest owner into the verified student scope", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: 2, error: null });

        await expect(claimSignedGuestAttempts({ rpc }, {
            guest: {
                kind: "guest",
                guestId: "guest-secret",
                name: "Guest Student",
                identityType: "guest",
                issuedAt: 1,
                expiresAt: 9e15,
            },
            student: {
                kind: "student",
                studentId: "student-1",
                organizationId: "teacher_org",
                name: "김학생",
                groupId: "class-1",
                groupName: "1반",
                identityType: "temporary",
                issuedAt: 2,
                expiresAt: 9e15,
            },
            attemptIds: ["attempt-1", "attempt-2"],
        })).resolves.toEqual({ status: "claimed", claimedCount: 2 });

        expect(rpc).toHaveBeenCalledWith("omr_claim_guest_attempts_v1", {
            p_guest_id: "guest-secret",
            p_student_profile_id: "student-1",
            p_organization_id: "teacher_org",
            p_class_id: "class-1",
            p_student_name: "김학생",
            p_group_name: "1반",
            p_attempt_ids: ["attempt-1", "attempt-2"],
        });
    });

    it("rejects incomplete or non-guest ownership without calling the database", async () => {
        const rpc = vi.fn();

        await expect(claimSignedGuestAttempts({ rpc }, {
            guest: null,
            student: {
                kind: "student",
                studentId: "student-1",
                organizationId: "teacher_org",
                name: "김학생",
                groupId: "class-1",
                groupName: "1반",
                identityType: "temporary",
                issuedAt: 2,
                expiresAt: 9e15,
            },
            attemptIds: [],
        })).resolves.toEqual({ status: "not_requested", claimedCount: 0 });
        expect(rpc).not.toHaveBeenCalled();
    });

    it("keeps the claim retryable when the atomic RPC fails", async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { message: "database unavailable" },
        });

        await expect(claimSignedGuestAttempts({ rpc }, {
            guest: {
                kind: "guest",
                guestId: "guest-secret",
                name: "Guest Student",
                identityType: "guest",
                issuedAt: 1,
                expiresAt: 9e15,
            },
            student: {
                kind: "student",
                studentId: "student-1",
                organizationId: "teacher_org",
                name: "김학생",
                groupId: "class-1",
                groupName: "1반",
                identityType: "temporary",
                issuedAt: 2,
                expiresAt: 9e15,
            },
            attemptIds: ["attempt-1"],
        })).resolves.toEqual({
            status: "retryable_error",
            claimedCount: 0,
            error: "database unavailable",
        });
    });
});
