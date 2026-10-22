import { describe, expect, it } from "vitest";
import type { Attempt } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import { attemptMatchesStudentProfile } from "@/utils/storage";
import { buildTeacherLiveRosterIndex } from "./teacherLiveRosterIndex";

function student(id: string, name: string, group = "", region = ""): RosterStudent {
    return { id, name, group, region } as RosterStudent;
}

function attempt(fields: Partial<Attempt>): Attempt {
    return { id: "attempt", studentName: "", ...fields } as Attempt;
}

describe("teacher live roster index", () => {
    it("preserves legacy identity, group, campus, duplicate and first-match semantics", () => {
        const roster = [
            student("early", "민준"),
            student("other-campus", "민준", "A", "부산"),
            student("A::민준", "민준", "A", "서울"),
            student("canonical", "민준", "B", "서울"),
            student(" canonical ", "서연", "C"),
            student("blank-name", "", "A"),
            student("spaced-name", " 도윤 ", "B"),
        ];
        const candidates: Attempt[] = [];
        for (const studentName of ["", "민준", "서연", " 도윤 ", "unknown"]) {
            for (const studentId of [undefined, "early", " canonical ", "A::민준", " A :: 도윤 ", "A::", "::민준"]) {
                for (const studentProfileId of [undefined, "", "canonical", " canonical ", "missing"]) {
                    for (const regionName of [undefined, "서울", "부산"]) {
                        candidates.push(attempt({ studentName, studentId, studentProfileId, regionName, groupName: "A" }));
                    }
                }
            }
        }
        for (const orderedRoster of [roster, [...roster].reverse()]) {
            const index = buildTeacherLiveRosterIndex(orderedRoster);
            for (const candidate of candidates) {
                expect(index.matchAttempt(candidate)).toBe(
                    orderedRoster.find(item => attemptMatchesStudentProfile(candidate, item)),
                );
            }
        }
    });

    it("keeps an earlier legacy match ahead of a later exact student id", () => {
        const early = student("old-id", "민준", "A");
        const exact = student("new-id", "민준", "A");
        const index = buildTeacherLiveRosterIndex([early, exact]);
        expect(index.matchAttempt(attempt({ studentId: "new-id", studentName: "민준", groupName: "A" }))).toBe(early);
        expect(index.matchAttempt(attempt({ studentProfileId: "new-id", studentName: "민준" }))).toBe(exact);
        expect(index.matchAttempt(attempt({ studentProfileId: "missing", studentName: "민준" }))).toBeUndefined();
    });

    it("preserves session first-match order and exact, untrimmed ids", () => {
        const roster = [student("owner", "민준"), student("profile", "서연"), student(" profile ", "도윤")];
        const index = buildTeacherLiveRosterIndex(roster);
        for (const studentProfileId of [undefined, "profile", " profile ", "missing"]) {
            for (const ownerStudentId of ["owner", "profile", " profile ", "missing"]) {
                const session = { studentProfileId, ownerStudentId };
                expect(index.matchSession(session)).toBe(roster.find(candidate => (
                    candidate.id === studentProfileId || candidate.id === ownerStudentId
                )));
            }
        }
    });

    it("resolves canonical profiles without rescanning roster names", () => {
        let nameReads = 0;
        const roster = Array.from({ length: 1000 }, (_, position) => ({
            id: `student-${position}`,
            get name() { nameReads += 1; return `학생 ${position}`; },
            group: "A",
        } as RosterStudent));
        const index = buildTeacherLiveRosterIndex(roster);
        nameReads = 0;
        for (let position = 0; position < roster.length; position += 1) {
            expect(index.matchAttempt(attempt({ studentProfileId: `student-${position}` }))).toBe(roster[position]);
        }
        expect(nameReads).toBe(0);
    });
});
