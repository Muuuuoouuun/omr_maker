const LOCK_PREFIX = "omr_storage_lock_v1:";
const LEASE_MS = 15_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const localTails = new Map<string, Promise<void>>();

interface StorageLease {
    token: string;
    expiresAt: number;
}

function storage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function token(): string {
    if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
    return `${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function readLease(target: Storage, key: string): StorageLease | null {
    try {
        const parsed = JSON.parse(target.getItem(key) || "null") as Partial<StorageLease> | null;
        return parsed
            && typeof parsed.token === "string"
            && typeof parsed.expiresAt === "number"
            ? { token: parsed.token, expiresAt: parsed.expiresAt }
            : null;
    } catch {
        return null;
    }
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireStorageLease(name: string): Promise<() => void> {
    const target = storage();
    if (!target) return () => {};
    const key = `${LOCK_PREFIX}${encodeURIComponent(name)}`;
    const owner = token();
    const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

    while (Date.now() < deadline) {
        const now = Date.now();
        const current = readLease(target, key);
        if (!current || current.expiresAt <= now) {
            try {
                target.setItem(key, JSON.stringify({
                    token: owner,
                    expiresAt: now + LEASE_MS,
                } satisfies StorageLease));
                // Let simultaneous contenders publish their claim, then verify
                // that exactly this token remains before entering the section.
                await delay(8);
                if (readLease(target, key)?.token === owner) {
                    const renewal = setInterval(() => {
                        try {
                            if (readLease(target, key)?.token !== owner) return;
                            target.setItem(key, JSON.stringify({
                                token: owner,
                                expiresAt: Date.now() + LEASE_MS,
                            } satisfies StorageLease));
                        } catch {}
                    }, Math.floor(LEASE_MS / 3));
                    return () => {
                        clearInterval(renewal);
                        try {
                            if (readLease(target, key)?.token === owner) target.removeItem(key);
                        } catch {}
                    };
                }
            } catch {
                throw new Error(`Unable to acquire browser storage lock: ${name}`);
            }
        }
        await delay(8 + Math.floor(Math.random() * 8));
    }
    throw new Error(`Timed out acquiring browser storage lock: ${name}`);
}

async function withLeaseAndLocalTail<T>(
    name: string,
    operation: () => Promise<T>,
): Promise<T> {
    const prior = localTails.get(name) || Promise.resolve();
    let releaseTail!: () => void;
    const next = new Promise<void>(resolve => { releaseTail = resolve; });
    const tail = prior.then(() => next);
    localTails.set(name, tail);
    await prior;
    let releaseLease = () => {};
    try {
        releaseLease = await acquireStorageLease(name);
        return await operation();
    } finally {
        releaseLease();
        releaseTail();
        if (localTails.get(name) === tail) localTails.delete(name);
    }
}

export async function withBrowserStorageLock<T>(
    name: string,
    operation: () => Promise<T> | T,
): Promise<T> {
    const run = async () => operation();
    if (typeof navigator !== "undefined" && navigator.locks?.request) {
        return navigator.locks.request(
            `omr-storage:${name}`,
            { mode: "exclusive" },
            run,
        );
    }
    return withLeaseAndLocalTail(name, run);
}
