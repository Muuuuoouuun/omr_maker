import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(path: string): string {
    return readFileSync(join(root, path), "utf8");
}

describe("teacher attempt scoped mutation contract", () => {
    it("defines three service-role-only field-limited RPCs", () => {
        const path = "supabase/migrations/202607280001_teacher_attempt_scoped_mutations.sql";
        expect(existsSync(join(root, path))).toBe(true);
        if (!existsSync(join(root, path))) return;
        const sql = source(path).toLowerCase();

        for (const signature of [
            "omr_answer_attempt_question_v1(text, text, text, text)",
            "omr_set_subquestion_review_v1(text, text, text, text)",
            "omr_force_finish_attempts_v1(text, text[], timestamptz)",
        ]) {
            expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
            expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
        }
        expect(sql).toContain("for update");
        expect(sql).toContain("attempt organization mismatch");
        expect(sql).toContain("attempt class scope mismatch");
        expect(sql).not.toMatch(/\bset\s+score\s*=/);
        expect(sql).not.toContain("omr_question_results");
        expect(sql).not.toContain("student_id =");
    });

    it("authorizes same-origin signed teacher write roles before creating the admin client", () => {
        const action = source("src/app/actions/teacherAttempts.ts");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("parseSignedTeacherSessionCookie");
        expect(action).toContain("canTeacherRoleWrite");
        expect(action.indexOf("canTeacherRoleWrite")).toBeLessThan(action.indexOf("createSupabaseAdminClient"));
        expect(action).toContain("answerTeacherCanonicalAttemptQuestion");
        expect(action).toContain("setTeacherCanonicalSubquestionReview");
        expect(action).toContain("forceFinishTeacherCanonicalAttempts");
        expect(action).not.toContain("saveTeacherCanonicalAttempt");
        expect(action.match(/actionContext\(true\)/g)).toHaveLength(3);
        expect(action.match(/actionContext\(\)/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it("removes broad attempt saves from official teacher pages", () => {
        const client = source("src/lib/teacherAttemptClient.ts");
        const live = source("src/app/teacher/live/page.tsx");
        const review = source("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(client).not.toContain("saveTeacherCanonicalAttempt");
        expect(client).not.toContain("export async function saveTeacherAttempt(");
        expect(live).not.toMatch(/\bsaveTeacherAttempt\(/);
        expect(review).not.toMatch(/\bsaveTeacherAttempt\(/);
        expect(live).toContain("forceFinishTeacherAttempts");
        expect(review).toContain("answerTeacherAttemptQuestion");
        expect(review).toContain("setTeacherAttemptSubquestionReview");
    });
});
