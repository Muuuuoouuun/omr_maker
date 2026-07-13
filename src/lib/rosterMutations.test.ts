import { describe, expect, it } from "vitest";
import { addRosterGroup, addRosterStudent, deleteRosterGroup, editRosterGroup } from "./rosterMutations";
import { scopedGroupKeyForStudentId, type RosterGroup, type RosterStudent } from "./rosterStorage";

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

describe("addRosterGroup", () => {
    it("creates a new group and keeps its id free of '::' so scoped student ids stay clean", () => {
        const result = addRosterGroup([], [], { name: "1학년 B반", region: "부산" }, { id: "g-100" });

        expect(result.ok).toBe(true);
        expect(result.group).toMatchObject({ id: "g-100", name: "1학년 B반", region: "부산", count: 0 });
        expect(result.group?.id).not.toContain("::");
        expect(result.groups).toHaveLength(1);
    });

    it("assigns a rotating palette color when none is provided", () => {
        const result = addRosterGroup([], [makeGroup()], { name: "신규반" }, { id: "g-2" });

        expect(result.ok).toBe(true);
        expect(result.group?.color).toBeTruthy();
    });

    it("rejects a blank name", () => {
        const result = addRosterGroup([], [], { name: "   " });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("missing-name");
        expect(result.groups).toHaveLength(0);
    });

    it("de-duplicates by region-scoped name and returns the existing group", () => {
        const existing = makeGroup({ id: "g-existing", name: "공통반", region: "서울" });
        const result = addRosterGroup([], [existing], { name: " 공통반 ", region: "서울" });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("duplicate");
        expect(result.group?.id).toBe("g-existing");
        expect(result.groups).toHaveLength(1);
    });

    it("treats the same name in a different region as a distinct group", () => {
        const seoul = makeGroup({ id: "g-seoul", name: "공통반", region: "서울" });
        const result = addRosterGroup([], [seoul], { name: "공통반", region: "부산" }, { id: "g-busan" });

        expect(result.ok).toBe(true);
        expect(result.groups).toHaveLength(2);
    });
});

describe("addRosterStudent", () => {
    const group = makeGroup({ id: "g-class", name: "3학년 A반", region: "서울" });

    it("adds a student scoped to the selected group and recomputes the count", () => {
        const result = addRosterStudent([], [group], {
            name: "홍길동",
            email: "hong@example.com",
            groupId: "g-class",
        });

        expect(result.ok).toBe(true);
        expect(result.student).toMatchObject({ name: "홍길동", group: "3학년 A반", region: "서울" });
        expect(scopedGroupKeyForStudentId(result.student?.id)).toBe("g-class");
        expect(result.groups.find(g => g.id === "g-class")?.count).toBe(1);
    });

    it("rejects an invalid email", () => {
        const result = addRosterStudent([], [group], { name: "홍길동", email: "not-an-email", groupId: "g-class" });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("invalid-email");
    });

    it("rejects when the target group is missing", () => {
        const result = addRosterStudent([], [group], { name: "홍길동", email: "hong@example.com", groupId: "ghost" });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("missing-group");
    });

    it("rejects a duplicate email", () => {
        const existing: RosterStudent = {
            id: "g-class::기존",
            name: "기존",
            email: "dupe@example.com",
            group: "3학년 A반",
            region: "서울",
            avatar: "#4f46e5",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "방금 전",
            trend: "flat",
            status: "active",
        };
        const result = addRosterStudent([existing], [group], {
            name: "신규",
            email: "DUPE@example.com",
            groupId: "g-class",
        });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("duplicate");
        expect(result.students).toHaveLength(1);
    });

    it("disambiguates the id when two different students share a name in one group", () => {
        const first = addRosterStudent([], [group], { name: "김철수", email: "kim1@example.com", groupId: "g-class" });
        const second = addRosterStudent(first.students, first.groups, {
            name: "김철수",
            email: "kim2@example.com",
            groupId: "g-class",
        });

        expect(first.ok).toBe(true);
        expect(second.ok).toBe(true);
        expect(second.student?.id).not.toBe(first.student?.id);
        expect(second.groups.find(g => g.id === "g-class")?.count).toBe(2);
    });
});

describe("editRosterGroup", () => {
    const group = makeGroup({ id: "g-class", name: "A반", region: "서울", count: 1 });
    const student: RosterStudent = {
        id: "g-class::김학생",
        name: "김학생",
        email: "kim@example.com",
        group: "A반",
        region: "서울",
        avatar: "#4f46e5",
        avgScore: 92,
        examsTaken: 2,
        lastActive: "방금 전",
        trend: "up",
        status: "active",
    };

    it("renames a group, updates member display scope, and preserves student ids", () => {
        const result = editRosterGroup([student], [group], "g-class", {
            name: "A반 심화",
            region: "온라인",
            color: "#10b981",
        });

        expect(result.ok).toBe(true);
        expect(result.group).toMatchObject({ id: "g-class", name: "A반 심화", region: "온라인", color: "#10b981", count: 1 });
        expect(result.students[0]).toMatchObject({ id: "g-class::김학생", group: "A반 심화", region: "온라인" });
    });

    it("rejects a duplicate region-scoped group name", () => {
        const duplicate = makeGroup({ id: "g-other", name: "B반", region: "서울" });
        const result = editRosterGroup([], [group, duplicate], "g-class", { name: "B반", region: "서울" });

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("duplicate");
        expect(result.group?.id).toBe("g-other");
    });
});

describe("deleteRosterGroup", () => {
    const emptyGroup = makeGroup({ id: "g-empty", name: "빈 반", region: "서울" });
    const nonEmptyGroup = makeGroup({ id: "g-class", name: "A반", region: "서울", count: 1 });
    const student: RosterStudent = {
        id: "g-class::김학생",
        name: "김학생",
        email: "kim@example.com",
        group: "A반",
        region: "서울",
        avatar: "#4f46e5",
        avgScore: 0,
        examsTaken: 0,
        lastActive: "방금 전",
        trend: "flat",
        status: "active",
    };

    it("deletes an empty group", () => {
        const result = deleteRosterGroup([], [emptyGroup], "g-empty");

        expect(result.ok).toBe(true);
        expect(result.groups).toEqual([]);
    });

    it("keeps groups that still have students", () => {
        const result = deleteRosterGroup([student], [nonEmptyGroup], "g-class");

        expect(result.ok).toBe(false);
        expect(result.reason).toBe("not-empty");
        expect(result.studentCount).toBe(1);
        expect(result.groups).toHaveLength(1);
    });
});
