import { describe, expect, it } from "vitest";
import {
    createSignedGuestClaimCapability,
    guestClaimCapabilityMatchesStudent,
    parseSignedGuestClaimCapability,
} from "./studentGuestClaimCapability";

const ENV = { NODE_ENV: "production", STUDENT_SESSION_SECRET: "claim-secret" };
const NOW = 1_000_000;

describe("guest claim capability", () => {
    it("binds a bounded exact attempt set to one guest and verified student", () => {
        const cookie = createSignedGuestClaimCapability({
            guestId: "guest-1",
            studentId: "student-1",
            organizationId: "org-1",
            classId: "class-1",
            attemptIds: ["local-1", "remote-1", "local-1"],
        }, ENV, NOW);

        expect(parseSignedGuestClaimCapability(cookie, ENV, NOW + 1)).toMatchObject({
            audience: "omr-guest-claim",
            guestId: "guest-1",
            studentId: "student-1",
            organizationId: "org-1",
            classId: "class-1",
            attemptIds: ["local-1", "remote-1"],
        });
    });

    it("rejects tampering, expiry, oversized sets, and a different student target", () => {
        const input = {
            guestId: "guest-1",
            studentId: "student-1",
            organizationId: "org-1",
            classId: "class-1",
            attemptIds: ["attempt-1"],
        };
        const cookie = createSignedGuestClaimCapability(input, ENV, NOW)!;
        const [payload, signature] = cookie.split(".");
        expect(parseSignedGuestClaimCapability(`${payload}x.${signature}`, ENV, NOW)).toBeNull();
        expect(parseSignedGuestClaimCapability(cookie, ENV, NOW + 24 * 60 * 60 * 1000 + 1)).toBeNull();
        expect(createSignedGuestClaimCapability({
            ...input,
            attemptIds: Array.from({ length: 101 }, (_, index) => `attempt-${index}`),
        }, ENV, NOW)).toBeNull();

        const capability = parseSignedGuestClaimCapability(cookie, ENV, NOW)!;
        expect(guestClaimCapabilityMatchesStudent(capability, {
            kind: "student",
            studentId: "student-2",
            organizationId: "org-1",
            name: "다른 학생",
            groupId: "class-1",
            identityType: "temporary",
            issuedAt: NOW,
            expiresAt: NOW + 1_000,
        })).toBe(false);
    });
});
