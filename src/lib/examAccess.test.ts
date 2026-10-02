import { describe, expect, it } from "vitest";
import type { Exam } from "@/types/omr";
import { evaluateExamAccess, examRequiresPin, isValidExamPin, normalizeExamPin, verifyExamPin } from "./examAccess";

function exam(overrides: Partial<Exam> = {}): Pick<Exam, "accessConfig" | "archived" | "startAt" | "endAt"> {
    return { accessConfig: overrides.accessConfig, archived: overrides.archived, startAt: overrides.startAt, endAt: overrides.endAt };
}

describe("exam access helpers", () => {
    it("normalizes PIN input to up to six digits", () => {
        expect(normalizeExamPin(" 12a34-567 ")).toBe("123456");
    });

    it("validates public PIN length and digits", () => {
        expect(isValidExamPin("1234")).toBe(true);
        expect(isValidExamPin("123456")).toBe(true);
        expect(isValidExamPin("123")).toBe(false);
        expect(isValidExamPin("12ab")).toBe(false);
    });

    it("requires and verifies PIN only for public PIN-protected exams", () => {
        const locked = exam({ accessConfig: { type: "public", pin: "1234" } });
        const publicOpen = exam({ accessConfig: { type: "public" } });
        const groupExam = exam({ accessConfig: { type: "group", groupIds: ["class-a"] } });

        expect(examRequiresPin(locked)).toBe(true);
        expect(verifyExamPin(locked, "1234")).toBe(true);
        expect(verifyExamPin(locked, "9999")).toBe(false);
        expect(verifyExamPin(publicOpen, "")).toBe(true);
        expect(verifyExamPin(groupExam, "")).toBe(true);
    });

    it("blocks direct access outside the scheduled exam window", () => {
        const scheduled = exam({
            accessConfig: { type: "public" },
            startAt: "2026-06-15T10:00:00.000Z",
            endAt: "2026-06-15T11:00:00.000Z",
        });

        expect(evaluateExamAccess(scheduled, { now: Date.parse("2026-06-15T09:59:00.000Z") })).toMatchObject({
            status: "not_started",
        });
        expect(evaluateExamAccess(scheduled, { now: Date.parse("2026-06-15T11:01:00.000Z") })).toMatchObject({
            status: "ended",
        });
    });

    it("opens at startsAt and ends at the exact exclusive end boundary", () => {
        const scheduled = exam({
            accessConfig: { type: "public" },
            startAt: "2026-06-15T10:00:00.000Z",
            endAt: "2026-06-15T11:00:00.000Z",
        });

        expect(evaluateExamAccess(scheduled, { now: Date.parse(scheduled.startAt!) }))
            .toEqual({ status: "allowed" });
        expect(evaluateExamAccess(scheduled, { now: Date.parse(scheduled.endAt!) }))
            .toEqual({ status: "ended", at: scheduled.endAt });
    });

    it.each([
        ["blank start", { startAt: "" }],
        ["malformed start", { startAt: "tomorrow" }],
        ["impossible start", { startAt: "2026-02-30T00:00:00.000Z" }],
        ["blank end", { endAt: "" }],
        ["malformed end", { endAt: "tomorrow" }],
        ["date-only end", { endAt: "2026-06-15" }],
        ["reversed window", {
            startAt: "2026-06-15T12:00:00.000Z",
            endAt: "2026-06-15T10:00:00.000Z",
        }],
        ["empty window", {
            startAt: "2026-06-15T11:00:00.000Z",
            endAt: "2026-06-15T11:00:00.000Z",
        }],
    ])("fails closed for %s", (_label, window) => {
        expect(evaluateExamAccess(exam({
            accessConfig: { type: "public" },
            ...window,
        }), { now: Date.parse("2026-06-15T11:00:00.000Z") })).toEqual({ status: "ended" });
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
        "fails closed for invalid supplied now %s",
        now => {
            expect(evaluateExamAccess(exam({ accessConfig: { type: "public" } }), { now }))
                .toEqual({ status: "ended" });
        },
    );

    it("does not turn malformed time data into allowed access when a submission clock is rewound", () => {
        const malformed = exam({ accessConfig: { type: "public" }, endAt: "not-an-iso-time" });
        const now = Date.parse("2026-06-15T11:00:00.000Z");
        expect(evaluateExamAccess(malformed, { now })).toEqual({ status: "ended" });
        expect(evaluateExamAccess(malformed, { now: now - 2 * 60 * 1000 })).toEqual({ status: "ended" });
    });

    it("preserves a valid submission grace rewind without relaxing other gates", () => {
        const valid = exam({
            accessConfig: { type: "public" },
            startAt: "2026-06-15T10:00:00.000Z",
            endAt: "2026-06-15T11:00:00.000Z",
        });
        const now = Date.parse(valid.endAt!);
        expect(evaluateExamAccess(valid, { now })).toEqual({ status: "ended", at: valid.endAt });
        expect(evaluateExamAccess(valid, { now: now - 2 * 60 * 1000 })).toEqual({ status: "allowed" });
    });

    it("keeps archived status authoritative even when stored timestamps are malformed", () => {
        expect(evaluateExamAccess(exam({ archived: true, startAt: "bad", endAt: "worse" })))
            .toEqual({ status: "archived" });
    });

    it("requires a matching student group for group-distributed exams", () => {
        const groupOnly = exam({ accessConfig: { type: "group", groupIds: ["class-a"] } });

        expect(evaluateExamAccess(groupOnly)).toMatchObject({ status: "login_required" });
        expect(evaluateExamAccess(groupOnly, {
            session: { identityType: "guest", isGuest: true },
        })).toMatchObject({ status: "login_required" });
        expect(evaluateExamAccess(groupOnly, {
            session: { groupId: "class-a", identityType: "guest", isGuest: true },
        })).toMatchObject({ status: "allowed" });
        expect(evaluateExamAccess(groupOnly, {
            session: { groupId: "class-b", identityType: "temporary" },
        })).toMatchObject({ status: "group_denied" });
        expect(evaluateExamAccess(groupOnly, {
            session: { groupId: "class-a", identityType: "temporary" },
        })).toMatchObject({ status: "allowed" });
    });

    it("requires PIN verification before allowing a public locked exam", () => {
        const locked = exam({ accessConfig: { type: "public", pin: "123456" } });

        expect(evaluateExamAccess(locked, { pinVerified: false })).toMatchObject({ status: "pin_required" });
        expect(evaluateExamAccess(locked, { pinVerified: true })).toMatchObject({ status: "allowed" });
    });
});
