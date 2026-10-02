import { describe, expect, it } from "vitest";

type Subject = {
    resolveAssignmentLifecycle?: (input: {
        state: unknown;
        startsAt?: unknown;
        endsAt?: unknown;
        now: unknown;
    }) => "scheduled" | "open" | "closed" | "invalid";
};

async function subject(): Promise<Subject> {
    try {
        return await import("./assignmentLifecycle") as Subject;
    } catch {
        return {};
    }
}

const past = "2026-08-09T00:00:00.000Z";
const now = "2026-08-09T01:00:00.000Z";
const future = "2026-08-09T02:00:00.000Z";
const later = "2026-08-09T03:00:00.000Z";

describe("assignment lifecycle", () => {
    it("is scheduled before the inclusive opening boundary", async () => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle).toBeTypeOf("function");
        expect(lifecycle.resolveAssignmentLifecycle?.({ state: "open", startsAt: future, endsAt: later, now }))
            .toBe("scheduled");
    });

    it("opens exactly at startsAt", async () => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle?.({ state: "open", startsAt: now, endsAt: later, now }))
            .toBe("open");
    });

    it("closes exactly at the exclusive endsAt boundary", async () => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle?.({ state: "open", startsAt: past, endsAt: now, now }))
            .toBe("closed");
    });

    it("keeps an archived assignment closed independently of its time window", async () => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle?.({ state: "archived", startsAt: past, endsAt: later, now }))
            .toBe("closed");
    });

    it("treats missing optional boundaries as an open interval", async () => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle?.({ state: "open", now })).toBe("open");
        expect(lifecycle.resolveAssignmentLifecycle?.({ state: "open", startsAt: null, endsAt: null, now }))
            .toBe("open");
    });

    it("compares timezone-offset ISO timestamps as instants", async () => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle?.({
            state: "open",
            startsAt: "2026-08-09T09:00:00+09:00",
            endsAt: "2026-08-09T11:00:00+09:00",
            now: "2026-08-09T01:00:00Z",
        })).toBe("open");
    });

    it.each([
        ["unknown state", { state: "scheduled", startsAt: past, endsAt: later, now }],
        ["malformed startsAt", { state: "open", startsAt: "tomorrow", endsAt: later, now }],
        ["blank present startsAt", { state: "open", startsAt: "", endsAt: later, now }],
        ["impossible calendar date", { state: "open", startsAt: "2026-02-30T00:00:00.000Z", endsAt: later, now }],
        ["malformed endsAt", { state: "open", startsAt: past, endsAt: "2026-08-09", now }],
        ["malformed server now", { state: "open", startsAt: past, endsAt: later, now: "invalid" }],
        ["reversed chronology", { state: "open", startsAt: later, endsAt: past, now }],
        ["empty chronology", { state: "open", startsAt: future, endsAt: future, now }],
    ])("fails closed for %s", async (_label, input) => {
        const lifecycle = await subject();
        expect(lifecycle.resolveAssignmentLifecycle?.(input)).toBe("invalid");
    });
});
