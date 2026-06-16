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

    it("resolves roster profile IDs while preserving the legacy login ID", () => {
        expect(resolveStudentIdentity({
            name: " 김학생 ",
            selectedGroupId: "group-a",
            groups: [{ id: "group-a", name: "A반" }],
            students: [{ id: "student-1", name: "김학생", group: "A반" }],
        })).toEqual({
            studentId: "student-1",
            legacyStudentId: "group-a::김학생",
            groupId: "group-a",
            groupName: "A반",
            matchedRosterProfile: true,
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
        })).toEqual({
            studentId: "seoul-a::김학생",
            legacyStudentId: "seoul-a::김학생",
            groupId: "seoul-a",
            groupName: "A반",
            matchedRosterProfile: true,
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
