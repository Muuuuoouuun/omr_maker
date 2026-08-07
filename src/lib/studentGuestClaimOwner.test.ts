import { describe, expect, it } from "vitest";
import {
    createSignedGuestClaimOwnerProof,
    guestClaimOwnerMatchesStudent,
    parseSignedGuestClaimOwnerProof,
} from "./studentGuestClaimOwner";

const ENV = {
    NODE_ENV: "production",
    STUDENT_SESSION_SECRET: "guest-owner-student-session-secret-at-least-32-bytes",
};

describe("guest DB-owner claim proof", () => {
    it("binds only server-verified guest and target identities, never client ids or payload", () => {
        const proof = createSignedGuestClaimOwnerProof({
            guest: {
                kind: "guest",
                guestId: "guest-1",
                name: "Guest",
                identityType: "guest",
                issuedAt: 900,
                expiresAt: 5_000,
            },
            student: {
                kind: "student",
                studentId: "student-1",
                organizationId: "org-1",
                name: "김학생",
                groupId: "class-1",
                identityType: "temporary",
                issuedAt: 1_000,
                expiresAt: 10_000,
            },
        }, ENV, 1_000);
        const parsed = parseSignedGuestClaimOwnerProof(proof, ENV, 1_001);

        expect(parsed).toMatchObject({
            audience: "omr-guest-db-claim",
            guestId: "guest-1",
            studentId: "student-1",
            organizationId: "org-1",
            classId: "class-1",
            expiresAt: 5_000,
        });
        expect(JSON.stringify(parsed)).not.toMatch(/attempt|exam|payload|answer/i);
    });

    it("rejects tampering, expiry, and reuse for another student or class", () => {
        const proof = createSignedGuestClaimOwnerProof({
            guest: {
                kind: "guest",
                guestId: "guest-1",
                name: "Guest",
                identityType: "guest",
                issuedAt: 900,
                expiresAt: 5_000,
            },
            student: {
                kind: "student",
                studentId: "student-1",
                organizationId: "org-1",
                name: "김학생",
                groupId: "class-1",
                identityType: "temporary",
                issuedAt: 1_000,
                expiresAt: 10_000,
            },
        }, ENV, 1_000)!;
        const [payload, signature] = proof.split(".");
        expect(parseSignedGuestClaimOwnerProof(`${payload}x.${signature}`, ENV, 1_001)).toBeNull();
        expect(parseSignedGuestClaimOwnerProof(proof, ENV, 5_001)).toBeNull();
        const parsed = parseSignedGuestClaimOwnerProof(proof, ENV, 1_001)!;
        expect(guestClaimOwnerMatchesStudent(parsed, {
            kind: "student",
            studentId: "student-1",
            organizationId: "org-1",
            name: "김학생",
            groupId: "class-2",
            identityType: "temporary",
            issuedAt: 1_000,
            expiresAt: 10_000,
        })).toBe(false);
    });
});
