import { describe, expect, it } from "vitest";
import {
    buildStudentReturnHint,
    clearStudentReturnHint,
    parseStudentReturnHint,
    readStudentReturnHint,
    refreshStudentReturnHint,
    saveStudentReturnHint,
    STUDENT_RETURN_HINT_STORAGE_KEY,
    STUDENT_RETURN_HINT_TTL_MS,
} from "./studentReturnHint";

function memoryStorage(initial: Record<string, string> = {}) {
    const data = { ...initial };
    return {
        data,
        getItem: (key: string) => data[key] ?? null,
        setItem: (key: string, value: string) => { data[key] = value; },
        removeItem: (key: string) => { delete data[key]; },
    };
}

const NOW = Date.parse("2026-10-02T09:00:00.000Z");
const session = {
    studentId: "class-a::김학생",
    loginId: "kim.student@example.com",
    name: " 김학생 ",
    groupId: "class-a",
    groupName: "A반",
    regionId: "서울",
    regionName: "서울",
    isGuest: false,
    identityType: "temporary" as const,
    startCode: "ABC234",
    inviteToken: "secret-invite",
};

describe("student return hint", () => {
    it("stores only name, class and region — never ids, lookup, codes or tokens", () => {
        const storage = memoryStorage();
        expect(saveStudentReturnHint(session, storage, NOW)).toBe(true);
        const raw = storage.data[STUDENT_RETURN_HINT_STORAGE_KEY];
        expect(JSON.parse(raw)).toEqual({
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            regionName: "서울",
            savedAt: new Date(NOW).toISOString(),
        });
        for (const secret of ["kim.student@example.com", "ABC234", "secret-invite", "class-a::김학생", "temporary"]) {
            expect(raw).not.toContain(secret);
        }
    });

    it("reads a stored hint back within 30 days", () => {
        const storage = memoryStorage();
        saveStudentReturnHint(session, storage, NOW);
        expect(readStudentReturnHint(storage, NOW + STUDENT_RETURN_HINT_TTL_MS - 1)).toMatchObject({
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
        });
    });

    it("drops the hint after 30 days", () => {
        const storage = memoryStorage();
        saveStudentReturnHint(session, storage, NOW);
        expect(readStudentReturnHint(storage, NOW + STUDENT_RETURN_HINT_TTL_MS + 1)).toBeNull();
        expect(storage.data[STUDENT_RETURN_HINT_STORAGE_KEY]).toBeUndefined();
    });

    it("rejects corrupt, future-dated or incomplete hints", () => {
        expect(parseStudentReturnHint("{oops", NOW)).toBeNull();
        expect(parseStudentReturnHint(JSON.stringify({ name: "김학생", groupId: "class-a", savedAt: "nope" }), NOW)).toBeNull();
        expect(parseStudentReturnHint(JSON.stringify({ name: "김학생", groupId: "class-a", savedAt: new Date(NOW + 60_000).toISOString() }), NOW)).toBeNull();
        expect(parseStudentReturnHint(JSON.stringify({ name: "", groupId: "class-a", savedAt: new Date(NOW).toISOString() }), NOW)).toBeNull();
        const storage = memoryStorage({ [STUDENT_RETURN_HINT_STORAGE_KEY]: "[]" });
        expect(readStudentReturnHint(storage, NOW)).toBeNull();
        expect(storage.data[STUDENT_RETURN_HINT_STORAGE_KEY]).toBeUndefined();
    });

    it("strips unknown fields when parsing", () => {
        const raw = JSON.stringify({ name: "김학생", groupId: "class-a", groupName: "A반", savedAt: new Date(NOW).toISOString(), startCode: "ABC234" });
        expect(parseStudentReturnHint(raw, NOW)).toEqual({
            name: "김학생",
            groupId: "class-a",
            groupName: "A반",
            savedAt: new Date(NOW).toISOString(),
        });
    });

    it("never builds a hint for guests or sessions without a class", () => {
        expect(buildStudentReturnHint({ ...session, isGuest: true }, NOW)).toBeNull();
        expect(buildStudentReturnHint({ name: "김학생" }, NOW)).toBeNull();
        const storage = memoryStorage();
        expect(saveStudentReturnHint({ ...session, isGuest: true }, storage, NOW)).toBe(false);
        expect(storage.data).toEqual({});
    });

    it("refreshes only a hint the student already opted into", () => {
        const storage = memoryStorage();
        expect(refreshStudentReturnHint(session, storage, NOW)).toBe(false);
        expect(storage.data).toEqual({});

        saveStudentReturnHint(session, storage, NOW);
        expect(refreshStudentReturnHint({ ...session, groupName: "A반(새 이름)" }, storage, NOW + 1_000)).toBe(true);
        expect(readStudentReturnHint(storage, NOW + 1_000)).toMatchObject({ groupName: "A반(새 이름)" });
    });

    it("clears the hint and tolerates blocked storage", () => {
        const storage = memoryStorage();
        saveStudentReturnHint(session, storage, NOW);
        clearStudentReturnHint(storage);
        expect(storage.data).toEqual({});

        const blocked = {
            getItem: () => { throw new Error("blocked"); },
            setItem: () => { throw new Error("blocked"); },
            removeItem: () => { throw new Error("blocked"); },
        };
        expect(readStudentReturnHint(blocked, NOW)).toBeNull();
        expect(saveStudentReturnHint(session, blocked, NOW)).toBe(false);
        expect(() => clearStudentReturnHint(blocked)).not.toThrow();
        expect(readStudentReturnHint(null, NOW)).toBeNull();
    });
});
