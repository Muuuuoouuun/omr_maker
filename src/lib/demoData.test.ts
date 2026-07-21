import { describe, expect, it } from "vitest";
import { buildClassExamWeaknessMatrix } from "./premiumAnalytics";
import { buildDemoDashboardData, shouldUseDemoData } from "./demoData";

describe("demo data gating", () => {
    it("allows demo data only for the public mockup identity", () => {
        expect(shouldUseDemoData({ teacherId: "omr-showcase" })).toBe(true);
        expect(shouldUseDemoData({ teacherId: "admin" })).toBe(false);
        expect(shouldUseDemoData({ teacherId: "teacher1" })).toBe(false);
        expect(shouldUseDemoData(null)).toBe(false);
    });

    it("seeds a complete showcase workspace with coherent class cuts", () => {
        const { exams, attempts, rosterGroups, rosterStudents } = buildDemoDashboardData(Date.UTC(2026, 5, 15, 9, 0, 0));

        expect(exams).toHaveLength(7);
        expect(attempts).toHaveLength(572);
        expect(rosterGroups).toHaveLength(4);
        expect(rosterStudents).toHaveLength(84);
        expect(exams.filter(exam => !exam.archived)).toHaveLength(3);
        expect(new Set(attempts.map(attempt => attempt.groupId))).toEqual(new Set(["class-2-1", "class-2-2", "class-2-3", "class-2-4"]));
        expect(attempts[0]).toMatchObject({
            studentName: "김서준",
            studentId: "class-2-1::student-1",
            groupId: "class-2-1",
            groupName: "2학년 1반",
            identityType: "registered",
        });

        const matrixRows = buildClassExamWeaknessMatrix(
            exams[0],
            attempts.filter(attempt => attempt.examId === exams[0].id),
            { classLimit: 4 },
        );

        expect(matrixRows).toHaveLength(4);
        expect(matrixRows.map(row => row.groupName).sort((a, b) => a.localeCompare(b, "ko"))).toEqual(["2학년 1반", "2학년 2반", "2학년 3반", "2학년 4반"]);
        expect(matrixRows.some(row => row.recommendations.length > 0)).toBe(true);
    });

    it("keeps the generated showcase deterministic for a fixed clock", () => {
        const now = Date.UTC(2026, 6, 15, 9, 0, 0);
        expect(buildDemoDashboardData(now)).toEqual(buildDemoDashboardData(now));
    });
});
