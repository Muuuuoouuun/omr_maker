import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(join(process.cwd(), "src/lib/omrPersistence.ts"), "utf8");

function bodyBetween(start: string, end: string): string {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    expect(from, `missing ${start}`).toBeGreaterThanOrEqual(0);
    expect(to, `missing ${end}`).toBeGreaterThan(from);
    return source.slice(from, to);
}

describe("legacy browser canonical boundary", () => {
    it("requires the active teacher organization for every teacher detail and list read", () => {
        const examDetail = bodyBetween("async function fetchRemoteExam(", "async function fetchRemoteExams(");
        const examList = bodyBetween("async function fetchRemoteExams(", "async function fetchRemoteAttempts(");
        const attemptList = bodyBetween("async function fetchRemoteAttempts(", "async function fetchRemoteAttemptsForStudent(");
        const attemptDetail = bodyBetween("export async function fetchRemoteAttempt(", "async function fetchRemoteAttemptForStudent(");

        for (const block of [examDetail, examList, attemptList, attemptDetail]) {
            expect(block).toContain("activeTeacherOrganizationId()");
            expect(block).toContain('.eq("organization_id", organizationId)');
        }
        expect(examList).toContain("INITIAL_OPERATIONS_LIMITS.teacherExams + 1");
        expect(attemptList).toContain("INITIAL_OPERATIONS_LIMITS.teacherAttempts + 1");
        expect(examList).toContain("SUPABASE_EXAM_LIST_READ_COLUMNS");
        expect(examList).toContain("examFromSupabaseListRow");
        expect(attemptList).toContain("SUPABASE_ATTEMPT_LIST_READ_COLUMNS");
        expect(attemptList).toContain("attemptFromSupabaseListRow");
        expect(examList).not.toContain("SUPABASE_EXAM_READ_COLUMNS");
        expect(attemptList).not.toContain("SUPABASE_ATTEMPT_READ_COLUMNS");
        expect(examList).toContain("INITIAL_CAPACITY_EXCEEDED_ERROR");
        expect(attemptList).toContain("INITIAL_CAPACITY_EXCEEDED_ERROR");
        expect(attemptDetail).not.toContain("no org\n");
    });

    it("requires organization and owner scope for student fallback reads", () => {
        const studentList = bodyBetween("async function fetchRemoteAttemptsForStudent(", "export async function fetchRemoteAttempt(");
        const studentDetail = bodyBetween("async function fetchRemoteAttemptForStudent(", "async function upsertRemoteExam(");

        for (const block of [studentList, studentDetail]) {
            expect(block).toContain('.eq("organization_id", organizationId)');
            expect(block).toContain('.eq("student_profile_id", normalizedStudentId)');
        }
        expect(studentList).toContain("INITIAL_OPERATIONS_LIMITS.studentAttempts + 1");
        expect(studentList).toContain("INITIAL_CAPACITY_EXCEEDED_ERROR");
        expect(studentList).toContain("SUPABASE_ATTEMPT_LIST_READ_COLUMNS");
    });

    it("fails closed for browser mutations and scopes every destructive child query", () => {
        const examUpsert = bodyBetween("async function upsertRemoteExam(", "async function replaceRemoteExamQuestions(");
        const questionReplace = bodyBetween("async function replaceRemoteExamQuestions(", "async function upsertRemoteAttempt(");
        const attemptUpsert = bodyBetween("async function upsertRemoteAttempt(", "async function upsertRemoteQuestionResults(");
        const examDelete = bodyBetween("async function deleteRemoteExam(", "function refreshLocalExamFromRemote(");

        expect(examUpsert).toContain("activeTeacherOrganizationId()");
        expect(attemptUpsert).toContain("activeTeacherOrganizationId()");
        expect(questionReplace).toContain('.eq("organization_id", organizationId)');
        expect(examDelete.match(/\.eq\("organization_id", organizationId\)/g)).toHaveLength(4);
        expect(examDelete).toContain("activeTeacherOrganizationId()");
    });
});
