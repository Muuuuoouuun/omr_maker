import { resolveAssignmentLifecycle, type AssignmentLifecycle } from "@/lib/assignmentLifecycle";

/**
 * Pure presentation rules for the student dashboard "할 일" list: which
 * section an assignment belongs to, in what order, and how its deadline reads
 * in Korean (KST). The component layer only renders what this returns.
 */

/** The monotonic server-anchored clock shared by the dashboard (see useAssignmentClock). */
export type AssignmentClock = {
    lowerNow: string;
    upperNow: string;
    trusted: boolean;
};

type AssignmentLike = object;

export function assignmentBoundary(exam: AssignmentLike, field: "start" | "end"): unknown {
    if (field === "start") {
        return "startsAt" in exam ? exam.startsAt : "startAt" in exam ? exam.startAt : undefined;
    }
    return "endsAt" in exam ? exam.endsAt : "endAt" in exam ? exam.endAt : undefined;
}

/**
 * Fail-closed lifecycle for one card. The lower and upper ends of the clock's
 * transit uncertainty must agree; otherwise the card is "invalid" so a
 * near-boundary assignment is never offered as solvable.
 */
export function resolveAssignmentCardLifecycle(exam: AssignmentLike, clock: AssignmentClock): AssignmentLifecycle {
    if ("reviewOnly" in exam && exam.reviewOnly === true) return "closed";
    if (!clock.trusted) return "invalid";
    const raw = "lifecycle" in exam ? exam.lifecycle : undefined;
    if (raw !== "scheduled" && raw !== "open" && raw !== "closed") return "invalid";
    const state = "archived" in exam && exam.archived ? "archived" : "open";
    const startsAt = assignmentBoundary(exam, "start");
    const endsAt = assignmentBoundary(exam, "end");
    const lower = resolveAssignmentLifecycle({ state, startsAt, endsAt, now: clock.lowerNow });
    const upper = resolveAssignmentLifecycle({ state, startsAt, endsAt, now: clock.upperNow });
    return lower === upper ? lower : "invalid";
}

function boundaryMs(exam: AssignmentLike, field: "start" | "end"): number | null {
    const value = assignmentBoundary(exam, field);
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

export type TodoAssignmentPresentation<T> = {
    /** Solvable now, deadline soonest first, no-deadline last. */
    open: T[];
    /** Not started yet, earliest start first. */
    scheduled: T[];
    /** Closed without a submission, most recently closed first. */
    closed: T[];
    /** Lifecycle cannot be trusted (malformed data or clock uncertainty). */
    invalid: T[];
};

export function presentTodoAssignments<T extends AssignmentLike>(
    exams: readonly T[],
    clock: AssignmentClock,
): TodoAssignmentPresentation<T> {
    const result: TodoAssignmentPresentation<T> = { open: [], scheduled: [], closed: [], invalid: [] };
    for (const exam of exams) result[resolveAssignmentCardLifecycle(exam, clock)].push(exam);

    const ascending = (field: "start" | "end") => (left: T, right: T) => {
        const a = boundaryMs(left, field) ?? Number.POSITIVE_INFINITY;
        const b = boundaryMs(right, field) ?? Number.POSITIVE_INFINITY;
        return a === b ? 0 : a < b ? -1 : 1;
    };
    result.open.sort(ascending("end"));
    result.scheduled.sort(ascending("start"));

    // An archived assignment can be closed before its end time; its closing
    // moment is unknown, so it sorts after the ones with a known close.
    const nowMs = Date.parse(clock.lowerNow);
    const closedAt = (exam: T) => {
        const end = boundaryMs(exam, "end");
        return end !== null && (!Number.isFinite(nowMs) || end <= nowMs) ? end : Number.NEGATIVE_INFINITY;
    };
    result.closed.sort((left, right) => {
        const a = closedAt(left);
        const b = closedAt(right);
        return a === b ? 0 : a > b ? -1 : 1;
    });
    return result;
}

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const KOREAN_WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"] as const;

/** Korea has no daylight saving time, so a fixed +09:00 offset is exact. */
function kstParts(ms: number) {
    const shifted = new Date(ms + KST_OFFSET_MS);
    return {
        year: shifted.getUTCFullYear(),
        month: shifted.getUTCMonth() + 1,
        day: shifted.getUTCDate(),
        weekday: KOREAN_WEEKDAYS[shifted.getUTCDay()],
        time: `${String(shifted.getUTCHours()).padStart(2, "0")}:${String(shifted.getUTCMinutes()).padStart(2, "0")}`,
        dayIndex: Math.floor((ms + KST_OFFSET_MS) / DAY_MS),
    };
}

function parseInstant(value: unknown): number | null {
    if (typeof value !== "string" || !value.trim()) return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/** "10/3(토)", with the year in front only when it differs from now. */
function kstDateLabel(target: ReturnType<typeof kstParts>, now: ReturnType<typeof kstParts>): string {
    const date = `${target.month}/${target.day}(${target.weekday})`;
    return target.year === now.year ? date : `${target.year}년 ${date}`;
}

export type AssignmentDeadlinePresentation = {
    label: string;
    /** "today" deadlines are urgent and render as a warning pill. */
    kind: "today" | "tomorrow" | "week" | "later";
    urgent: boolean;
};

/**
 * KST deadline copy for an open assignment, or null when there is no
 * deadline, either value is unreadable, or the deadline has already passed.
 */
export function formatAssignmentDeadline(endsAt: unknown, now: unknown): AssignmentDeadlinePresentation | null {
    const endMs = parseInstant(endsAt);
    const nowMs = parseInstant(now);
    if (endMs === null || nowMs === null || endMs <= nowMs) return null;
    const end = kstParts(endMs);
    const current = kstParts(nowMs);
    const daysLeft = end.dayIndex - current.dayIndex;
    if (daysLeft <= 0) return { label: `오늘 ${end.time} 마감`, kind: "today", urgent: true };
    if (daysLeft === 1) return { label: `내일 ${end.time} 마감`, kind: "tomorrow", urgent: false };
    if (daysLeft <= 7) {
        return { label: `${kstDateLabel(end, current)} ${end.time} 마감 · D-${daysLeft}`, kind: "week", urgent: false };
    }
    return { label: `${kstDateLabel(end, current)} 마감`, kind: "later", urgent: false };
}

/** KST start moment: "오늘 09:00", "내일 09:00", or "10/3(토) 09:00". Null when unreadable. */
export function formatAssignmentStart(startsAt: unknown, now: unknown): string | null {
    const startMs = parseInstant(startsAt);
    const nowMs = parseInstant(now);
    if (startMs === null || nowMs === null) return null;
    const start = kstParts(startMs);
    const current = kstParts(nowMs);
    const daysAway = start.dayIndex - current.dayIndex;
    const day = daysAway === 0 ? "오늘" : daysAway === 1 ? "내일" : kstDateLabel(start, current);
    return `${day} ${start.time}`;
}

/** KST submission day for a completed card: "10/1". Null when unreadable. */
export function formatSubmittedDate(finishedAt: unknown): string | null {
    const ms = parseInstant(finishedAt);
    if (ms === null) return null;
    const parts = kstParts(ms);
    return `${parts.month}/${parts.day}`;
}

export type TodoHeadline =
    | { kind: "open"; openCount: number; dueTodayCount: number }
    | { kind: "scheduled"; startLabel: string }
    | { kind: "none" };

/** The one-line dashboard greeting under the student's name. */
export function summarizeTodoHeadline(
    presentation: TodoAssignmentPresentation<AssignmentLike>,
    clock: AssignmentClock,
): TodoHeadline {
    if (presentation.open.length > 0) {
        const dueTodayCount = presentation.open
            .filter(exam => formatAssignmentDeadline(assignmentBoundary(exam, "end"), clock.lowerNow)?.kind === "today")
            .length;
        return { kind: "open", openCount: presentation.open.length, dueTodayCount };
    }
    const next = presentation.scheduled[0];
    const startLabel = next ? formatAssignmentStart(assignmentBoundary(next, "start"), clock.lowerNow) : null;
    return startLabel ? { kind: "scheduled", startLabel } : { kind: "none" };
}
