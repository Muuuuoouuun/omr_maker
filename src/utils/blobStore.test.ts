import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteStoredData } from "./blobStore";

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("blobStore IndexedDB transaction durability", () => {
    it("does not resolve on request success and rejects when the transaction later aborts", async () => {
        const key = "draft:problemPdf";
        const records = new Map([[key, { key, dataUrl: "data:application/pdf;base64,QQ==" }]]);
        let abortTransaction!: () => void;
        const db = {
            objectStoreNames: { contains: () => true },
            createObjectStore: vi.fn(),
            close: vi.fn(),
            transaction: () => {
                const transaction: {
                    error: Error | null;
                    oncomplete: (() => void) | null;
                    onerror: (() => void) | null;
                    onabort: (() => void) | null;
                    objectStore: () => { delete: (recordKey: string) => IDBRequest<undefined> };
                } = {
                    error: null,
                    oncomplete: null,
                    onerror: null,
                    onabort: null,
                    objectStore: () => ({
                        delete: recordKey => {
                            const previous = records.get(recordKey);
                            const request = { result: undefined, onsuccess: null, onerror: null } as unknown as IDBRequest<undefined>;
                            queueMicrotask(() => {
                                records.delete(recordKey);
                                request.onsuccess?.({} as Event);
                            });
                            abortTransaction = () => {
                                if (previous) records.set(recordKey, previous);
                                transaction.error = new Error("transaction aborted after request success");
                                transaction.onabort?.();
                            };
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

        let settled = false;
        const deletion = deleteStoredData({ store: "indexeddb", key }).finally(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);
        expect(records.has(key)).toBe(false);

        abortTransaction();
        await expect(deletion).rejects.toThrow("transaction aborted");
        expect(records.has(key)).toBe(true);
        expect(db.close).toHaveBeenCalledOnce();
    });
});
