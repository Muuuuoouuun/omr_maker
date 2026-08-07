export const EXAM_ENTRY_INVITE_TOKEN_BYTES = 32;
export const EXAM_ENTRY_INVITE_TOKEN_LENGTH = 43;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function normalizeExamEntryInviteToken(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const token = value.trim();
    return TOKEN_PATTERN.test(token) ? token : null;
}
