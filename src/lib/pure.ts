/**
 * Pure utility functions — stable, side-effect free, unit-testable.
 * Moved here from page modules so tests can import them directly.
 */

// ---------- Hashing ----------
export function hashString(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

export function pickFromList<T>(list: readonly T[], seed: string): T {
    if (list.length === 0) throw new Error("pickFromList: empty list");
    return list[hashString(seed) % list.length];
}

// ---------- CSV ----------
/** RFC4180-ish escaping for a single cell. */
export function csvEscape(value: string): string {
    return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function toCsv(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
    const lines: string[] = [headers.join(",")];
    for (const row of rows) {
        lines.push(row.map(csvEscape).join(","));
    }
    return lines.join("\n");
}

// ---------- Email validation ----------
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(s: string): boolean {
    return EMAIL_RE.test(s.trim());
}

// ---------- Group stats ----------
export interface GroupShape { name: string; count: number; avgScore: number }
export interface StudentShape { group: string; avgScore: number }

export function recomputeGroupStats<G extends GroupShape, S extends StudentShape>(
    students: readonly S[],
    groups: readonly G[]
): G[] {
    return groups.map(g => {
        const inGroup = students.filter(s => s.group === g.name);
        const count = inGroup.length;
        const avgScore = count > 0
            ? Math.round(inGroup.reduce((sum, s) => sum + s.avgScore, 0) / count)
            : 0;
        return { ...g, count, avgScore };
    });
}

// ---------- Attempt → Student progress ----------
export type StudentStatus = "submitted" | "in_progress" | "not_started";

export function countAnswered(answers: Record<number, number> | undefined): number {
    if (!answers) return 0;
    let c = 0;
    for (const k in answers) {
        const v = answers[k];
        if (v !== undefined && v !== null && v !== 0) c++;
    }
    return c;
}

export function mapAttemptStatus(s: string | undefined): StudentStatus {
    if (s === "completed") return "submitted";
    if (s === "in_progress") return "in_progress";
    return "not_started";
}

export function computeProgress(status: StudentStatus, answered: number, totalQ: number): number {
    if (status === "submitted") return 100;
    if (status === "in_progress" && totalQ > 0) return Math.round((answered / totalQ) * 100);
    return 0;
}

// ---------- Time greeting ----------
export function getTimeGreeting(hour: number): "late-night" | "morning" | "afternoon" | "evening" {
    if (hour < 6) return "late-night";
    if (hour < 12) return "morning";
    if (hour < 18) return "afternoon";
    return "evening";
}

// ---------- Stable display formatting ----------
const KOREAN_TIME_ZONE = "Asia/Seoul";

const koreanDateFormatter = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: KOREAN_TIME_ZONE,
});

const koreanDateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
    timeZone: KOREAN_TIME_ZONE,
});

function parseDisplayDate(value: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

export function formatKoreanDate(value: string): string {
    return parseDisplayDate(value) ? koreanDateFormatter.format(new Date(value)) : value;
}

export function formatKoreanDateTime(value: string): string {
    // Empty/whitespace input has no meaningful date to show — render nothing
    // rather than an empty-looking dash. Non-empty but unparseable input
    // (corrupt timestamp) falls back to "-" instead of leaking the raw string.
    if (typeof value !== "string" || !value.trim()) return "";
    if (!parseDisplayDate(value)) return "-";

    return koreanDateTimeFormatter
        .format(new Date(value))
        .replace("AM", "오전")
        .replace("PM", "오후");
}

// ---------- Plan display ----------
export function formatLimit(n: number): string {
    return n === Infinity ? "∞" : n.toLocaleString();
}

export function usagePct(used: number, total: number): number {
    if (total === Infinity || total <= 0) return 0;
    return Math.min(100, Math.round((used / total) * 100));
}

// ---------- OMR layout ----------
function normalizeColumns(columns: number | undefined, maxColumns = 3): number {
    if (!Number.isFinite(columns)) return 1;
    return Math.min(Math.max(Math.floor(columns || 1), 1), maxColumns);
}

export function splitQuestionsIntoColumns<T>(items: readonly T[], columns: number): T[][] {
    if (items.length === 0) return [];

    const columnCount = Math.min(normalizeColumns(columns), items.length);
    const itemsPerColumn = Math.ceil(items.length / columnCount);

    return Array.from({ length: columnCount }, (_, columnIndex) => {
        const start = columnIndex * itemsPerColumn;
        return items.slice(start, start + itemsPerColumn);
    });
}

export function getCardViewGridMetrics(
    totalItems: number,
    columns = 1,
): { columns: number; rows: number } {
    if (totalItems <= 0) return { columns: 1, rows: 0 };

    const columnCount = Math.min(normalizeColumns(columns), totalItems);
    return {
        columns: columnCount,
        rows: Math.ceil(totalItems / columnCount),
    };
}
