export type AssignmentLifecycle = "scheduled" | "open" | "closed" | "invalid";

export interface AssignmentLifecycleInput {
    state: unknown;
    startsAt?: unknown;
    endsAt?: unknown;
    now: unknown;
}

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-](\d{2}):(\d{2}))$/;

function leapYear(year: number): boolean {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function validIsoTimestamp(value: unknown): value is string {
    if (typeof value !== "string") return false;
    const match = ISO_TIMESTAMP.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
    const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
    const daysInMonth = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    return month >= 1
        && month <= 12
        && day >= 1
        && day <= daysInMonth[month - 1]
        && hour <= 23
        && minute <= 59
        && second <= 59
        && offsetHour <= 23
        && offsetMinute <= 59
        && Number.isFinite(Date.parse(value));
}

function absent(value: unknown): value is null | undefined {
    return value === null || value === undefined;
}

/** Resolves availability from canonical state and an explicitly supplied server clock. */
export function resolveAssignmentLifecycle(input: AssignmentLifecycleInput): AssignmentLifecycle {
    if (input.state !== "open" && input.state !== "archived") return "invalid";
    if (!validIsoTimestamp(input.now)) return "invalid";
    if (!absent(input.startsAt) && !validIsoTimestamp(input.startsAt)) return "invalid";
    if (!absent(input.endsAt) && !validIsoTimestamp(input.endsAt)) return "invalid";

    const now = Date.parse(input.now);
    const startsAt = absent(input.startsAt) ? null : Date.parse(input.startsAt);
    const endsAt = absent(input.endsAt) ? null : Date.parse(input.endsAt);
    if (startsAt !== null && endsAt !== null && startsAt >= endsAt) return "invalid";
    if (input.state === "archived") return "closed";
    if (startsAt !== null && now < startsAt) return "scheduled";
    if (endsAt !== null && now >= endsAt) return "closed";
    return "open";
}
