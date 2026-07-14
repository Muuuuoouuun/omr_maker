import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("student official attempt read surface", () => {
    it("authorizes list and detail reads only from the signed HttpOnly student session", () => {
        const action = source("src/app/actions/studentAttempts.ts");
        expect(action).toContain("STUDENT_SERVER_SESSION_COOKIE");
        expect(action).toContain("parseSignedStudentSessionCookie");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("listStudentAttemptsWithGateway(context.client, context.session)");
        expect(action).toContain("loadStudentAttemptWithGateway(context.client, attemptId, context.session)");
        expect(action).not.toContain("organizationId: string");
        expect(action).not.toContain("studentId: string");
    });

    it("uses the official loader on dashboard/history/review and removes raw attempt/exam review reads", () => {
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const history = source("src/app/student/history/page.tsx");
        const review = source("src/app/student/review/[attemptId]/page.tsx");
        expect(dashboard).toContain("loadStudentOfficialAttempts(currentUser)");
        expect(dashboard).not.toContain("loadAttemptsForStudent(currentUser)");
        expect(history).toContain("loadStudentOfficialAttempts(currentSession)");
        expect(history).not.toContain("loadAttemptsForStudent(currentSession)");
        expect(review).toContain("loadStudentOfficialAttempt(id, session)");
        expect(review).not.toContain("loadAttemptForStudent");
        expect(review).not.toContain("loadExam(found.examId)");
    });

    it("allows local fallback only for guests or explicit development local_only status", () => {
        const client = source("src/lib/studentAttemptClient.ts");
        expect(client).toContain("if (session.isGuest)");
        expect(client).toContain('if (result.status === "local_only")');
        expect(client).toContain("items: []");
        expect(client).not.toContain("loadAttemptsForStudent");
        expect(client).not.toContain("loadAttemptForStudent");
    });

    it("removes publishable-key access to canonical exams and grading tables", () => {
        const migration = source("supabase/migrations/202607140015_student_attempt_read_boundary.sql");
        for (const table of ["omr_exams", "omr_attempts", "omr_question_results"]) {
            expect(migration).toContain(`revoke all on table public.${table} from anon, authenticated`);
            expect(migration).toContain(`grant all on table public.${table} to service_role`);
        }
        expect(migration).toContain('drop policy if exists "OMR exams are publicly readable"');
        expect(migration).toContain('drop policy if exists "OMR attempts are publicly readable"');
        expect(migration).toContain('drop policy if exists "OMR question results are publicly readable"');
    });
});
