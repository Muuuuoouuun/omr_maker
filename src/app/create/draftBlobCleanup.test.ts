import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredDataRef } from "@/types/omr";
import { deleteStoredData, loadDataUrl } from "@/utils/blobStore";
import { deleteScopedDraftPdfAssets, retryPendingScopedDraftPdfCleanup } from "./createPageHelpers";

type FakeRecord = { key: string; dataUrl: string };

function installIndexedDb(records: Map<string, FakeRecord>, failDeleteKeys = new Set<string>()) {
    const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore: vi.fn(),
        close: vi.fn(),
        transaction: () => {
            const transaction: {
                oncomplete: (() => void) | null;
                onerror: (() => void) | null;
                error: null;
                objectStore: () => {
                    get: (key: string) => IDBRequest<FakeRecord | undefined>;
                    delete: (key: string) => IDBRequest<undefined>;
                };
            } = {
                oncomplete: null,
                onerror: null,
                error: null,
                objectStore: () => ({
                    get: key => {
                        const request = { result: undefined, onsuccess: null, onerror: null } as unknown as IDBRequest<FakeRecord | undefined>;
                        queueMicrotask(() => {
                            Object.defineProperty(request, "result", { value: records.get(key), configurable: true });
                            request.onsuccess?.({} as Event);
                            transaction.oncomplete?.();
                        });
                        return request;
                    },
                    delete: key => {
                        const request = { result: undefined, onsuccess: null, onerror: null } as unknown as IDBRequest<undefined>;
                        queueMicrotask(() => {
                            if (failDeleteKeys.has(key)) {
                                request.onerror?.({} as Event);
                                return;
                            }
                            records.delete(key);
                            request.onsuccess?.({} as Event);
                            transaction.oncomplete?.();
                        });
                        return request;
                    },
                }),
            };
            return transaction as unknown as IDBTransaction;
        },
    };
    const indexedDb = {
        open: () => {
            const request = { result: undefined, onsuccess: null, onerror: null, onupgradeneeded: null } as unknown as IDBOpenDBRequest;
            queueMicrotask(() => {
                Object.defineProperty(request, "result", { value: db, configurable: true });
                request.onsuccess?.({} as Event);
            });
            return request;
        },
    };
    vi.stubGlobal("window", { indexedDB: indexedDb });
    vi.stubGlobal("indexedDB", indexedDb);
}

function indexedRef(key: string): StoredDataRef {
    return { store: "indexeddb", key, mimeType: "application/pdf" };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("scoped draft IndexedDB cleanup", () => {
    it("lets A delete its own two blobs but prevents B from looking up or deleting A blobs", async () => {
        const teacherA = "omr_exam_draft:workspace:org-1:teacher-a:new";
        const teacherB = "omr_exam_draft:workspace:org-1:teacher-b:new";
        const problemRef = indexedRef(`${teacherA}:problemPdf`);
        const answerRef = indexedRef(`${teacherA}:answerKeyPdf`);
        const records = new Map<string, FakeRecord>([
            [problemRef.key, { key: problemRef.key, dataUrl: "data:application/pdf;base64,QQ==" }],
            [answerRef.key, { key: answerRef.key, dataUrl: "data:application/pdf;base64,Qg==" }],
        ]);
        installIndexedDb(records);

        await expect(deleteScopedDraftPdfAssets({
            draft: { pdfDataRef: problemRef, answerKeyPdfRef: answerRef },
            scopedDraftKey: teacherB,
            deleteStoredData,
        })).resolves.toEqual({ expected: 0, deleted: 0, failed: 0 });
        await expect(loadDataUrl(problemRef)).resolves.not.toBe("");
        await expect(loadDataUrl(answerRef)).resolves.not.toBe("");

        await expect(deleteScopedDraftPdfAssets({
            draft: { pdfDataRef: problemRef, answerKeyPdfRef: answerRef },
            scopedDraftKey: teacherA,
            deleteStoredData,
        })).resolves.toEqual({ expected: 2, deleted: 2, failed: 0 });
        await expect(loadDataUrl(problemRef)).resolves.toBe("");
        await expect(loadDataUrl(answerRef)).resolves.toBe("");
    });

    it("deletes a replaced owned blob unless the new draft still preserves the same ref", async () => {
        const teacherA = "omr_exam_draft:workspace:org-1:teacher-a:new";
        const problemRef = indexedRef(`${teacherA}:problemPdf`);
        const records = new Map<string, FakeRecord>([
            [problemRef.key, { key: problemRef.key, dataUrl: "data:application/pdf;base64,QQ==" }],
        ]);
        installIndexedDb(records);

        await expect(deleteScopedDraftPdfAssets({
            draft: { pdfDataRef: problemRef },
            scopedDraftKey: teacherA,
            preserve: { pdfDataRef: problemRef },
            deleteStoredData,
        })).resolves.toEqual({ expected: 0, deleted: 0, failed: 0 });
        await expect(loadDataUrl(problemRef)).resolves.not.toBe("");

        await expect(deleteScopedDraftPdfAssets({
            draft: { pdfDataRef: problemRef },
            scopedDraftKey: teacherA,
            preserve: {},
            deleteStoredData,
        })).resolves.toEqual({ expected: 1, deleted: 1, failed: 0 });
        await expect(loadDataUrl(problemRef)).resolves.toBe("");
    });

    it("reports a delete request error and preserves the blob for a retry", async () => {
        const teacherA = "omr_exam_draft:workspace:org-1:teacher-a:new";
        const problemRef = indexedRef(`${teacherA}:problemPdf`);
        const records = new Map<string, FakeRecord>([
            [problemRef.key, { key: problemRef.key, dataUrl: "data:application/pdf;base64,QQ==" }],
        ]);
        installIndexedDb(records, new Set([problemRef.key]));

        await expect(deleteScopedDraftPdfAssets({
            draft: { pdfDataRef: problemRef },
            scopedDraftKey: teacherA,
            deleteStoredData,
        })).resolves.toEqual({ expected: 1, deleted: 0, failed: 1 });
        await expect(loadDataUrl(problemRef)).resolves.not.toBe("");
    });

    it("keeps cleanupPending and the draft body after failure, then removes both on retry", async () => {
        const teacherA = "omr_exam_draft:workspace:org-1:teacher-a:new";
        const markerKey = `${teacherA}:cleanupPending`;
        const problemRef = indexedRef(`${teacherA}:problemPdf`);
        const records = new Map<string, FakeRecord>([
            [problemRef.key, { key: problemRef.key, dataUrl: "data:application/pdf;base64,QQ==" }],
        ]);
        const failDeleteKeys = new Set([problemRef.key]);
        installIndexedDb(records, failDeleteKeys);
        const values = new Map<string, string>([
            [teacherA, JSON.stringify({ pdfDataRef: problemRef })],
            [markerKey, JSON.stringify({ removeDraftBody: true })],
        ]);
        const storage = {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => { values.set(key, value); },
            removeItem: (key: string) => { values.delete(key); },
        };

        await expect(retryPendingScopedDraftPdfCleanup({
            storage,
            scopedDraftKey: teacherA,
            deleteStoredData,
        })).resolves.toMatchObject({ status: "failed", cleanup: { failed: 1 } });
        expect(storage.getItem(teacherA)).not.toBeNull();
        expect(storage.getItem(markerKey)).not.toBeNull();
        await expect(loadDataUrl(problemRef)).resolves.not.toBe("");

        failDeleteKeys.clear();
        await expect(retryPendingScopedDraftPdfCleanup({
            storage,
            scopedDraftKey: teacherA,
            deleteStoredData,
        })).resolves.toMatchObject({ status: "cleaned", cleanup: { deleted: 1, failed: 0 } });
        expect(storage.getItem(teacherA)).toBeNull();
        expect(storage.getItem(markerKey)).toBeNull();
        await expect(loadDataUrl(problemRef)).resolves.toBe("");
    });
});
