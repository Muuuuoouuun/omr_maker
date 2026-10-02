import { createHash, randomBytes } from "node:crypto";
import {
    EXAM_ENTRY_INVITE_TOKEN_BYTES,
    normalizeExamEntryInviteToken,
} from "@/lib/examEntryInviteTokenContract";
export {
    EXAM_ENTRY_INVITE_TOKEN_BYTES,
    EXAM_ENTRY_INVITE_TOKEN_LENGTH,
    normalizeExamEntryInviteToken,
} from "@/lib/examEntryInviteTokenContract";

export const EXAM_ENTRY_INVITE_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const EXAM_ENTRY_INVITE_MIN_TTL_MS = 15 * 60 * 1000;
export const EXAM_ENTRY_INVITE_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

export function createExamEntryInviteToken(): string {
    return randomBytes(EXAM_ENTRY_INVITE_TOKEN_BYTES).toString("base64url");
}

export function hashExamEntryInviteToken(value: unknown): string | null {
    const token = normalizeExamEntryInviteToken(value);
    return token ? createHash("sha256").update(token, "utf8").digest("hex") : null;
}

export function examEntryInviteExpiry(now = Date.now(), requestedExpiry = now + EXAM_ENTRY_INVITE_DEFAULT_TTL_MS): number {
    if (!Number.isFinite(now)) throw new Error("Invalid invite clock");
    const requested = Number.isFinite(requestedExpiry) ? requestedExpiry : now + EXAM_ENTRY_INVITE_DEFAULT_TTL_MS;
    return Math.min(now + EXAM_ENTRY_INVITE_MAX_TTL_MS, Math.max(now + EXAM_ENTRY_INVITE_MIN_TTL_MS, requested));
}
