import { describe, expect, it } from "vitest";
import { buildClassExamWeaknessMatrix } from "./premiumAnalytics";
import { buildDemoDashboardData, shouldUseDemoData } from "./demoData";

describe("demo data gating", () => {
    it("allows demo data outside production", () => {
        expect(shouldUseDemoData("development")).toBe(true);
        expect(shouldUseDemoData("test")).toBe(true);
        expect(shouldUseDemoData(undefined)).toBe(true);
    });

    it("blocks demo data in production", () => {
        expect(shouldUseDemoData("production")).toBe(false);
    });

    it("seeds class-scoped attempts so analytics demos show class cuts", () => {
        const { exams, attempts } = buildDemoDashboardData(Date.UTC(2026, 5, 15, 9, 0, 0));

        expect(exams).toHaveLength(2);
        expect(attempts).toHaveLength(54);
        expect(new Set(attempts.map(attempt => attempt.groupId))).toEqual(new Set(["class-a", "class-b", "class-c"]));
        expect(attempts[0]).toMatchObject({
            studentName: "A반 학생 1",
            studentId: "class-a::student-1",
            groupId: "class-a",
            groupName: "A반",
            identityType: "temporary",
        });

        const matrixRows = buildClassExamWeaknessMatrix(
            exams[0],
            attempts.filter(attempt => attempt.examId === exams[0].id),
            { classLimit: 3 },
        );

        expect(matrixRows).toHaveLength(3);
        expect(matrixRows.map(row => row.groupName).sort((a, b) => a.localeCompare(b, "ko"))).toEqual(["A반", "B반", "C반"]);
        expect(matrixRows.some(row => row.recommendations.length > 0)).toBe(true);
    });
});
