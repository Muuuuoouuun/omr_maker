import { describe, expect, it } from "vitest";
import {
    type ExamEntryInviteMetadata,
    type ExamEntryInviteRawUrlState,
    resolveInviteCapability,
} from "./examEntryInviteLifecycle";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");

const active: ExamEntryInviteMetadata = {
    inviteId: "invite-1",
    examId: "exam-1",
    targetType: "groups",
    targetIds: ["group-1"],
    generation: 1,
    issuedAt: "2026-08-08T11:00:00.000Z",
    expiresAt: "2026-08-08T13:00:00.000Z",
    revokedAt: null,
};

const validCurrentUrl: ExamEntryInviteRawUrlState = {
    url: "https://omr.example/join/exam-1",
    examId: "exam-1",
    generation: 1,
    issuedAt: "2026-08-08T11:00:01.000Z",
};

describe("exam entry invite capability", () => {
    it("allows copying an active invite when the local raw URL matches its exam and generation", () => {
        expect(resolveInviteCapability({ metadata: active, rawUrl: validCurrentUrl, now: NOW }))
            .toBe("copyable_here");
    });

    it("keeps an active invite unavailable when this client has no raw URL", () => {
        expect(resolveInviteCapability({ metadata: active, rawUrl: null, now: NOW }))
            .toBe("active_but_raw_unavailable");
    });

    it("reports expiry before considering a matching raw URL", () => {
        const expired = { ...active, expiresAt: "2026-08-08T11:59:59.999Z" };

        expect(resolveInviteCapability({ metadata: expired, rawUrl: validCurrentUrl, now: NOW }))
            .toBe("expired");
    });

    it("reports revocation before considering a matching raw URL", () => {
        const revoked = { ...active, revokedAt: "2026-08-08T11:30:00.000Z" };

        expect(resolveInviteCapability({ metadata: revoked, rawUrl: validCurrentUrl, now: NOW }))
            .toBe("revoked");
    });

    it("does not copy a raw URL from an older generation", () => {
        const generationTwo = { ...active, generation: 2 };

        expect(resolveInviteCapability({ metadata: generationTwo, rawUrl: validCurrentUrl, now: NOW }))
            .toBe("active_but_raw_unavailable");
    });

    it("treats the expiry instant as no longer active", () => {
        const expiresNow = { ...active, expiresAt: new Date(NOW).toISOString() };

        expect(resolveInviteCapability({ metadata: expiresNow, rawUrl: validCurrentUrl, now: NOW }))
            .toBe("expired");
    });

    it("requires the raw URL exam to match exactly", () => {
        const otherExamUrl = { ...validCurrentUrl, examId: "exam-2" };

        expect(resolveInviteCapability({ metadata: active, rawUrl: otherExamUrl, now: NOW }))
            .toBe("active_but_raw_unavailable");
    });

    it.each([
        ["zero metadata generation", { metadata: { ...active, generation: 0 }, rawUrl: validCurrentUrl, now: NOW }],
        ["fractional raw generation", { metadata: active, rawUrl: { ...validCurrentUrl, generation: 1.5 }, now: NOW }],
        ["malformed metadata issue time", { metadata: { ...active, issuedAt: "not-a-date" }, rawUrl: validCurrentUrl, now: NOW }],
        ["malformed local issue time", { metadata: active, rawUrl: { ...validCurrentUrl, issuedAt: "not-a-date" }, now: NOW }],
        ["empty raw URL", { metadata: active, rawUrl: { ...validCurrentUrl, url: "" }, now: NOW }],
        ["malformed target IDs", {
            metadata: { ...active, targetIds: "group-1" } as unknown as ExamEntryInviteMetadata,
            rawUrl: validCurrentUrl,
            now: NOW,
        }],
    ])("fails closed as raw unavailable for %s", (_label, input) => {
        expect(resolveInviteCapability(input)).toBe("active_but_raw_unavailable");
    });

    it("fails closed as expired when expiry or current time is malformed", () => {
        expect(resolveInviteCapability({
            metadata: { ...active, expiresAt: "not-a-date" },
            rawUrl: validCurrentUrl,
            now: NOW,
        })).toBe("expired");
        expect(resolveInviteCapability({ metadata: active, rawUrl: validCurrentUrl, now: Number.NaN }))
            .toBe("expired");
    });

    it("fails closed as revoked when revocation metadata is malformed", () => {
        expect(resolveInviteCapability({
            metadata: { ...active, revokedAt: "not-a-date" },
            rawUrl: validCurrentUrl,
            now: NOW,
        })).toBe("revoked");
    });
});
