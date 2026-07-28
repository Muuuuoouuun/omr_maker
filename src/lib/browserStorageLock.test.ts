import { afterEach, describe, expect, it, vi } from "vitest";
import {
    createBrowserStorageLock,
    type BrowserLeaseBackend,
    withBrowserStorageLock,
} from "./browserStorageLock";

afterEach(() => vi.unstubAllGlobals());

describe("browser storage cross-tab lock", () => {
    it("uses a named exclusive Web Lock when supported", async () => {
        const request = vi.fn(async (
            _name: string,
            _options: object,
            operation: () => Promise<string>,
        ) => operation());
        vi.stubGlobal("navigator", { locks: { request } });

        await expect(withBrowserStorageLock("receipt", async () => "done"))
            .resolves.toBe("done");
        expect(request).toHaveBeenCalledWith(
            "omr-storage:receipt",
            { mode: "exclusive" },
            expect.any(Function),
        );
    });

    it("serializes same-browser fallback operations with a storage lease", async () => {
        let owner: string | null = null;
        const backend: BrowserLeaseBackend = {
            claim: async (_name, token) => {
                if (owner && owner !== token) return false;
                owner = token;
                return true;
            },
            renew: async (_name, token) => owner === token,
            release: async (_name, token) => {
                if (owner === token) owner = null;
            },
        };
        const withLock = createBrowserStorageLock({ leaseBackend: backend, webLocks: null });
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });

        const first = withLock("attempt-index", async () => {
            order.push("first-start");
            await gate;
            order.push("first-end");
        });
        const second = withLock("attempt-index", async () => {
            order.push("second");
        });
        await vi.waitFor(() => expect(order).toEqual(["first-start"]));
        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });

    it("never enters unlocked when a backend claim fails and releases the local queue", async () => {
        let failClaim = true;
        const backend: BrowserLeaseBackend = {
            claim: async () => {
                if (failClaim) {
                    failClaim = false;
                    throw new Error("blocked");
                }
                return true;
            },
            renew: async () => true,
            release: async () => {},
        };
        const withLock = createBrowserStorageLock({ leaseBackend: backend, webLocks: null });
        const operation = vi.fn();

        await expect(withLock("receipt", async () => operation()))
            .rejects.toThrow("browser storage lock");
        expect(operation).not.toHaveBeenCalled();
        await expect(withLock("receipt", async () => "recovered"))
            .resolves.toBe("recovered");
    });

    it("keeps two fallback contexts mutually exclusive after both observe an empty lease", async () => {
        let lease: { token: string; expiresAt: number } | null = null;
        let claimArrivals = 0;
        let releaseInitialClaims!: () => void;
        const initialClaims = new Promise<void>(resolve => {
            releaseInitialClaims = resolve;
        });
        const backend: BrowserLeaseBackend = {
            claim: async (_name, token, expiresAt) => {
                const observedEmpty = !lease;
                claimArrivals += 1;
                if (claimArrivals === 2) releaseInitialClaims();
                if (observedEmpty && claimArrivals <= 2) await initialClaims;
                if (!lease || lease.expiresAt <= Date.now()) {
                    lease = { token, expiresAt };
                    return true;
                }
                return lease.token === token;
            },
            renew: async (_name, token, expiresAt) => {
                if (lease?.token !== token) return false;
                lease = { token, expiresAt };
                return true;
            },
            release: async (_name, token) => {
                if (lease?.token === token) lease = null;
            },
        };
        const lockA = createBrowserStorageLock({ leaseBackend: backend, webLocks: null });
        const lockB = createBrowserStorageLock({ leaseBackend: backend, webLocks: null });
        let concurrent = 0;
        let maxConcurrent = 0;
        const criticalSection = async () => {
            concurrent += 1;
            maxConcurrent = Math.max(maxConcurrent, concurrent);
            await new Promise(resolve => setTimeout(resolve, 12));
            concurrent -= 1;
        };

        await Promise.all([
            lockA("attempt-index", criticalSection),
            lockB("attempt-index", criticalSection),
        ]);

        expect(claimArrivals).toBeGreaterThanOrEqual(3);
        expect(maxConcurrent).toBe(1);
    });

    it("fails cleanly without running the operation when the fallback backend is unavailable", async () => {
        const backend: BrowserLeaseBackend = {
            claim: async () => {
                throw new DOMException("quota", "QuotaExceededError");
            },
            renew: async () => false,
            release: async () => {},
        };
        const withLock = createBrowserStorageLock({ leaseBackend: backend, webLocks: null });
        const operation = vi.fn();

        await expect(withLock("attempt-index", operation))
            .rejects.toThrow("browser storage lock");
        expect(operation).not.toHaveBeenCalled();
    });
});
