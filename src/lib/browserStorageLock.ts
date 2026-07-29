const LOCK_DATABASE = "omr_storage_locks_v2";
const LOCK_STORE = "leases";
const LEASE_MS = 30_000;
const RENEW_INTERVAL_MS = 5_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 12;

interface StoredLease {
    name: string;
    token: string;
    expiresAt: number;
}

export interface BrowserLeaseBackend {
    claim(name: string, token: string, expiresAt: number): Promise<boolean>;
    renew(name: string, token: string, expiresAt: number): Promise<boolean>;
    release(name: string, token: string): Promise<void>;
}

interface BrowserStorageLockOptions {
    leaseBackend?: BrowserLeaseBackend;
    webLocks?: LockManager | null;
}

type BrowserStorageLock = <T>(
    name: string,
    operation: () => Promise<T> | T,
) => Promise<T>;

class IndexedDbLeaseBackend implements BrowserLeaseBackend {
    private databasePromise: Promise<IDBDatabase> | null = null;

    private database(): Promise<IDBDatabase> {
        if (this.databasePromise) return this.databasePromise;
        this.databasePromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === "undefined") {
                reject(new Error("IndexedDB is unavailable"));
                return;
            }
            let settled = false;
            const request = indexedDB.open(LOCK_DATABASE, 1);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(LOCK_STORE)) {
                    request.result.createObjectStore(LOCK_STORE, { keyPath: "name" });
                }
            };
            request.onsuccess = () => {
                settled = true;
                resolve(request.result);
            };
            request.onerror = () => {
                settled = true;
                reject(request.error || new Error("Unable to open browser lock database"));
            };
            request.onblocked = () => {
                if (!settled) reject(new Error("Browser lock database upgrade is blocked"));
            };
        });
        return this.databasePromise;
    }

    async claim(name: string, token: string, expiresAt: number): Promise<boolean> {
        const database = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(LOCK_STORE, "readwrite");
            const store = transaction.objectStore(LOCK_STORE);
            const request = store.get(name) as IDBRequest<StoredLease | undefined>;
            let claimed = false;
            request.onsuccess = () => {
                const current = request.result;
                if (!current || current.expiresAt <= Date.now() || current.token === token) {
                    store.put({ name, token, expiresAt } satisfies StoredLease);
                    claimed = true;
                }
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(claimed);
            transaction.onabort = () => reject(transaction.error || request.error || new Error("IndexedDB claim aborted"));
            transaction.onerror = () => reject(transaction.error || new Error("IndexedDB claim failed"));
        });
    }

    async renew(name: string, token: string, expiresAt: number): Promise<boolean> {
        const database = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(LOCK_STORE, "readwrite");
            const store = transaction.objectStore(LOCK_STORE);
            const request = store.get(name) as IDBRequest<StoredLease | undefined>;
            let renewed = false;
            request.onsuccess = () => {
                if (request.result?.token === token) {
                    store.put({ name, token, expiresAt } satisfies StoredLease);
                    renewed = true;
                }
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve(renewed);
            transaction.onabort = () => reject(transaction.error || request.error || new Error("IndexedDB renewal aborted"));
            transaction.onerror = () => reject(transaction.error || new Error("IndexedDB renewal failed"));
        });
    }

    async release(name: string, token: string): Promise<void> {
        const database = await this.database();
        return new Promise((resolve, reject) => {
            const transaction = database.transaction(LOCK_STORE, "readwrite");
            const store = transaction.objectStore(LOCK_STORE);
            const request = store.get(name) as IDBRequest<StoredLease | undefined>;
            request.onsuccess = () => {
                if (request.result?.token === token) store.delete(name);
            };
            request.onerror = () => transaction.abort();
            transaction.oncomplete = () => resolve();
            transaction.onabort = () => reject(transaction.error || request.error || new Error("IndexedDB release aborted"));
            transaction.onerror = () => reject(transaction.error || new Error("IndexedDB release failed"));
        });
    }
}

function lockToken(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function lockError(name: string, error: unknown): Error {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    return new Error(`Unable to acquire browser storage lock "${name}"${detail}`);
}

async function acquireLease(
    backend: BrowserLeaseBackend,
    name: string,
): Promise<() => Promise<void>> {
    const owner = lockToken();
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

    while (Date.now() < deadline) {
        let claimed: boolean;
        try {
            claimed = await backend.claim(name, owner, Date.now() + LEASE_MS);
        } catch (error) {
            throw lockError(name, error);
        }
        if (claimed) {
            let renewalRunning = false;
            const renewal = setInterval(() => {
                if (renewalRunning) return;
                renewalRunning = true;
                void backend.renew(name, owner, Date.now() + LEASE_MS)
                    .catch(() => false)
                    .finally(() => {
                        renewalRunning = false;
                    });
            }, RENEW_INTERVAL_MS);
            return async () => {
                clearInterval(renewal);
                try {
                    await backend.release(name, owner);
                } catch {
                    // The token expires, so release failure cannot transfer
                    // ownership to a different context.
                }
            };
        }
        await delay(RETRY_INTERVAL_MS);
    }
    throw lockError(name, new Error("timed out"));
}

export function createBrowserStorageLock(
    options: BrowserStorageLockOptions = {},
): BrowserStorageLock {
    const localTails = new Map<string, Promise<void>>();
    const leaseBackend = options.leaseBackend || new IndexedDbLeaseBackend();

    return async <T>(name: string, operation: () => Promise<T> | T): Promise<T> => {
        const webLocks = options.webLocks === undefined
            ? (typeof navigator !== "undefined" ? navigator.locks : undefined)
            : options.webLocks;
        if (webLocks?.request) {
            return webLocks.request(
                `omr-storage:${name}`,
                { mode: "exclusive" },
                async () => operation(),
            );
        }

        const prior = localTails.get(name) || Promise.resolve();
        let releaseTail!: () => void;
        const next = new Promise<void>(resolve => {
            releaseTail = resolve;
        });
        const tail = prior.then(() => next);
        localTails.set(name, tail);
        await prior;
        let releaseLease: (() => Promise<void>) | null = null;
        try {
            releaseLease = await acquireLease(leaseBackend, name);
            return await operation();
        } finally {
            if (releaseLease) await releaseLease();
            releaseTail();
            if (localTails.get(name) === tail) localTails.delete(name);
        }
    };
}

export const withBrowserStorageLock = createBrowserStorageLock();
