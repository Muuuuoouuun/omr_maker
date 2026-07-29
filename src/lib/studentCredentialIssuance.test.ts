import { describe, expect, it } from "vitest";
import { withStudentCredentialIssuanceLock } from "./studentCredentialIssuance";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(next => { resolve = next; });
    return { promise, resolve };
}

describe("student credential issuance lock", () => {
    it("starts only one same-student operation in the same tick", async () => {
        const locks = new Set<string>();
        const firstGate = deferred<string>();
        let calls = 0;

        const first = withStudentCredentialIssuanceLock(locks, "student-1", async () => {
            calls += 1;
            return firstGate.promise;
        });
        const duplicate = withStudentCredentialIssuanceLock(locks, "student-1", async () => {
            calls += 1;
            return "duplicate";
        });

        await expect(duplicate).resolves.toEqual({ started: false });
        expect(calls).toBe(1);
        firstGate.resolve("first");
        await expect(first).resolves.toEqual({ started: true, value: "first" });
        expect(locks.size).toBe(0);
    });

    it("keeps reversed deferred responses scoped to their student", async () => {
        const locks = new Set<string>();
        const firstGate = deferred<string>();
        const secondGate = deferred<string>();
        const first = withStudentCredentialIssuanceLock(locks, "student-1", () => firstGate.promise);
        const second = withStudentCredentialIssuanceLock(locks, "student-2", () => secondGate.promise);

        secondGate.resolve("student-2-result");
        await expect(second).resolves.toEqual({ started: true, value: "student-2-result" });
        firstGate.resolve("student-1-result");
        await expect(first).resolves.toEqual({ started: true, value: "student-1-result" });
        expect(locks.size).toBe(0);
    });
});
