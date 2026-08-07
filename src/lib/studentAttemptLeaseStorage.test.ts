import { describe, expect, it } from "vitest";
import {
    clearDurableAttemptResumeCredential,
    durableAttemptResumeKey,
    readDurableAttemptResumeCredential,
    writeDurableAttemptResumeCredential,
} from "./studentAttemptLeaseStorage";

function memoryStorage() {
    const values = new Map<string, string>();
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
}

describe("durable attempt same-tab resume credentials", () => {
    it("scopes a ticket and lease to actor, exam, and attempt mode", () => {
        const storage = memoryStorage();
        const key = durableAttemptResumeKey("exam-1", "student-1", "base");
        expect(writeDurableAttemptResumeCredential(storage, key, { ticket: "ticket-1", leaseToken: "lease-1" })).toBe(true);
        expect(readDurableAttemptResumeCredential(storage, key)).toEqual({ ticket: "ticket-1", leaseToken: "lease-1" });
        expect(readDurableAttemptResumeCredential(storage, durableAttemptResumeKey("exam-1", "student-2", "base"))).toBeNull();
        clearDurableAttemptResumeCredential(storage, key);
        expect(readDurableAttemptResumeCredential(storage, key)).toBeNull();
    });

    it("fails closed for malformed or oversized credentials", () => {
        const storage = memoryStorage();
        storage.setItem("bad", JSON.stringify({ ticket: "x".repeat(32_769), leaseToken: "lease" }));
        expect(readDurableAttemptResumeCredential(storage, "bad")).toBeNull();
    });
});
