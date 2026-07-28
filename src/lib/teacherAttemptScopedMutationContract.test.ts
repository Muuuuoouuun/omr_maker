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
            "omr_answer_attempt_question_v1(text, text, text, text, text, text, text)",
            "omr_set_subquestion_review_v1(text, text, text, text, text, text, text)",
            "omr_force_finish_attempts_v1(text, text[], timestamptz, text, text, text, jsonb)",
        ]) {
            expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
            expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
        }
        expect(sql).toContain("for update");
        expect(sql).toContain("attempt organization mismatch");
        expect(sql).toContain("attempt class scope mismatch");
        expect(sql).toContain("omr_class_teachers");
        expect(sql).toContain("class_role in ('lead', 'co_teacher', 'grader')");
        expect(sql).toContain("p_actor_user_id");
        expect(sql).toContain("p_member_role");
        expect(sql).toContain("'teachername'");
        expect(sql).toContain("'reviewedby'");
        expect(sql).toMatch(/\bscore\s*=/);
        expect(sql).toContain("omr_question_results");
        expect(sql).toContain("expected_answers");
        expect(sql).toContain("expected_exam_updated_at");
        expect(sql).toContain("expected_is_retake");
        expect(sql).toContain("invalid canonical retake scope");
        expect(sql).toContain("for update");
        expect(sql).not.toContain("for key share");
        expect(sql).toContain("assignment revocation");
        expect(sql).not.toContain("student_id =");

        const live = source("supabase/live-test-assertions.sql").toLowerCase();
        expect(live).toContain("role downgrade did not revoke teacher attempt mutation");
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
        expect(action).toContain("actorUserId");
        expect(action).toContain("actorLabel");
        expect(action).toContain("memberRole");
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

    it("keeps the real live-force-finish dialog and timer unchanged on retryable failure", () => {
        const live = source("src/app/teacher/live/page.tsx");
        const failure = live.indexOf("if (!result.localSaved && !result.remoteSaved)");
        const attemptTransition = live.indexOf("setAttempts(", failure);
        const timerTransition = live.indexOf("setTimerSeconds(0)", failure);
        const closeTransition = live.indexOf("setForceFinishConfirmOpen(false)", failure);
        const successToast = live.indexOf('toast.success(', failure);

        expect(failure).toBeGreaterThan(-1);
        expect(attemptTransition).toBeGreaterThan(failure);
        expect(timerTransition).toBeGreaterThan(failure);
        expect(closeTransition).toBeGreaterThan(failure);
        expect(successToast).toBeGreaterThan(failure);
        expect(attemptTransition).toBeLessThan(successToast);
        expect(timerTransition).toBeLessThan(successToast);
        expect(closeTransition).toBeLessThan(successToast);

        const failureBranch = live.slice(failure, attemptTransition);
        expect(failureBranch).toContain('toast.error("종료 처리 실패"');
        expect(failureBranch).not.toContain("refreshFromStorage");
        expect(failureBranch).not.toContain("setTimerSeconds");
        expect(failureBranch).not.toContain("setIsPaused");
        expect(failureBranch).not.toContain("setForceFinishConfirmOpen");
    });

    it("treats remote force-finish success with a cache warning as canonical success", () => {
        const live = source("src/app/teacher/live/page.tsx");
        expect(live).toContain("result.cacheWarning");
        expect(live).toContain("캐시 새로고침");
        expect(live.indexOf("result.cacheWarning")).toBeGreaterThan(
            live.indexOf("setForceFinishConfirmOpen(false)"),
        );
    });
});
