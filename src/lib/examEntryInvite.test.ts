import { describe, expect, it } from "vitest";
import {
    createExamEntryInviteToken,
    examEntryInviteExpiry,
    hashExamEntryInviteToken,
    normalizeExamEntryInviteToken,
} from "./examEntryInvite";

describe("opaque exam entry invite", () => {
    it("creates a 32-byte opaque base64url token and stores only its sha256 hash", () => {
        const token = createExamEntryInviteToken();

        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(Buffer.from(token, "base64url")).toHaveLength(32);
        expect(hashExamEntryInviteToken(token)).toMatch(/^[a-f0-9]{64}$/);
        expect(hashExamEntryInviteToken(token)).not.toContain(token);
    });

    it("rejects malformed, padded, truncated, and oversized invite values", () => {
        expect(normalizeExamEntryInviteToken("a".repeat(43))).toBe("a".repeat(43));
        for (const value of ["", "a".repeat(42), "a".repeat(44), `${"a".repeat(42)}=`, "../invite", "가".repeat(43)]) {
            expect(normalizeExamEntryInviteToken(value)).toBeNull();
        }
    });

    it("uses a bounded server-selected lifetime", () => {
        const now = Date.parse("2026-08-07T00:00:00.000Z");
        expect(examEntryInviteExpiry(now)).toBe(now + 30 * 24 * 60 * 60 * 1000);
        expect(examEntryInviteExpiry(now, now + 365 * 24 * 60 * 60 * 1000))
            .toBe(now + 90 * 24 * 60 * 60 * 1000);
        expect(examEntryInviteExpiry(now, now + 1_000))
            .toBe(now + 15 * 60 * 1000);
    });
});
