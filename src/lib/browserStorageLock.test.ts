import { afterEach, describe, expect, it, vi } from "vitest";
import { withBrowserStorageLock } from "./browserStorageLock";

function createStorage(): Storage {
    const data = new Map<string, string>();
    return {
        get length() { return data.size; },
        clear() { data.clear(); },
        getItem(key) { return data.get(key) ?? null; },
        key(index) { return [...data.keys()][index] ?? null; },
        removeItem(key) { data.delete(key); },
        setItem(key, value) { data.set(key, value); },
    } as Storage;
}

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
        const localStorage = createStorage();
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("localStorage", localStorage);
        vi.stubGlobal("navigator", {});
        const order: string[] = [];
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });

        const first = withBrowserStorageLock("attempt-index", async () => {
            order.push("first-start");
            await gate;
            order.push("first-end");
        });
        const second = withBrowserStorageLock("attempt-index", async () => {
            order.push("second");
        });
        await vi.waitFor(() => expect(order).toEqual(["first-start"]));
        release();
        await Promise.all([first, second]);
        expect(order).toEqual(["first-start", "first-end", "second"]);
    });

    it("never enters unlocked when a lease write fails and releases the local queue", async () => {
        const localStorage = createStorage();
        const originalSetItem = localStorage.setItem.bind(localStorage);
        let failLeaseWrite = true;
        localStorage.setItem = (key, value) => {
            if (failLeaseWrite && key.startsWith("omr_storage_lock_v1:")) {
                failLeaseWrite = false;
                throw new Error("blocked");
            }
            originalSetItem(key, value);
        };
        vi.stubGlobal("window", { localStorage });
        vi.stubGlobal("navigator", {});
        const operation = vi.fn();

        await expect(withBrowserStorageLock("receipt", async () => operation()))
            .rejects.toThrow("browser storage lock");
        expect(operation).not.toHaveBeenCalled();
        await expect(withBrowserStorageLock("receipt", async () => "recovered"))
            .resolves.toBe("recovered");
    });
});
