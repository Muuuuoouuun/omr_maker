import { describe, expect, it } from "vitest";
import {
    findStudentStartCode,
    generateStartCode,
    hasStudentStartCode,
    normalizeRosterNameForComparison,
    normalizeStartCodeInput,
    parseStudentCodes,
    resolveLocalRosterNameGuard,
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

    it("resolves a roster profile by lookup when no class is selected", () => {
        expect(resolveStudentIdentity({
            name: "김학생",
            selectedGroupId: "",
            groups: [{ id: "class-a", name: "A반" }],
            students: [{ id: "class-a::김학생", name: "김학생", group: "A반", email: "kim@example.edu" }],
            studentLookup: "kim@example.edu",
        })).toEqual({
            studentId: "class-a::김학생",
            legacyStudentId: "class-a::김학생",
            groupId: "class-a",
            groupName: "A반",
            matchedRosterProfile: true,
            rosterMatchCount: 1,
            requiresStudentLookup: false,
            lookupMatched: true,
            lookupMismatch: false,
        });
    });

    it("requires lookup when class is omitted and same-name roster profiles exist", () => {
        const base = {
            name: "김학생",
            selectedGroupId: "",
            groups: [
                { id: "class-a", name: "A반" },
                { id: "class-b", name: "B반" },
            ],
            students: [
                { id: "class-a::김학생", name: "김학생", group: "A반", email: "first@example.edu" },
                { id: "class-b::김학생", name: "김학생", group: "B반", email: "second@example.edu" },
            ],
        };

        expect(resolveStudentIdentity(base)).toMatchObject({
            rosterMatchCount: 2,
            requiresStudentLookup: true,
            lookupMatched: false,
            lookupMismatch: false,
        });
        expect(resolveStudentIdentity({ ...base, studentLookup: "second@example.edu" })).toMatchObject({
            studentId: "class-b::김학생",
            groupId: "class-b",
            groupName: "B반",
            requiresStudentLookup: false,
            lookupMatched: true,
            lookupMismatch: false,
        });
    });

    it("falls back to an unassigned temporary identity when no class data exists", () => {
        expect(resolveStudentIdentity({
            name: "신규학생",
            selectedGroupId: "",
            groups: [],
            students: [],
        })).toEqual({
            studentId: "unassigned::신규학생",
            legacyStudentId: "unassigned::신규학생",
            groupId: "unassigned",
            groupName: "미분류",
            matchedRosterProfile: false,
            rosterMatchCount: 0,
            requiresStudentLookup: false,
            lookupMatched: false,
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

describe("local roster name guard", () => {
    const group = { id: "class-a", name: "A반", region: "서울" };
    const roster = [
        { id: "s-1", name: "김 학생", group: "A반", region: "서울" },
        { id: "s-2", name: "이학생", group: "A반", region: "서울" },
        { id: "s-3", name: "박학생", group: "B반", region: "서울" },
    ];

    it("normalizes NFC, removes every whitespace character and lowercases", () => {
        const decomposed = "김학생".normalize("NFD");
        expect(decomposed).not.toBe("김학생");
        expect(normalizeRosterNameForComparison(` ${decomposed} `)).toBe("김학생");
        expect(normalizeRosterNameForComparison("김\u3000학\u00a0생\t")).toBe("김학생");
        expect(normalizeRosterNameForComparison("Kim Student")).toBe("kimstudent");
    });

    it("lets an exact roster name through", () => {
        expect(resolveLocalRosterNameGuard({ name: " 김 학생 ", group, students: roster })).toEqual({ status: "matched" });
        expect(resolveLocalRosterNameGuard({ name: "이학생", group, students: roster })).toEqual({ status: "matched" });
    });

    it("stops an unmatched name and suggests the roster spelling", () => {
        expect(resolveLocalRosterNameGuard({ name: "김학생", group, students: roster })).toEqual({
            status: "unmatched_in_roster",
            suggestion: "김 학생",
        });
        expect(resolveLocalRosterNameGuard({ name: "KIM student", group, students: [{ id: "k", name: "Kim Student", group: "A반" }] }))
            .toEqual({ status: "unmatched_in_roster", suggestion: "Kim Student" });
    });

    it("stops an unmatched name without a suggestion when nothing normalizes the same", () => {
        // 박학생 is on another class's roster, so it is not suggested here.
        expect(resolveLocalRosterNameGuard({ name: "박학생", group, students: roster })).toEqual({ status: "unmatched_in_roster" });
        expect(resolveLocalRosterNameGuard({ name: "최학생", group, students: roster })).toEqual({ status: "unmatched_in_roster" });
    });

    it("keeps the old path when the selected class has no roster", () => {
        expect(resolveLocalRosterNameGuard({ name: "김학생", group: { id: "class-c", name: "C반" }, students: roster }))
            .toEqual({ status: "no_roster_for_group" });
        expect(resolveLocalRosterNameGuard({ name: "김학생", group: undefined, students: roster }))
            .toEqual({ status: "no_roster_for_group" });
        expect(resolveLocalRosterNameGuard({ name: "김학생", group, students: [] }))
            .toEqual({ status: "no_roster_for_group" });
    });

    it("does not suggest when different roster names normalize the same", () => {
        const ambiguous = [
            { id: "a-1", name: "김 학생", group: "A반" },
            { id: "a-2", name: "김학 생", group: "A반" },
        ];
        expect(resolveLocalRosterNameGuard({ name: "김학생", group, students: ambiguous })).toEqual({ status: "unmatched_in_roster" });
    });

    it("still suggests a single spelling shared by same-name roster students", () => {
        const sameName = [
            { id: "a-1", name: "김 학생", group: "A반" },
            { id: "a-2", name: "김 학생", group: "A반" },
        ];
        expect(resolveLocalRosterNameGuard({ name: "김학생", group, students: sameName })).toEqual({
            status: "unmatched_in_roster",
            suggestion: "김 학생",
        });
    });

    it("matches roster students scoped by group id", () => {
        const scoped = [{ id: "class-a::김 학생", name: "김 학생" }];
        expect(resolveLocalRosterNameGuard({ name: "김학생", group, students: scoped })).toEqual({
            status: "unmatched_in_roster",
            suggestion: "김 학생",
        });
    });
});
