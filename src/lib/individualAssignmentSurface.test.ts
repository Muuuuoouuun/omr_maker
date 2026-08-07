import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    try { return readFileSync(path, "utf8"); } catch { return ""; }
}

describe("individual assignment product surface", () => {
    it("offers student search, selection summary, retake mode, retry, and no raw ids in accessConfig", () => {
        const modal = source("src/components/DistributeModal.tsx");
        expect(modal).toContain("개별 학생");
        expect(modal).toContain("학생 검색");
        expect(modal).toContain("선택한 학생");
        expect(modal).toContain("재시험 배정");
        expect(modal).toContain("다시 시도");
        expect(modal).toContain("onAssignStudents");
        expect(modal).not.toMatch(/accessConfig\s*[:=][\s\S]{0,240}(studentIds|targetStudentIds)/);
    });

    it("passes only an assignment id through the solve URL and binds it into ticket/session entry", () => {
        const assignmentBlock = source("src/components/dashboard/AssignmentBlock.tsx");
        const solve = source("src/app/solve/[id]/page.tsx");
        const studentAction = source("src/app/actions/studentExam.ts");
        expect(assignmentBlock).toContain("assignmentId");
        expect(assignmentBlock).not.toContain("targetStudentIds");
        expect(solve).toContain('currentParams.get("assignment")');
        expect(solve).toContain("requestedAssignmentId");
        expect(studentAction).toContain("resolveStudentTargetedAssignmentWithGateway");
    });

    it("uses a signed teacher action and never sends selected ids in a share URL", () => {
        const action = source("src/app/actions/teacherAssignment.ts");
        const create = source("src/app/create/page.tsx");
        expect(action).toContain("resolveAuthorizedTeacherSessionCookie");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("saveTeacherIndividualAssignmentWithGateway");
        expect(create).toContain("saveTeacherIndividualAssignment");
        expect(create).not.toMatch(/buildSolveShareUrl\([^)]*(studentIds|targetStudentIds)/);
    });
});
