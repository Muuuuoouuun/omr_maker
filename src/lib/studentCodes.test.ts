import { describe, expect, it } from "vitest";
import {
    findStudentStartCode,
    generateStartCode,
    hasStudentStartCode,
    normalizeStartCodeInput,
    parseStudentCodes,
    resolveStudentIdentity,
    resolveStudentStartCodeLogin,
    STUDENT_CODES_STORAGE_KEY,
    writeStudentCodes,
} from "./studentCodes";

function createStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> & { data: Record<string, string> } {
    const data = { ...initial };
    return {
        data,
        getItem(key: string) {
            return data[key] ?? null;
        },
        setItem(key: string, value: string) {
            data[key] = value;
        },
    };
}

describe("student start codes", () => {
    it("generates unambiguous six-character codes", () => {
        expect(generateStartCode(() => 0)).toBe("AAAAAA");
        expect(generateStartCode(() => 0.999)).toBe("999999");
        expect(normalizeStartCodeInput(" ab 12 c ")).toBe("AB12C");
    });

    it("normalizes valid codes and drops malformed entries", () => {
        expect(parseStudentCodes(JSON.stringify({
            "class-a::김학생": " ab12 ",
            "class-b::이학생": "",
            "class-c::박학생": 123,
        }))).toEqual({
            "class-a::김학생": "AB12",
        });
    });

    it("returns an empty registry for corrupt JSON", () => {
        expect(parseStudentCodes("{not-json")).toEqual({});
        expect(parseStudentCodes(JSON.stringify(["A1"]))).toEqual({});
    });

    it("writes the registry under the canonical storage key", () => {
        const storage = createStorage();

        expect(writeStudentCodes(storage, { "class-a::김학생": "ABC123" })).toBe(true);
        expect(JSON.parse(storage.data[STUDENT_CODES_STORAGE_KEY])).toEqual({ "class-a::김학생": "ABC123" });
    });

    it("requires a student lookup before opening a roster-backed profile", () => {
        expect(resolveStudentIdentity({
            name: " 김학생 ",
            selectedGroupId: "group-a",
            groups: [{ id: "group-a", name: "A반" }],
            students: [{ id: "student-1", name: "김학생", group: "A반" }],
        })).toMatchObject({
            studentId: "student-1",
            matchedRosterProfile: true,
            rosterMatchCount: 1,
            requiresStudentLookup: true,
            lookupMatched: false,
            lookupMismatch: false,
        });
    });

    it("resolves roster profile IDs while preserving the legacy login ID", () => {
        expect(resolveStudentIdentity({
            name: " 김학생 ",
            selectedGroupId: "group-a",
            groups: [{ id: "group-a", name: "A반" }],
            students: [{ id: "student-1", name: "김학생", group: "A반" }],
            studentLookup: "student-1",
        })).toEqual({
            studentId: "student-1",
            legacyStudentId: "group-a::김학생",
            groupId: "group-a",
            groupName: "A반",
            matchedRosterProfile: true,
            rosterMatchCount: 1,
            requiresStudentLookup: false,
            lookupMatched: true,
            lookupMismatch: false,
        });
    });

    it("prefers the roster student in the selected group's region when group names repeat", () => {
        expect(resolveStudentIdentity({
            name: "김학생",
            selectedGroupId: "seoul-a",
            groups: [
                { id: "seoul-a", name: "A반", region: "서울" },
                { id: "busan-a", name: "A반", region: "부산" },
            ],
            students: [
                { id: "busan-a::김학생", name: "김학생", group: "A반", region: "부산" },
                { id: "seoul-a::김학생", name: "김학생", group: "A반", region: "서울" },
            ],
            studentLookup: "seoul-a::김학생",
        })).toEqual({
            studentId: "seoul-a::김학생",
            legacyStudentId: "seoul-a::김학생",
            groupId: "seoul-a",
            groupName: "A반",
            matchedRosterProfile: true,
            rosterMatchCount: 1,
            requiresStudentLookup: false,
            lookupMatched: true,
            lookupMismatch: false,
        });
    });

    it("requires a student lookup when same-name roster profiles share the selected class", () => {
        const base = {
            name: "김학생",
            selectedGroupId: "group-a",
            groups: [{ id: "group-a", name: "A반" }],
            students: [
                { id: "student-1", name: "김학생", group: "A반", email: "first@example.edu" },
                { id: "student-2", name: "김학생", group: "A반", email: "second@example.edu" },
            ],
        };

        expect(resolveStudentIdentity(base)).toMatchObject({
            studentId: "student-1",
            rosterMatchCount: 2,
            requiresStudentLookup: true,
            lookupMatched: false,
            lookupMismatch: false,
        });
        expect(resolveStudentIdentity({ ...base, studentLookup: "second@example.edu" })).toMatchObject({
            studentId: "student-2",
            rosterMatchCount: 2,
            requiresStudentLookup: false,
            lookupMatched: true,
            lookupMismatch: false,
        });
        expect(resolveStudentIdentity({ ...base, studentLookup: "wrong@example.edu" })).toMatchObject({
            rosterMatchCount: 2,
            requiresStudentLookup: true,
            lookupMatched: false,
            lookupMismatch: true,
        });
    });

    it("finds a start code by canonical or legacy student ID", () => {
        const codes = { "legacy::김학생": "ABC123" };

        expect(findStudentStartCode(codes, "student-1", "legacy::김학생")).toBe("ABC123");
        expect(hasStudentStartCode(codes, "student-1", "legacy::김학생")).toBe(true);
    });

    it("issues and stores a new code for a new student", () => {
        expect(resolveStudentStartCodeLogin({
            studentId: "student-1",
            codes: {},
            hasPriorAttempt: false,
            generateCode: () => "ABC123",
        })).toEqual({
            status: "new_code_issued",
            codes: { "student-1": "ABC123" },
            code: "ABC123",
            codesChanged: true,
        });
    });

    it("requires the existing code for returning students with prior attempts", () => {
        const base = {
            studentId: "student-1",
            codes: { "student-1": "ABC123" },
            hasPriorAttempt: true,
        };

        expect(resolveStudentStartCodeLogin(base)).toMatchObject({
            status: "code_required",
            codesChanged: false,
        });
        expect(resolveStudentStartCodeLogin({ ...base, providedCode: "wrong" })).toMatchObject({
            status: "code_mismatch",
            codesChanged: false,
        });
        expect(resolveStudentStartCodeLogin({ ...base, providedCode: "abc123" })).toMatchObject({
            status: "allowed",
            code: "ABC123",
            codesChanged: false,
        });
    });

    it("requires a teacher-issued code even before the first attempt", () => {
        const base = {
            studentId: "student-1",
            codes: { "student-1": "ABC123" },
            hasPriorAttempt: false,
        };

        expect(resolveStudentStartCodeLogin(base)).toMatchObject({
            status: "code_required",
            codesChanged: false,
        });
        expect(resolveStudentStartCodeLogin({ ...base, providedCode: "ABC123" })).toMatchObject({
            status: "allowed",
            code: "ABC123",
            codesChanged: false,
        });
    });

    it("does not auto-issue a start code when prior attempts already exist", () => {
        expect(resolveStudentStartCodeLogin({
            studentId: "student-1",
            codes: {},
            hasPriorAttempt: true,
            generateCode: () => "ABC123",
        })).toEqual({
            status: "code_required",
            codes: {},
            codesChanged: false,
        });
    });

    it("migrates legacy stored codes to the canonical roster student ID", () => {
        expect(resolveStudentStartCodeLogin({
            studentId: "student-1",
            legacyStudentId: "group-a::김학생",
            codes: { "group-a::김학생": "ABC123" },
            hasPriorAttempt: true,
            providedCode: "ABC123",
        })).toEqual({
            status: "allowed",
            codes: {
                "group-a::김학생": "ABC123",
                "student-1": "ABC123",
            },
            code: "ABC123",
            codesChanged: true,
        });
    });
});
