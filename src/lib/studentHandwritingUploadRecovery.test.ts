import { describe, expect, it, vi } from "vitest";
import type { StoredDataRef } from "@/types/omr";
import {
    HANDWRITING_UPLOAD_MAX_ATTEMPTS,
    HANDWRITING_UPLOAD_MAX_BYTES,
    HANDWRITING_UPLOAD_RETRY_DELAYS_MS,
    HANDWRITING_UPLOAD_TTL_MS,
    clearHandwritingUploadRecovery,
    fingerprintHandwritingUploadOwner,
    maintainHandwritingUploadRecovery,
    persistHandwritingUploadRecovery,
    readHandwritingUploadRecovery,
    runHandwritingUploadRecovery,
    shouldDeleteHandwritingUploadRecovery,
} from "./studentHandwritingUploadRecovery";

class MemoryStorage implements Storage {
    private readonly values = new Map<string, string>();
    get length() { return this.values.size; }
    clear() { this.values.clear(); }
    getItem(key: string) { return this.values.get(key) ?? null; }
    key(index: number) { return [...this.values.keys()][index] ?? null; }
    removeItem(key: string) { this.values.delete(key); }
    setItem(key: string, value: string) { this.values.set(key, value); }
}

const sourceRef: StoredDataRef = {
    store: "indexeddb",
    key: "attempt:attempt-1:handwriting-upload-source",
    mimeType: "application/json",
    size: 2048,
    updatedAt: "2026-08-07T00:00:00.000Z",
};

async function ownerFingerprint(ownerId = "student-1") {
    return fingerprintHandwritingUploadOwner({ examId: "exam-1", ownerId });
}

describe("student handwriting upload recovery", () => {
    it("persists only bounded identifiers, a fingerprint, source metadata, and sanitized state", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        const manifest = persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
            failureCategory: "server leaked: signed-ticket student name raw drawings",
        }, Date.parse("2026-08-07T00:00:00.000Z"));

        expect(manifest).toMatchObject({
            version: 1,
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            retryCount: 0,
            failureCategory: "service_unavailable",
        });
        expect(manifest?.expiresAt).toBe("2026-08-14T00:00:00.000Z");
        const serialized = JSON.stringify(manifest);
        expect(serialized).not.toMatch(/signed-ticket|student name|raw drawings/);
        expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(HANDWRITING_UPLOAD_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
        expect(HANDWRITING_UPLOAD_MAX_BYTES).toBe(10 * 1024 * 1024);
    });

    it("hides a pending upload from another owner without deleting it", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
        }, 1_000);

        await expect(readHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            ownerFingerprint: await ownerFingerprint("student-2"),
            nowMs: 2_000,
            deleteSource: vi.fn(),
        })).resolves.toBeNull();
        await expect(readHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            ownerFingerprint: fingerprint,
            nowMs: 2_000,
            deleteSource: vi.fn(),
        })).resolves.toMatchObject({ attemptId: "attempt-1" });
    });

    it("deletes expired source data and rejects oversized or non-IndexedDB sources", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        const deleteSource = vi.fn(async () => undefined);
        persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
        }, 1_000);

        await expect(readHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            ownerFingerprint: fingerprint,
            nowMs: 1_000 + HANDWRITING_UPLOAD_TTL_MS + 1,
            deleteSource,
        })).resolves.toBeNull();
        expect(deleteSource).toHaveBeenCalledWith(sourceRef);

        expect(persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-2",
            sessionId: "session-2",
            ownerFingerprint: fingerprint,
            sourceRef: { ...sourceRef, key: "attempt:attempt-2:handwriting-upload-source", size: HANDWRITING_UPLOAD_MAX_BYTES + 1 },
        }, 2_000)).toBeNull();
        expect(persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-3",
            sessionId: "session-3",
            ownerFingerprint: fingerprint,
            sourceRef: { ...sourceRef, store: "localStorage", key: "attempt:attempt-3:handwriting-upload-source" } as unknown as StoredDataRef,
        }, 2_000)).toBeNull();
    });

    it("cleans expired and corrupt manifests during app-wide maintenance", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        const deleteSource = vi.fn(async () => undefined);
        persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
        }, 1_000);
        storage.setItem("omr_handwriting_upload_recovery:attempt-corrupt", "{bad");

        await expect(maintainHandwritingUploadRecovery(storage, {
            nowMs: 1_000 + HANDWRITING_UPLOAD_TTL_MS + 1,
            deleteSource,
        })).resolves.toEqual({ expiredCount: 1, invalidCount: 1 });
        expect(deleteSource).toHaveBeenCalledTimes(2);
        expect(storage.length).toBe(0);
    });

    it("keeps the manifest when source deletion fails and retries on the next maintenance pass", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
        }, 1_000);
        const deleteSource = vi.fn()
            .mockRejectedValueOnce(new Error("IndexedDB temporarily unavailable"))
            .mockResolvedValueOnce(undefined);
        const nowMs = 1_000 + HANDWRITING_UPLOAD_TTL_MS + 1;

        await expect(maintainHandwritingUploadRecovery(storage, { nowMs, deleteSource }))
            .resolves.toEqual({ expiredCount: 0, invalidCount: 0 });
        expect(storage.getItem("omr_handwriting_upload_recovery:attempt-1")).toBeTruthy();
        await expect(maintainHandwritingUploadRecovery(storage, { nowMs, deleteSource }))
            .resolves.toEqual({ expiredCount: 1, invalidCount: 0 });
        expect(storage.length).toBe(0);
        expect(deleteSource).toHaveBeenCalledTimes(2);
    });

    it("enforces expiry cleanup without exposing recovery to a switched account", async () => {
        const storage = new MemoryStorage();
        const originalOwner = await ownerFingerprint();
        const switchedOwner = await ownerFingerprint("student-2");
        const deleteSource = vi.fn(async () => undefined);
        persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: originalOwner,
            sourceRef,
        }, 1_000);

        await expect(readHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            ownerFingerprint: switchedOwner,
            nowMs: 1_000 + HANDWRITING_UPLOAD_TTL_MS + 1,
            deleteSource,
        })).resolves.toBeNull();
        expect(deleteSource).toHaveBeenCalledWith(sourceRef);
        await expect(readHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            ownerFingerprint: originalOwner,
            nowMs: 1_000 + HANDWRITING_UPLOAD_TTL_MS + 2,
            deleteSource,
        })).resolves.toBeNull();
    });

    it("clears the manifest and its single attempt source after success", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        const manifest = persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
        }, 1_000)!;
        const deleteSource = vi.fn(async () => undefined);

        await clearHandwritingUploadRecovery(storage, manifest, deleteSource);

        expect(deleteSource).toHaveBeenCalledWith(sourceRef);
        await expect(readHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            ownerFingerprint: fingerprint,
            nowMs: 2_000,
            deleteSource,
        })).resolves.toBeNull();
    });

    it("does not discard a clear pointer until IndexedDB deletion succeeds", async () => {
        const storage = new MemoryStorage();
        const fingerprint = await ownerFingerprint();
        const manifest = persistHandwritingUploadRecovery(storage, {
            attemptId: "attempt-1",
            sessionId: "session-1",
            ownerFingerprint: fingerprint,
            sourceRef,
        }, 1_000)!;
        const deleteSource = vi.fn(async () => { throw new Error("busy"); });

        await expect(clearHandwritingUploadRecovery(storage, manifest, deleteSource)).rejects.toThrow("busy");
        expect(storage.getItem("omr_handwriting_upload_recovery:attempt-1")).toBeTruthy();
    });

    it("bounds retry backoff and stops after three retryable failures", async () => {
        const operation = vi.fn(async () => ({ status: "service_unavailable" as const }));
        const wait = vi.fn(async (delayMs: number) => { void delayMs; });

        await expect(runHandwritingUploadRecovery("attempt-1", operation, { wait }))
            .resolves.toMatchObject({ status: "service_unavailable", attempts: 3 });

        expect(HANDWRITING_UPLOAD_MAX_ATTEMPTS).toBe(3);
        expect(HANDWRITING_UPLOAD_RETRY_DELAYS_MS).toEqual([0, 750, 2_000]);
        expect(operation).toHaveBeenCalledTimes(3);
        expect(wait.mock.calls.map(([delay]) => delay)).toEqual([750, 2_000]);
    });

    it("does not retry terminal failures", async () => {
        const operation = vi.fn(async () => ({ status: "invalid_ticket" as const }));
        const wait = vi.fn(async (delayMs: number) => { void delayMs; });

        await expect(runHandwritingUploadRecovery("attempt-terminal", operation, { wait }))
            .resolves.toEqual({ status: "invalid_ticket", attempts: 1 });
        expect(wait).not.toHaveBeenCalled();
    });

    it("preserves recoverable auth failures and deletes only invalid assets", () => {
        expect(shouldDeleteHandwritingUploadRecovery("invalid_ticket")).toBe(false);
        expect(shouldDeleteHandwritingUploadRecovery("service_unavailable")).toBe(false);
        expect(shouldDeleteHandwritingUploadRecovery("invalid_asset")).toBe(true);
    });

    it("coalesces concurrent retry clicks for one attempt", async () => {
        let release: (() => void) | undefined;
        const operation = vi.fn(() => new Promise<{ status: "uploaded" }>(resolve => {
            release = () => resolve({ status: "uploaded" });
        }));

        const first = runHandwritingUploadRecovery("attempt-coalesced", operation);
        const second = runHandwritingUploadRecovery("attempt-coalesced", operation);

        expect(second).toBe(first);
        expect(operation).toHaveBeenCalledOnce();
        release?.();
        await expect(first).resolves.toEqual({ status: "uploaded", attempts: 1 });
    });
});
