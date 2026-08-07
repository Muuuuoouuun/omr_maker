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

    it("resolves a coherent showcase attempt detail only for the signed demo identity", async () => {
        const demoModule = await import("./demoData");
        expect(demoModule).toHaveProperty("resolveDemoAttemptDetail");
        const resolveDemoAttemptDetail = (demoModule as typeof demoModule & {
            resolveDemoAttemptDetail: (
                identity: { teacherId: string } | null,
                attemptId: string,
                now?: number,
            ) => null | {
                attempt: { id: string; examId: string };
                exam: { id: string };
                peerAttempts: Array<{ examId: string }>;
            };
        }).resolveDemoAttemptDetail;
        const now = Date.parse("2026-08-05T00:00:00.000Z");
        const demo = buildDemoDashboardData(now);
        const target = demo.attempts.find(attempt => attempt.examId === "mock-final-comprehensive");

        expect(target).toBeDefined();
        const detail = resolveDemoAttemptDetail({ teacherId: "omr-showcase" }, target!.id, now);
        expect(detail?.attempt.id).toBe(target!.id);
        expect(detail?.exam.id).toBe("mock-final-comprehensive");
        expect(detail?.peerAttempts.length).toBe(84);
        expect(detail?.peerAttempts.every(attempt => attempt.examId === detail.exam.id)).toBe(true);
        expect(resolveDemoAttemptDetail({ teacherId: "admin" }, target!.id, now)).toBeNull();
        expect(resolveDemoAttemptDetail({ teacherId: "omr-showcase" }, "missing", now)).toBeNull();
    });
});
