import { normalizeExamEntryInviteToken } from "@/lib/examEntryInviteTokenContract";

const STORAGE_KEY = "omr_exam_entry_invite_handoff_v1";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MIN_TTL_MS = 15 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;

interface SessionStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

type Handoff = {
    examId: string;
    token: string;
    expiresAt: number;
    accountKey?: string;
};

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function remove(storage: SessionStorageLike): void {
    try { storage.removeItem(STORAGE_KEY); } catch { /* fail closed */ }
}

function parse(storage: SessionStorageLike): Handoff | null {
    try {
        const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null") as Partial<Handoff> | null;
        const examId = clean(value?.examId);
        const token = normalizeExamEntryInviteToken(value?.token);
        const expiresAt = Number(value?.expiresAt);
        const accountKey = clean(value?.accountKey) || undefined;
        if (!examId || !token || !Number.isFinite(expiresAt)) return null;
        return { examId, token, expiresAt, accountKey };
    } catch {
        return null;
    }
}

export function captureExamEntryInviteFragment(input: {
    examId: string;
    hash: string;
    pathname: string;
    search: string;
    storage: SessionStorageLike;
    replaceUrl: (url: string) => void;
    now?: number;
    ttlMs?: number;
}): string | null {
    const fragment = input.hash.startsWith("#") ? input.hash.slice(1) : input.hash;
    const params = new URLSearchParams(fragment);
    if (!params.has("invite")) return null;
    // Scrub before doing any network work. Fragments do not reach the server,
    // and this removes them from screenshots, copied addresses and referrers.
    input.replaceUrl(`${input.pathname}${input.search}`);
    const examId = clean(input.examId);
    const token = normalizeExamEntryInviteToken(params.get("invite"));
    if (!examId || !token) {
        remove(input.storage);
        return null;
    }
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    const requestedTtl = Number.isFinite(input.ttlMs) ? Number(input.ttlMs) : DEFAULT_TTL_MS;
    const ttlMs = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, requestedTtl));
    try {
        input.storage.setItem(STORAGE_KEY, JSON.stringify({ examId, token, expiresAt: now + ttlMs }));
        return token;
    } catch {
        remove(input.storage);
        return null;
    }
}

export function readExamEntryInviteHandoff(
    storage: SessionStorageLike,
    examIdValue: unknown,
    now = Date.now(),
    accountKeyValue?: unknown,
): string | null {
    const handoff = parse(storage);
    const examId = clean(examIdValue);
    const accountKey = clean(accountKeyValue) || undefined;
    if (!handoff || !examId || handoff.examId !== examId || handoff.expiresAt <= now
        || (handoff.accountKey && handoff.accountKey !== accountKey)) {
        remove(storage);
        return null;
    }
    if (accountKey && !handoff.accountKey) {
        try { storage.setItem(STORAGE_KEY, JSON.stringify({ ...handoff, accountKey })); }
        catch { remove(storage); return null; }
    }
    return handoff.token;
}

export function clearExamEntryInviteHandoff(storage: SessionStorageLike): void {
    remove(storage);
}
