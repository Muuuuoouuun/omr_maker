export interface CanonicalCollectionMeta {
    organizationId: string;
    loadedAt: string;
    rawCount: number;
    parsedCount: number;
}

const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|\+00:00)$/;

function canonicalUtcTimestampParts(value: unknown): { normalized: string; microsecondKey: string } | null {
    if (typeof value !== "string" || value.trim() !== value) return null;
    const match = UTC_TIMESTAMP_PATTERN.exec(value);
    if (!match) return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    const parsed = new Date(timestamp);
    const [, year, month, day, hour, minute, second, fraction = ""] = match;
    if (
        parsed.getUTCFullYear() !== Number(year)
        || parsed.getUTCMonth() + 1 !== Number(month)
        || parsed.getUTCDate() !== Number(day)
        || parsed.getUTCHours() !== Number(hour)
        || parsed.getUTCMinutes() !== Number(minute)
        || parsed.getUTCSeconds() !== Number(second)
    ) return null;
    return {
        normalized: parsed.toISOString(),
        microsecondKey: `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(6, "0")}Z`,
    };
}

export function normalizeCanonicalUtcTimestamp(value: unknown): string {
    return canonicalUtcTimestampParts(value)?.normalized || "";
}

export function canonicalUtcTimestampMicrosecondKey(value: unknown): string {
    return canonicalUtcTimestampParts(value)?.microsecondKey || "";
}
