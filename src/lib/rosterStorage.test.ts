import { describe, expect, it } from "vitest";
import {
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
