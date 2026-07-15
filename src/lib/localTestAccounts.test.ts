import { describe, expect, it } from "vitest";
import { ROSTER_STORAGE_KEYS } from "./rosterStorage";
import { STUDENT_CODES_STORAGE_KEY } from "./studentCodes";
import {
    LOCAL_TEST_STUDENT_ACCOUNTS,
    LOCAL_TEST_STUDENT_GROUP,
    seedLocalTestStudentAccounts,
} from "./localTestAccounts";

function createStorage(initial: Record<string, string> = {}) {
    const values = { ...initial };
    return {
        values,
        getItem(key: string) {
            return values[key] ?? null;
        },
        setItem(key: string, value: string) {
            values[key] = value;
        },
    };
}

describe("local test accounts", () => {
    it("seeds four login-ready students only when explicitly enabled outside production", () => {
        const storage = createStorage();

        expect(seedLocalTestStudentAccounts(storage, { enabled: true, nodeEnv: "development" })).toEqual({
            seeded: true,
            addedStudents: 4,
        });
        expect(JSON.parse(storage.values[ROSTER_STORAGE_KEYS.students])).toHaveLength(4);
        expect(JSON.parse(storage.values[ROSTER_STORAGE_KEYS.groups])).toEqual([
            expect.objectContaining({ id: LOCAL_TEST_STUDENT_GROUP.id, count: 4 }),
        ]);
        expect(JSON.parse(storage.values[STUDENT_CODES_STORAGE_KEY])).toEqual(Object.fromEntries(
            LOCAL_TEST_STUDENT_ACCOUNTS.map(account => [account.id, account.startCode]),
        ));

        expect(seedLocalTestStudentAccounts(storage, { enabled: true, nodeEnv: "development" })).toEqual({
            seeded: true,
            addedStudents: 0,
        });
        expect(JSON.parse(storage.values[ROSTER_STORAGE_KEYS.students])).toHaveLength(4);
    });

    it("preserves existing roster rows and start codes", () => {
        const existingStudent = {
            id: "existing",
            name: "기존 학생",
            email: "existing@example.com",
            group: "기존반",
            avatar: "#000",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        };
        const storage = createStorage({
            [ROSTER_STORAGE_KEYS.students]: JSON.stringify([existingStudent]),
            [ROSTER_STORAGE_KEYS.groups]: JSON.stringify([]),
            [ROSTER_STORAGE_KEYS.invites]: JSON.stringify([]),
            [STUDENT_CODES_STORAGE_KEY]: JSON.stringify({ student1: "ZZZ999" }),
        });

        seedLocalTestStudentAccounts(storage, { enabled: true, nodeEnv: "test" });

        expect(JSON.parse(storage.values[ROSTER_STORAGE_KEYS.students])).toHaveLength(5);
        expect(JSON.parse(storage.values[STUDENT_CODES_STORAGE_KEY]).student1).toBe("ZZZ999");
    });

    it("never seeds production or an unconfigured development environment", () => {
        const storage = createStorage();

        expect(seedLocalTestStudentAccounts(storage, { enabled: false, nodeEnv: "development" }).seeded).toBe(false);
        expect(seedLocalTestStudentAccounts(storage, { enabled: true, nodeEnv: "production" }).seeded).toBe(false);
        expect(storage.values).toEqual({});
    });
});
