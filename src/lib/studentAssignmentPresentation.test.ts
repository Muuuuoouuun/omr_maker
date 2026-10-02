import { describe, expect, it } from "vitest";

import {
    formatAssignmentDeadline,
    formatAssignmentStart,
    formatSubmittedDate,
    presentTodoAssignments,
    resolveAssignmentCardLifecycle,
    summarizeTodoHeadline,
    type AssignmentClock,
} from "@/lib/studentAssignmentPresentation";

// 2026-10-01 (목) 12:00 KST
const NOW = "2026-10-01T03:00:00.000Z";
const clock = (now = NOW, upper = now, trusted = true): AssignmentClock => ({ lowerNow: now, upperNow: upper, trusted });

type Card = {
    id: string;
    lifecycle?: unknown;
    startsAt?: string;
    endsAt?: string;
    archived?: boolean;
    reviewOnly?: true;
};

const card = (id: string, startsAt: string | undefined, endsAt: string | undefined, extra: Partial<Card> = {}): Card => ({
    id,
    lifecycle: "open",
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
    ...extra,
});

const ids = (cards: Card[]) => cards.map(item => item.id);

describe("presentTodoAssignments", () => {
    it("splits open, scheduled, closed, and invalid and orders each section for the student", () => {
        const started = "2026-09-30T00:00:00.000Z";
        const presentation = presentTodoAssignments([
            card("open-no-deadline", started, undefined),
            card("open-next-week", started, "2026-10-12T14:59:00.000Z"),
            card("open-today", started, "2026-10-01T09:00:00.000Z"),
            card("open-tomorrow", started, "2026-10-02T09:00:00.000Z"),
            card("scheduled-later", "2026-10-03T00:00:00.000Z", "2026-10-04T00:00:00.000Z", { lifecycle: "scheduled" }),
            card("scheduled-sooner", "2026-10-02T00:00:00.000Z", "2026-10-04T00:00:00.000Z", { lifecycle: "scheduled" }),
            card("closed-long-ago", "2026-09-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z", { lifecycle: "closed" }),
            card("closed-archived", started, "2026-10-05T00:00:00.000Z", { archived: true }),
            card("closed-yesterday", "2026-09-01T00:00:00.000Z", "2026-09-30T09:00:00.000Z", { lifecycle: "closed" }),
            card("invalid-dates", "not-a-time", "2026-10-05T00:00:00.000Z"),
            card("invalid-lifecycle", started, undefined, { lifecycle: "unexpected" }),
        ], clock());

        expect(ids(presentation.open)).toEqual(["open-today", "open-tomorrow", "open-next-week", "open-no-deadline"]);
        expect(ids(presentation.scheduled)).toEqual(["scheduled-sooner", "scheduled-later"]);
        // Archived before its end time: the closing moment is unknown, so it goes last.
        expect(ids(presentation.closed)).toEqual(["closed-yesterday", "closed-long-ago", "closed-archived"]);
        expect(ids(presentation.invalid)).toEqual(["invalid-dates", "invalid-lifecycle"]);
    });

    it("never treats a card as open when the clock is untrusted or its uncertainty crosses a boundary", () => {
        const nearEnd = card("near-end", "2026-09-30T00:00:00.000Z", "2026-10-01T03:00:00.250Z");
        expect(resolveAssignmentCardLifecycle(nearEnd, clock(NOW, "2026-10-01T03:00:00.400Z"))).toBe("invalid");
        expect(resolveAssignmentCardLifecycle(nearEnd, clock(NOW, NOW, false))).toBe("invalid");
        expect(resolveAssignmentCardLifecycle(nearEnd, clock())).toBe("open");
        expect(presentTodoAssignments([nearEnd], clock(NOW, NOW, false)).invalid).toHaveLength(1);
    });

    it("keeps review-only completed rows closed regardless of the clock", () => {
        expect(resolveAssignmentCardLifecycle({ id: "review", reviewOnly: true }, clock("", "", false))).toBe("closed");
    });

    it("uses the lower clock bound so an assignment closes exactly at its end", () => {
        const exam = card("boundary", "2026-09-30T00:00:00.000Z", NOW);
        expect(presentTodoAssignments([exam], clock()).closed).toHaveLength(1);
        expect(presentTodoAssignments([exam], clock("2026-10-01T02:59:59.000Z")).open).toHaveLength(1);
    });
});

describe("formatAssignmentDeadline", () => {
    it("labels today's deadline as urgent", () => {
        expect(formatAssignmentDeadline("2026-10-01T09:00:00.000Z", NOW))
            .toEqual({ label: "오늘 18:00 마감", kind: "today", urgent: true });
    });

    it("labels tomorrow's deadline", () => {
        expect(formatAssignmentDeadline("2026-10-02T09:00:00.000Z", NOW))
            .toEqual({ label: "내일 18:00 마감", kind: "tomorrow", urgent: false });
    });

    it("shows the date, weekday, time, and D-day within a week", () => {
        expect(formatAssignmentDeadline("2026-10-03T14:59:00.000Z", NOW)?.label).toBe("10/3(토) 23:59 마감 · D-2");
        expect(formatAssignmentDeadline("2026-10-08T03:00:00.000Z", NOW)?.label).toBe("10/8(목) 12:00 마감 · D-7");
    });

    it("shows only the date for deadlines more than a week away, with the year when it differs", () => {
        expect(formatAssignmentDeadline("2026-10-12T03:00:00.000Z", NOW))
            .toEqual({ label: "10/12(월) 마감", kind: "later", urgent: false });
        expect(formatAssignmentDeadline("2027-01-05T03:00:00.000Z", NOW)?.label).toBe("2027년 1/5(화) 마감");
    });

    it("counts days on the KST calendar, not UTC, across midnight", () => {
        const end = "2026-10-01T15:30:00.000Z"; // 10/2 00:30 KST
        // 10/1 23:59:59 KST — still the day before.
        expect(formatAssignmentDeadline(end, "2026-10-01T14:59:59.000Z")?.label).toBe("내일 00:30 마감");
        // 10/2 00:00 KST — same UTC date as before, but a new KST day.
        expect(formatAssignmentDeadline(end, "2026-10-01T15:00:00.000Z")?.label).toBe("오늘 00:30 마감");
        // A deadline at KST midnight belongs to the new day.
        expect(formatAssignmentDeadline("2026-10-01T15:00:00.000Z", NOW)?.label).toBe("내일 00:00 마감");
    });

    it("returns null for no deadline, unreadable values, or a deadline already passed", () => {
        expect(formatAssignmentDeadline(undefined, NOW)).toBeNull();
        expect(formatAssignmentDeadline("", NOW)).toBeNull();
        expect(formatAssignmentDeadline("not-a-time", NOW)).toBeNull();
        expect(formatAssignmentDeadline("2026-10-02T09:00:00.000Z", "")).toBeNull();
        expect(formatAssignmentDeadline(NOW, NOW)).toBeNull();
    });
});

describe("start and submission labels", () => {
    it("formats a start moment relative to the KST day", () => {
        expect(formatAssignmentStart("2026-10-01T06:00:00.000Z", NOW)).toBe("오늘 15:00");
        expect(formatAssignmentStart("2026-10-02T00:00:00.000Z", NOW)).toBe("내일 09:00");
        expect(formatAssignmentStart("2026-10-03T00:00:00.000Z", NOW)).toBe("10/3(토) 09:00");
        expect(formatAssignmentStart("nope", NOW)).toBeNull();
    });

    it("formats the submission day in KST", () => {
        expect(formatSubmittedDate("2026-09-30T15:10:00.000Z")).toBe("10/1");
        expect(formatSubmittedDate("2026-10-01T03:00:00.000Z")).toBe("10/1");
        expect(formatSubmittedDate(undefined)).toBeNull();
        expect(formatSubmittedDate("garbage")).toBeNull();
    });
});

describe("summarizeTodoHeadline", () => {
    const started = "2026-09-30T00:00:00.000Z";

    it("counts open assignments and the ones due today", () => {
        const presentation = presentTodoAssignments([
            card("today", started, "2026-10-01T09:00:00.000Z"),
            card("tomorrow", started, "2026-10-02T09:00:00.000Z"),
            card("scheduled", "2026-10-02T00:00:00.000Z", undefined, { lifecycle: "scheduled" }),
        ], clock());
        expect(summarizeTodoHeadline(presentation, clock())).toEqual({ kind: "open", openCount: 2, dueTodayCount: 1 });
    });

    it("names the next start when nothing is open", () => {
        const presentation = presentTodoAssignments([
            card("later", "2026-10-05T00:00:00.000Z", undefined, { lifecycle: "scheduled" }),
            card("sooner", "2026-10-03T00:00:00.000Z", undefined, { lifecycle: "scheduled" }),
            card("closed", "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z", { lifecycle: "closed" }),
        ], clock());
        expect(summarizeTodoHeadline(presentation, clock())).toEqual({ kind: "scheduled", startLabel: "10/3(토) 09:00" });
    });

    it("says nothing is due when only closed or invalid assignments remain", () => {
        const presentation = presentTodoAssignments([
            card("closed", "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z", { lifecycle: "closed" }),
            card("invalid", "not-a-time", undefined),
        ], clock());
        expect(summarizeTodoHeadline(presentation, clock())).toEqual({ kind: "none" });
        expect(summarizeTodoHeadline(presentTodoAssignments([], clock()), clock())).toEqual({ kind: "none" });
    });
});
