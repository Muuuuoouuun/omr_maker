import { describe, expect, it } from "vitest";
import { buildRosterCsvImportPlan, mapRosterCsvHeader } from "./rosterCsvImport";
import type { RosterGroup, RosterStudent } from "./rosterStorage";

function makeStudent(overrides: Partial<RosterStudent> = {}): RosterStudent {
    return {
        id: "g-1::홍길동",
        name: "홍길동",
        email: "hong@example.com",
        group: "3학년 A반",
        avatar: "#4f46e5",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "방금 전",
        trend: "flat",
        status: "active",
        ...overrides,
    };
}

function makeGroup(overrides: Partial<RosterGroup> = {}): RosterGroup {
    return {
        id: "g-1",
        name: "3학년 A반",
        region: "서울",
        count: 0,
        avgScore: 0,
        color: "#4f46e5",
        ...overrides,
    };
}

const HEADER = ["name", "email", "group", "region"];

describe("mapRosterCsvHeader", () => {
    it("locates required and optional columns case-insensitively", () => {
        expect(mapRosterCsvHeader(["ID", " Name ", "EMAIL", "group", "지역"])).toEqual({
            idIdx: 0,
            nameIdx: 1,
            emailIdx: 2,
            groupIdx: 3,
            regionIdx: 4,
        });
    });

    it("returns -1 for a missing region column", () => {
        expect(mapRosterCsvHeader(["name", "email", "group"]).regionIdx).toBe(-1);
    });
});

describe("buildRosterCsvImportPlan", () => {
    it("flags empty input", () => {
        const plan = buildRosterCsvImportPlan([HEADER], [], []);
        expect(plan.ok).toBe(false);
        expect(plan.error).toBe("empty");
    });

    it("flags a header missing required columns", () => {
        const plan = buildRosterCsvImportPlan([["name", "group"], ["김", "A반"]], [], []);
        expect(plan.ok).toBe(false);
        expect(plan.error).toBe("header");
    });

    it("adds a new student and creates its group with a deterministic id", () => {
        const plan = buildRosterCsvImportPlan(
            [HEADER, ["김민준", "kim@example.com", "1학년 A반", "부산"]],
            [],
            [],
            { now: 1234 },
        );

        expect(plan.ok).toBe(true);
        expect(plan.adds).toHaveLength(1);
        expect(plan.createdGroups).toHaveLength(1);
        expect(plan.createdGroups[0].id).toBe("g-1234-1");
        expect(plan.createdGroups[0].region).toBe("부산");
        expect(plan.adds[0]).toMatchObject({ line: 2, name: "김민준", group: "1학년 A반", region: "부산" });
        expect(plan.adds[0].id).toBe("g-1234-1::김민준");
        expect(plan.hasChanges).toBe(true);
        // Input arrays are untouched; the new student rides on nextStudents.
        expect(plan.nextStudents).toHaveLength(1);
    });

    it("updates an existing student matched by email with a field-level diff", () => {
        const existing = makeStudent({ id: "g-1::홍길동", email: "hong@example.com", group: "3학년 A반", region: "서울" });
        const plan = buildRosterCsvImportPlan(
            [HEADER, ["홍길순", "hong@example.com", "3학년 B반", "서울"]],
            [existing],
            [makeGroup(), makeGroup({ id: "g-2", name: "3학년 B반", region: "서울" })],
        );

        expect(plan.updates).toHaveLength(1);
        expect(plan.adds).toHaveLength(0);
        const update = plan.updates[0];
        expect(update.matchedBy).toBe("email");
        expect(update.id).toBe("g-1::홍길동");
        expect(update.changes).toEqual([
            { field: "name", from: "홍길동", to: "홍길순" },
            { field: "group", from: "3학년 A반", to: "3학년 B반" },
        ]);
        // The updated record keeps its id.
        expect(plan.nextStudents.find(s => s.id === "g-1::홍길동")?.name).toBe("홍길순");
    });

    it("treats an id-column collision with a different email as a conflict, added as a new student", () => {
        const existing = makeStudent({ id: "s-100", name: "기존학생", email: "existing@example.com" });
        const plan = buildRosterCsvImportPlan(
            [["id", ...HEADER], ["s-100", "새학생", "new@example.com", "3학년 A반", "서울"]],
            [existing],
            [makeGroup()],
        );

        expect(plan.updates).toHaveLength(0);
        expect(plan.conflicts).toHaveLength(1);
        expect(plan.conflicts[0]).toMatchObject({
            importedId: "s-100",
            name: "새학생",
            existingName: "기존학생",
            existingEmail: "existing@example.com",
        });
        // The unrelated existing student is left untouched.
        expect(plan.nextStudents.find(s => s.id === "s-100")?.name).toBe("기존학생");
        // The new student got a distinct id, not s-100.
        expect(plan.conflicts[0].id).not.toBe("s-100");
    });

    it("updates by id when the id matches and the email also matches", () => {
        const existing = makeStudent({ id: "s-200", name: "옛이름", email: "same@example.com", region: "서울" });
        const plan = buildRosterCsvImportPlan(
            [["id", ...HEADER], ["s-200", "새이름", "same@example.com", "3학년 A반", "서울"]],
            [existing],
            [makeGroup()],
        );

        expect(plan.conflicts).toHaveLength(0);
        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].matchedBy).toBe("id");
        expect(plan.updates[0].changes).toEqual([{ field: "name", from: "옛이름", to: "새이름" }]);
    });

    it("skips rows with missing fields or an invalid email", () => {
        const plan = buildRosterCsvImportPlan(
            [
                HEADER,
                ["", "blank@example.com", "A반", "서울"],
                ["이름만", "not-an-email", "A반", "서울"],
            ],
            [],
            [],
        );

        expect(plan.adds).toHaveLength(0);
        expect(plan.skips).toEqual([
            expect.objectContaining({ line: 2, reason: "missing-fields" }),
            expect.objectContaining({ line: 3, reason: "invalid-email" }),
        ]);
        expect(plan.hasChanges).toBe(false);
    });

    it("does not wipe a stored region when the region cell is blank on update", () => {
        const existing = makeStudent({ id: "g-1::홍길동", email: "hong@example.com", region: "서울" });
        const plan = buildRosterCsvImportPlan(
            [HEADER, ["홍길동", "hong@example.com", "3학년 A반", ""]],
            [existing],
            [makeGroup()],
        );

        expect(plan.updates).toHaveLength(1);
        expect(plan.updates[0].changes).toHaveLength(0); // nothing changes
        expect(plan.nextStudents.find(s => s.id === "g-1::홍길동")?.region).toBe("서울");
        expect(plan.hasChanges).toBe(false);
    });

    it("back-fills a region onto a previously region-less group", () => {
        const regionless = makeGroup({ id: "g-x", name: "공통반", region: undefined });
        const plan = buildRosterCsvImportPlan(
            [HEADER, ["학생", "s@example.com", "공통반", "대전"]],
            [],
            [regionless],
        );

        expect(plan.createdGroups).toHaveLength(0);
        expect(plan.nextGroups.find(g => g.id === "g-x")?.region).toBe("대전");
    });

    it("reports no changes when every row is skipped", () => {
        const plan = buildRosterCsvImportPlan(
            [HEADER, ["", "", "", ""]],
            [makeStudent()],
            [makeGroup()],
        );

        expect(plan.ok).toBe(true);
        expect(plan.hasChanges).toBe(false);
        expect(plan.skips).toHaveLength(1);
    });
});
