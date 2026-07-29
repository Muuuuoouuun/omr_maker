import { describe, expect, it, vi } from "vitest";
import {
    boundGuestClaimAttemptIds,
    claimSignedGuestAttempts,
} from "./studentGuestClaimGateway";

describe("signed guest-attempt claim gateway", () => {
    it("atomically moves only the signed guest owner into the verified student scope", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: ["attempt-1"], error: null });

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
        })).resolves.toEqual({
            status: "claimed",
            acknowledgedAttemptIds: ["attempt-1"],
        });

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
        })).resolves.toEqual({ status: "not_requested", acknowledgedAttemptIds: [] });
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
            acknowledgedAttemptIds: [],
            error: "database unavailable",
        });
    });

    it("chunks more than 100 ids without blocking login-sized recovery sets", async () => {
        const ids = Array.from({ length: 205 }, (_, index) => `attempt-${index}`);
        const rpc = vi.fn(async (_name, args: Record<string, unknown>) => ({
            data: (args.p_attempt_ids as string[]).filter(id => Number(id.split("-")[1]) % 2 === 0),
            error: null,
        }));

        const result = await claimSignedGuestAttempts({ rpc }, {
            guest: {
                kind: "guest",
                guestId: "guest-secret",
                name: "Guest",
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
            attemptIds: ids,
        });

        expect(result).toMatchObject({ status: "claimed" });
        expect(result.acknowledgedAttemptIds).toHaveLength(103);
        expect(rpc.mock.calls.map(([, args]) => (args.p_attempt_ids as string[]).length))
            .toEqual([100, 100, 5]);
    });

    it("reports partial DB claim failure while preserving earlier exact acknowledgements", async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: ["attempt-1"], error: null })
            .mockResolvedValueOnce({ data: null, error: { message: "temporary" } });

        await expect(claimSignedGuestAttempts({ rpc }, {
            guest: {
                kind: "guest",
                guestId: "guest-secret",
                name: "Guest",
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
            attemptIds: [...Array.from({ length: 100 }, (_, index) => `attempt-${index + 1}`), "attempt-101"],
        })).resolves.toEqual({
            status: "partial",
            acknowledgedAttemptIds: ["attempt-1"],
            error: "temporary",
        });
    });

    it("caps a huge claim at five RPC chunks and leaves the remainder pending", async () => {
        const ids = Array.from({ length: 650 }, (_, index) => `attempt-${index}`);
        const rpc = vi.fn(async (_name, args: Record<string, unknown>) => ({
            data: args.p_attempt_ids,
            error: null,
        }));

        const result = await claimSignedGuestAttempts({ rpc }, {
            guest: {
                kind: "guest",
                guestId: "guest-secret",
                name: "Guest",
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
            attemptIds: ids,
        });

        expect(result).toEqual({
            status: "partial",
            acknowledgedAttemptIds: ids.slice(0, 500),
            hasDeferredAttempts: true,
            error: "Guest attempt claim request exceeded safe bounds",
        });
        expect(rpc).toHaveBeenCalledTimes(5);
        expect(rpc.mock.calls.map(([, args]) => (args.p_attempt_ids as string[]).length))
            .toEqual([100, 100, 100, 100, 100]);
    });

    it("never sends overlong ids or more than 64KB of serialized ids", async () => {
        const overlong = "x".repeat(2_000);
        const ids = ["attempt-safe", overlong, ...Array.from(
            { length: 400 },
            (_, index) => `${index}-`.padEnd(240, "z"),
        )];
        const rpc = vi.fn(async (_name, args: Record<string, unknown>) => ({
            data: args.p_attempt_ids,
            error: null,
        }));

        const result = await claimSignedGuestAttempts({ rpc }, {
            guest: {
                kind: "guest",
                guestId: "guest-secret",
                name: "Guest",
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
            attemptIds: ids,
        });

        const sent = rpc.mock.calls.flatMap(([, args]) => args.p_attempt_ids as string[]);
        expect(result).toMatchObject({
            status: "partial",
            hasDeferredAttempts: true,
        });
        expect(sent).not.toContain(overlong);
        expect(new TextEncoder().encode(JSON.stringify(sent)).length).toBeLessThanOrEqual(64 * 1024);
        expect(rpc.mock.calls.length).toBeLessThanOrEqual(5);
    });

    it("validates arrays and never touches an accessor beyond the bounded prefix", () => {
        const nonArray = {
            get length() { throw new Error("non-array length accessed"); },
        };
        expect(boundGuestClaimAttemptIds(nonArray)).toEqual({
            attemptIds: [],
            hasDeferredAttempts: false,
        });

        const ids = Array.from({ length: 501 }, (_, index) => `attempt-${index}`);
        Object.defineProperty(ids, 500, {
            get() { throw new Error("tail accessed"); },
        });
        expect(boundGuestClaimAttemptIds(ids)).toEqual({
            attemptIds: ids.slice(0, 500),
            hasDeferredAttempts: true,
        });
    });

    it("stops at the serialized-byte boundary without inspecting the remaining tail", () => {
        const ids = Array.from({ length: 400 }, (_, index) => `${index}-`.padEnd(240, "z"));
        Object.defineProperty(ids, 399, {
            get() { throw new Error("byte-limit tail accessed"); },
        });

        const bounded = boundGuestClaimAttemptIds(ids);
        expect(bounded.hasDeferredAttempts).toBe(true);
        expect(new TextEncoder().encode(JSON.stringify(bounded.attemptIds)).length)
            .toBeLessThanOrEqual(64 * 1024);
    });
});
