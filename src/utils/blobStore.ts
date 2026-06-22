import type { StoredDataRef } from "@/types/omr";

const DB_NAME = "omr-maker";
const DB_VERSION = 1;
const STORE_NAME = "dataUrls";

interface StoredDataRecord {
    key: string;
    dataUrl: string;
    name?: string;
    mimeType?: string;
    size?: number;
    updatedAt: string;
}

function canUseIndexedDb() {
    return typeof window !== "undefined" && "indexedDB" in window;
}

function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: "key" });
            }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function runStore<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
    return openDb().then(db => new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = fn(tx.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
            db.close();
            reject(tx.error);
        };
    }));
}

export function fileToDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

export async function saveFileDataUrl(key: string, file: File): Promise<{
    ref?: StoredDataRef;
    inlineDataUrl?: string;
}> {
    const dataUrl = await fileToDataUrl(file);
    if (!canUseIndexedDb()) return { inlineDataUrl: dataUrl };

    const updatedAt = new Date().toISOString();
    const record: StoredDataRecord = {
        key,
        dataUrl,
        name: file.name,
        mimeType: file.type,
        size: file.size,
        updatedAt,
    };

    await runStore("readwrite", store => store.put(record));
    return {
        ref: {
            store: "indexeddb",
            key,
            name: file.name,
            mimeType: file.type,
            size: file.size,
            updatedAt,
        },
    };
}

export async function loadDataUrl(ref?: StoredDataRef): Promise<string> {
    if (!ref || ref.store !== "indexeddb" || !canUseIndexedDb()) return "";
    const record = await runStore<StoredDataRecord | undefined>("readonly", store => store.get(ref.key));
    return record?.dataUrl || "";
}

export async function deleteStoredData(ref?: StoredDataRef): Promise<void> {
    if (!ref || ref.store !== "indexeddb" || !canUseIndexedDb()) return;
    await runStore("readwrite", store => store.delete(ref.key));
}

export async function copyStoredData(ref: StoredDataRef | undefined, newKey: string): Promise<StoredDataRef | undefined> {
    if (!ref || ref.store !== "indexeddb" || !canUseIndexedDb()) return undefined;
    const record = await runStore<StoredDataRecord | undefined>("readonly", store => store.get(ref.key));
    if (!record) return undefined;

    const updatedAt = new Date().toISOString();
    await runStore("readwrite", store => store.put({ ...record, key: newKey, updatedAt }));

    return {
        ...ref,
        key: newKey,
        updatedAt,
    };
}

export async function resolveStoredDataUrl(inlineDataUrl?: string, ref?: StoredDataRef): Promise<string> {
    if (inlineDataUrl) return inlineDataUrl;
    try {
        return await loadDataUrl(ref);
    } catch {
        return "";
    }
}

export async function storedDataUrlToFile(
    filename: string,
    inlineDataUrl?: string,
    ref?: StoredDataRef,
): Promise<File | null> {
    const dataUrl = await resolveStoredDataUrl(inlineDataUrl, ref);
    if (!dataUrl) return null;
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    return new File([blob], ref?.name || filename, { type: ref?.mimeType || blob.type });
}

/**
 * Saves arbitrary JSON structure to IndexedDB as a base64 DataURL record.
 * This bypasses localStorage size limitations completely.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function saveJsonRecord(key: string, data: any): Promise<StoredDataRef | undefined> {
    if (!canUseIndexedDb()) return undefined;
    try {
        const jsonStr = JSON.stringify(data);
        // Base64 encoding supporting unicode
        const base64Data = btoa(encodeURIComponent(jsonStr).replace(/%([0-9A-F]{2})/g, (_, p1) => {
            return String.fromCharCode(parseInt(p1, 16));
        }));
        const dataUrl = `data:application/json;base64,${base64Data}`;
        const updatedAt = new Date().toISOString();

        const record: StoredDataRecord = {
            key,
            dataUrl,
            mimeType: "application/json",
            size: jsonStr.length,
            updatedAt,
        };

        await runStore("readwrite", store => store.put(record));

        return {
            store: "indexeddb",
            key,
            mimeType: "application/json",
            size: jsonStr.length,
            updatedAt,
        };
    } catch (e) {
        console.error("Failed to save JSON to IndexedDB", e);
        return undefined;
    }
}

/**
 * Loads arbitrary JSON structure from IndexedDB using a StoredDataRef reference.
 */
export async function loadJsonRecord<T>(ref?: StoredDataRef): Promise<T | null> {
    if (!ref || ref.store !== "indexeddb" || !canUseIndexedDb()) return null;
    try {
        const record = await runStore<StoredDataRecord | undefined>("readonly", store => store.get(ref.key));
        if (!record || !record.dataUrl) return null;

        const base64Prefix = "data:application/json;base64,";
        if (record.dataUrl.startsWith(base64Prefix)) {
            const base64Data = record.dataUrl.substring(base64Prefix.length);
            const decoded = decodeURIComponent(Array.prototype.map.call(atob(base64Data), (c) => {
                return "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2);
            }).join(""));
            return JSON.parse(decoded) as T;
        }
        return null;
    } catch (e) {
        console.error("Failed to load JSON from IndexedDB", e);
        return null;
    }
}
