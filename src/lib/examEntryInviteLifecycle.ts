export type ExamEntryInviteCapability =
    | "copyable_here"
    | "active_but_raw_unavailable"
    | "expired"
    | "revoked";

export interface ExamEntryInviteMetadata {
    inviteId: string;
    examId: string;
    targetType: "groups" | "individuals" | "public";
    targetIds: string[];
    generation: number;
    issuedAt: string;
    expiresAt: string;
    revokedAt: string | null;
}

export interface ExamEntryInviteRawUrlState {
    url: string;
    examId: string;
    generation: number;
    issuedAt: string;
}

interface ResolveInviteCapabilityInput {
    metadata: ExamEntryInviteMetadata;
    rawUrl: ExamEntryInviteRawUrlState | null;
    now: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isGeneration(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function isSafeWebUrl(value: unknown): value is string {
    if (!isNonEmptyString(value)) return false;
    try {
        const parsed = new URL(value);
        return (parsed.protocol === "http:" || parsed.protocol === "https:")
            && parsed.username === ""
            && parsed.password === "";
    } catch {
        return false;
    }
}

function hasValidMetadataFields(metadata: Record<string, unknown>, now: number, expiresAt: number): boolean {
    const issuedAt = parseTimestamp(metadata.issuedAt);
    return isNonEmptyString(metadata.inviteId)
        && isNonEmptyString(metadata.examId)
        && (metadata.targetType === "groups"
            || metadata.targetType === "individuals"
            || metadata.targetType === "public")
        && Array.isArray(metadata.targetIds)
        && metadata.targetIds.every(isNonEmptyString)
        && isGeneration(metadata.generation)
        && issuedAt !== null
        && issuedAt <= now
        && issuedAt < expiresAt;
}

function hasMatchingRawUrl(
    rawUrl: unknown,
    metadata: Record<string, unknown>,
    now: number,
): rawUrl is ExamEntryInviteRawUrlState {
    if (!isRecord(rawUrl)) return false;
    const issuedAt = parseTimestamp(rawUrl.issuedAt);
    return isSafeWebUrl(rawUrl.url)
        && isNonEmptyString(rawUrl.examId)
        && isGeneration(rawUrl.generation)
        && issuedAt !== null
        && issuedAt <= now
        && rawUrl.examId === metadata.examId
        && rawUrl.generation === metadata.generation;
}

export function resolveInviteCapability(
    input: ResolveInviteCapabilityInput,
): ExamEntryInviteCapability {
    const metadata: unknown = input.metadata;
    if (!isRecord(metadata)) return "revoked";

    if (metadata.revokedAt !== null) return "revoked";

    const expiresAt = parseTimestamp(metadata.expiresAt);
    if (!Number.isFinite(input.now) || expiresAt === null || input.now >= expiresAt) return "expired";

    if (!hasValidMetadataFields(metadata, input.now, expiresAt)) return "active_but_raw_unavailable";

    return hasMatchingRawUrl(input.rawUrl, metadata, input.now)
        ? "copyable_here"
        : "active_but_raw_unavailable";
}
