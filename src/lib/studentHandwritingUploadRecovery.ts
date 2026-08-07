import type { StoredDataRef } from "@/types/omr";

export const HANDWRITING_UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const HANDWRITING_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
export const HANDWRITING_UPLOAD_MAX_ATTEMPTS = 3;
export const HANDWRITING_UPLOAD_RETRY_DELAYS_MS = [0, 750, 2_000] as const;

const STORAGE_PREFIX = "omr_handwriting_upload_recovery:";
const MAX_IDENTIFIER_LENGTH = 180;

export type HandwritingUploadFailureCategory =
    | "service_unavailable"
    | "invalid_ticket"
    | "invalid_asset"
    | "source_unavailable";

export interface HandwritingUploadRecoveryManifest {
    version: 1;
    attemptId: string;
    sessionId: string;
    ownerFingerprint: string;
    sourceRef: StoredDataRef;
    createdAt: string;
    expiresAt: string;
    retryCount: number;
    nextRetryAt: string | null;
    failureCategory: HandwritingUploadFailureCategory | null;
}

export type HandwritingUploadOperationResult =
    | { status: "uploaded"; ref?: StoredDataRef }
    | { status: "invalid_ticket" | "invalid_asset" | "service_unavailable" };

type HandwritingUploadFailureResult = Extract<HandwritingUploadOperationResult, { status: Exclude<HandwritingUploadOperationResult["status"], "uploaded"> }>;
type HandwritingUploadRetryResult<T extends HandwritingUploadOperationResult> = (T | HandwritingUploadFailureResult) & { attempts: number };

export type HandwritingUploadRetryProgress =
    | { phase: "waiting"; attempt: number; delayMs: number }
    | { phase: "uploading"; attempt: number; delayMs: 0 }
    | { phase: "succeeded"; attempt: number; delayMs: 0 }
    | { phase: "failed"; attempt: number; delayMs: 0; status: Exclude<HandwritingUploadOperationResult["status"], "uploaded"> };

type DeleteSource = (ref: StoredDataRef) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
    return typeof value === "string"
        && value.length >= 1
        && value.length <= MAX_IDENTIFIER_LENGTH
        && /^[a-zA-Z0-9:_-]+$/.test(value);
}

function validOwnerFingerprint(value: unknown): value is string {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validSourceRef(value: unknown, attemptId: string): value is StoredDataRef {
    if (!isRecord(value)) return false;
    return value.store === "indexeddb"
        && value.key === handwritingUploadSourceKey(attemptId)
        && value.mimeType === "application/json"
        && typeof value.size === "number"
        && Number.isInteger(value.size)
        && value.size > 0
        && value.size <= HANDWRITING_UPLOAD_MAX_BYTES
        && typeof value.updatedAt === "string"
        && Number.isFinite(Date.parse(value.updatedAt));
}

function sanitizeFailureCategory(value: unknown): HandwritingUploadFailureCategory | null {
    if (value === null || value === undefined || value === "") return null;
    if (value === "invalid_ticket" || value === "invalid_asset" || value === "source_unavailable") return value;
    return "service_unavailable";
}

function manifestFromUnknown(value: unknown): HandwritingUploadRecoveryManifest | null {
    if (!isRecord(value)
        || value.version !== 1
        || !validIdentifier(value.attemptId)
        || !validIdentifier(value.sessionId)
        || !validOwnerFingerprint(value.ownerFingerprint)
        || !validSourceRef(value.sourceRef, value.attemptId)
        || typeof value.createdAt !== "string"
        || typeof value.expiresAt !== "string"
        || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isFinite(Date.parse(value.expiresAt))
        || typeof value.retryCount !== "number"
        || !Number.isInteger(value.retryCount)
        || value.retryCount < 0
        || value.retryCount > HANDWRITING_UPLOAD_MAX_ATTEMPTS
        || !(value.nextRetryAt === null || (typeof value.nextRetryAt === "string" && Number.isFinite(Date.parse(value.nextRetryAt))))) {
        return null;
    }
    return {
        version: 1,
        attemptId: value.attemptId,
        sessionId: value.sessionId,
        ownerFingerprint: value.ownerFingerprint,
        sourceRef: value.sourceRef,
        createdAt: value.createdAt,
        expiresAt: value.expiresAt,
        retryCount: value.retryCount,
        nextRetryAt: value.nextRetryAt,
        failureCategory: sanitizeFailureCategory(value.failureCategory),
    };
}

export function handwritingUploadRecoveryStorageKey(attemptId: string): string {
    return `${STORAGE_PREFIX}${attemptId}`;
}

export function isHandwritingUploadRecoveryStorageKey(key: string | null): boolean {
    return typeof key === "string" && key.startsWith(STORAGE_PREFIX);
}

export function handwritingUploadSourceKey(attemptId: string): string {
    return `attempt:${attemptId}:handwriting-upload-source`;
}

export function shouldDeleteHandwritingUploadRecovery(
    status: Exclude<HandwritingUploadOperationResult["status"], "uploaded">,
): boolean {
    return status === "invalid_asset";
}

export async function fingerprintHandwritingUploadOwner(input: {
    examId: string;
    ownerId: string;
}): Promise<string> {
    const examId = input.examId.trim();
    const ownerId = input.ownerId.trim();
    if (!examId || !ownerId || !globalThis.crypto?.subtle) {
        throw new Error("Handwriting recovery owner is unavailable");
    }
    const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`omr-handwriting-recovery-v1\u0000${examId}\u0000${ownerId}`),
    );
    return [...new Uint8Array(digest)]
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

export async function maintainHandwritingUploadRecovery(
    storage: Storage,
    input: { nowMs?: number; deleteSource: DeleteSource },
): Promise<{ expiredCount: number; invalidCount: number }> {
    const nowMs = input.nowMs ?? Date.now();
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
        .filter(isHandwritingUploadRecoveryStorageKey);
    let expiredCount = 0;
    let invalidCount = 0;
    for (const key of keys) {
        if (!key) continue;
        const attemptId = key.slice(STORAGE_PREFIX.length);
        const raw = storage.getItem(key);
        let parsed: HandwritingUploadRecoveryManifest | null = null;
        try {
            parsed = manifestFromUnknown(JSON.parse(raw || "null"));
        } catch {
            parsed = null;
        }
        if (!parsed || parsed.attemptId !== attemptId) {
            if (validIdentifier(attemptId)) {
                try {
                    await input.deleteSource({
                        store: "indexeddb",
                        key: handwritingUploadSourceKey(attemptId),
                        mimeType: "application/json",
                        size: 1,
                        updatedAt: new Date(0).toISOString(),
                    });
                } catch {
                    continue;
                }
            }
            storage.removeItem(key);
            invalidCount += 1;
            continue;
        }
        if (!Number.isFinite(nowMs) || Date.parse(parsed.expiresAt) <= nowMs) {
            try {
                await input.deleteSource(parsed.sourceRef);
            } catch {
                continue;
            }
            storage.removeItem(key);
            expiredCount += 1;
        }
    }
    return { expiredCount, invalidCount };
}

export function persistHandwritingUploadRecovery(
    storage: Storage,
    input: {
        attemptId: string;
        sessionId: string;
        ownerFingerprint: string;
        sourceRef: StoredDataRef;
        failureCategory?: unknown;
    },
    nowMs = Date.now(),
): HandwritingUploadRecoveryManifest | null {
    if (!validIdentifier(input.attemptId)
        || !validIdentifier(input.sessionId)
        || !validOwnerFingerprint(input.ownerFingerprint)
        || !validSourceRef(input.sourceRef, input.attemptId)
        || !Number.isFinite(nowMs)) return null;
    const manifest: HandwritingUploadRecoveryManifest = {
        version: 1,
        attemptId: input.attemptId,
        sessionId: input.sessionId,
        ownerFingerprint: input.ownerFingerprint,
        sourceRef: input.sourceRef,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + HANDWRITING_UPLOAD_TTL_MS).toISOString(),
        retryCount: 0,
        nextRetryAt: null,
        failureCategory: sanitizeFailureCategory(input.failureCategory),
    };
    try {
        storage.setItem(handwritingUploadRecoveryStorageKey(input.attemptId), JSON.stringify(manifest));
        return manifest;
    } catch {
        return null;
    }
}

export function updateHandwritingUploadRecovery(
    storage: Storage,
    manifest: HandwritingUploadRecoveryManifest,
    update: Pick<HandwritingUploadRecoveryManifest, "retryCount" | "nextRetryAt" | "failureCategory">,
): HandwritingUploadRecoveryManifest | null {
    return persistManifest(storage, { ...manifest, ...update });
}

function persistManifest(
    storage: Storage,
    manifest: HandwritingUploadRecoveryManifest,
): HandwritingUploadRecoveryManifest | null {
    const parsed = manifestFromUnknown(manifest);
    if (!parsed) return null;
    try {
        storage.setItem(handwritingUploadRecoveryStorageKey(parsed.attemptId), JSON.stringify(parsed));
        return parsed;
    } catch {
        return null;
    }
}

export async function readHandwritingUploadRecovery(
    storage: Storage,
    input: {
        attemptId: string;
        ownerFingerprint: string;
        nowMs?: number;
        deleteSource: DeleteSource;
    },
): Promise<HandwritingUploadRecoveryManifest | null> {
    if (!validIdentifier(input.attemptId) || !validOwnerFingerprint(input.ownerFingerprint)) return null;
    const key = handwritingUploadRecoveryStorageKey(input.attemptId);
    const raw = storage.getItem(key);
    if (!raw) return null;
    let parsed: HandwritingUploadRecoveryManifest | null = null;
    try {
        parsed = manifestFromUnknown(JSON.parse(raw));
    } catch {
        parsed = null;
    }
    if (!parsed || parsed.attemptId !== input.attemptId) {
        await input.deleteSource({
            store: "indexeddb",
            key: handwritingUploadSourceKey(input.attemptId),
            mimeType: "application/json",
            size: 1,
            updatedAt: new Date(0).toISOString(),
        });
        storage.removeItem(key);
        return null;
    }
    const nowMs = input.nowMs ?? Date.now();
    if (!Number.isFinite(nowMs) || Date.parse(parsed.expiresAt) <= nowMs) {
        await input.deleteSource(parsed.sourceRef);
        storage.removeItem(key);
        return null;
    }
    if (parsed.ownerFingerprint !== input.ownerFingerprint) return null;
    return parsed;
}

export async function clearHandwritingUploadRecovery(
    storage: Storage,
    manifest: HandwritingUploadRecoveryManifest,
    deleteSource: DeleteSource,
): Promise<void> {
    await deleteSource(manifest.sourceRef);
    storage.removeItem(handwritingUploadRecoveryStorageKey(manifest.attemptId));
}

const inFlightRetries = new Map<string, Promise<HandwritingUploadOperationResult & { attempts: number }>>();

export function runHandwritingUploadRecovery<T extends HandwritingUploadOperationResult>(
    attemptId: string,
    operation: () => Promise<T>,
    options: {
        wait?: (delayMs: number) => Promise<void>;
        onProgress?: (progress: HandwritingUploadRetryProgress) => void;
    } = {},
): Promise<HandwritingUploadRetryResult<T>> {
    const existing = inFlightRetries.get(attemptId);
    if (existing) return existing as Promise<HandwritingUploadRetryResult<T>>;
    const wait = options.wait || (delayMs => new Promise(resolve => setTimeout(resolve, delayMs)));
    const execute = async (): Promise<HandwritingUploadRetryResult<T>> => {
        let lastResult: T | HandwritingUploadFailureResult = { status: "service_unavailable" };
        for (let index = 0; index < HANDWRITING_UPLOAD_MAX_ATTEMPTS; index += 1) {
            const attempt = index + 1;
            const delayMs = HANDWRITING_UPLOAD_RETRY_DELAYS_MS[index];
            if (delayMs > 0) {
                options.onProgress?.({ phase: "waiting", attempt, delayMs });
                await wait(delayMs);
            }
            options.onProgress?.({ phase: "uploading", attempt, delayMs: 0 });
            try {
                lastResult = await operation();
            } catch {
                lastResult = { status: "service_unavailable" };
            }
            if (lastResult.status === "uploaded") {
                options.onProgress?.({ phase: "succeeded", attempt, delayMs: 0 });
                return { ...lastResult, attempts: attempt } as HandwritingUploadRetryResult<T>;
            }
            if (lastResult.status === "invalid_ticket" || lastResult.status === "invalid_asset") {
                options.onProgress?.({ phase: "failed", attempt, delayMs: 0, status: lastResult.status });
                return { ...lastResult, attempts: attempt } as HandwritingUploadRetryResult<T>;
            }
        }
        options.onProgress?.({
            phase: "failed",
            attempt: HANDWRITING_UPLOAD_MAX_ATTEMPTS,
            delayMs: 0,
            status: "service_unavailable",
        });
        return { ...lastResult, attempts: HANDWRITING_UPLOAD_MAX_ATTEMPTS } as HandwritingUploadRetryResult<T>;
    };
    const promise = execute().finally(() => {
        if (inFlightRetries.get(attemptId) === promise) inFlightRetries.delete(attemptId);
    });
    inFlightRetries.set(attemptId, promise as Promise<HandwritingUploadOperationResult & { attempts: number }>);
    return promise;
}
