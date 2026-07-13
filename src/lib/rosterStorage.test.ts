import { describe, expect, it } from "vitest";
import {
    disambiguateRosterStudentId,
    hasStoredRosterData,
    parseStoredRosterGroups,
    parseStoredRosterInvites,
    parseStoredRosterStudents,
    readRosterStudents,
    rosterGroupMatchesStudent,
    type RosterStudent,
} from "./rosterStorage";

function createStorage(values: Record<string, string>): Pick<Storage, "getItem"> {
    return {
        getItem(key: string) {
            return values[key] ?? null;
        },
    };
}

describe("roster storage", () => {
    it("normalizes partially corrupt student roster rows", () => {
        const students = parseStoredRosterStudents(JSON.stringify([
            { id: "s-1", name: " 김학생 ", email: "KIM@SCHOOL.KR", group: " A반 ", region: " 서울 ", avgScore: 110, examsTaken: "3", trend: "bad", status: "weird" },
            { id: "bad-no-name", email: "missing@school.kr" },
            null,
        ]));

        expect(students).toEqual([
            expect.objectContaining({
                id: "s-1",
                name: "김학생",
                email: "KIM@SCHOOL.KR",
                group: "A반",
                region: "서울",
                avgScore: 100,
                examsTaken: 3,
                trend: "flat",
                status: "active",
            }),
        ]);
    });

    it("uses region-scoped fallback student ids when imported rows do not provide ids", () => {
        const students = parseStoredRosterStudents(JSON.stringify([
            { name: "김학생", email: "kim-seoul@school.kr", group: "A반", region: "서울" },
            { name: "김학생", email: "kim-busan@school.kr", group: "A반", region: "부산" },
        ]));

        expect(students.map(student => student.id)).toEqual([
            "서울/A반::김학생",
            "부산/A반::김학생",
        ]);
    });

    it("derives stable duplicate-safe student ids without exposing the email", () => {
        const first = disambiguateRosterStudentId("group-a::김학생", "first@example.edu");
        const second = disambiguateRosterStudentId("group-a::김학생", "second@example.edu");

        expect(first).toMatch(/^group-a::김학생#[a-z0-9]+$/);
        expect(second).toMatch(/^group-a::김학생#[a-z0-9]+$/);
        expect(first).not.toBe(second);
        expect(first).not.toContain("first@example.edu");
    });

    it("matches students to same-name groups by region when region is available", () => {
        const seoulGroup = { id: "g-seoul", name: "A반", region: "서울", count: 0, avgScore: 0, color: "#000" };
        const busanGroup = { id: "g-busan", name: "A반", region: "부산", count: 0, avgScore: 0, color: "#000" };
        const seoulStudent: RosterStudent = {
            id: "서울/A반::김학생",
            name: "김학생",
            email: "",
            group: "A반",
            region: "서울",
            avatar: "#000",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        };

        expect(rosterGroupMatchesStudent(seoulGroup, seoulStudent)).toBe(true);
        expect(rosterGroupMatchesStudent(busanGroup, seoulStudent)).toBe(false);
    });

    it("M1 regression: a student's id-encoded original group no longer matches after the student's group field is edited", () => {
        // Ids are scoped to the group at creation time and are never
        // regenerated on edit (`${groupId}::${name}`), so a student edited
        // from Group A into Group B keeps an id that still looks like it
        // belongs to Group A. Matching must follow the `group` field only,
        // otherwise the student is counted in both groups and Group A can
        // never be seen as empty again.
        const groupA = { id: "A", name: "A반", count: 0, avgScore: 0, color: "#000" };
        const groupB = { id: "B", name: "B반", count: 0, avgScore: 0, color: "#000" };
        const movedStudent: RosterStudent = {
            id: "A::김학생", // id still encodes the original group A scope
            name: "김학생",
            email: "kim@example.com",
            group: "B반", // but the student now belongs to group B
            avatar: "#000",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        };

        expect(rosterGroupMatchesStudent(groupA, movedStudent)).toBe(false);
        expect(rosterGroupMatchesStudent(groupB, movedStudent)).toBe(true);
    });

    it("M1 regression: legacy students with no group field still fall back to the id-encoded scope", () => {
        const groupA = { id: "A", name: "A반", count: 0, avgScore: 0, color: "#000" };
        const legacyStudent: RosterStudent = {
            id: "A::김학생",
            name: "김학생",
            email: "kim@example.com",
            group: "",
            avatar: "#000",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        };

        expect(rosterGroupMatchesStudent(groupA, legacyStudent)).toBe(true);
    });

    it("falls back when stored roster JSON is unreadable or empty", () => {
        const fallback: RosterStudent[] = [{
            id: "fallback",
            name: "대체 학생",
            email: "",
            group: "A반",
            avatar: "#4f46e5",
            avgScore: 0,
            examsTaken: 0,
            lastActive: "기록 없음",
            trend: "flat",
            status: "active",
        }];
        expect(parseStoredRosterStudents("{bad", fallback)).toBe(fallback);
        expect(readRosterStudents(createStorage({ omr_students: "[]" }) as Storage, fallback)).toBe(fallback);
    });

    it("keeps valid groups and repairs numeric fields", () => {
        expect(parseStoredRosterGroups(JSON.stringify([
            { name: "B반", branch: " 부산 ", count: -5, avgScore: 72.4 },
            { id: "missing-name" },
        ]))).toEqual([
            expect.objectContaining({
                id: "group:B반",
                name: "B반",
                region: "부산",
                count: 0,
                avgScore: 72,
            }),
        ]);
    });

    it("drops invalid invite emails and normalizes invite status", () => {
        expect(parseStoredRosterInvites(JSON.stringify([
            { email: "USER@SCHOOL.KR", status: "accepted" },
            { email: "not-an-email", status: "pending" },
            { email: "next@school.kr", status: "unknown" },
        ]))).toEqual([
            expect.objectContaining({ email: "user@school.kr", status: "accepted" }),
            expect.objectContaining({ email: "next@school.kr", status: "pending" }),
        ]);
    });

    it("distinguishes a blank workspace from an intentionally stored empty roster", () => {
        expect(hasStoredRosterData(createStorage({}))).toBe(false);
        expect(hasStoredRosterData(createStorage({ omr_students: "[]" }))).toBe(true);
        expect(hasStoredRosterData(createStorage({ omr_groups: "[]", omr_invites: "[]" }))).toBe(true);
    });
});
