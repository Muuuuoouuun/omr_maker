import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("feedback gateway contract", () => {
    const migration = read("supabase/migrations/202607140016_feedback_gateway.sql");

    it("keeps all feedback mutations service-role only and session scoped", () => {
        for (const functionName of [
            "omr_save_feedback_v1",
            "omr_return_feedback_v1",
            "omr_mark_feedback_opened_v2",
        ]) {
            expect(migration).toContain(`function public.${functionName}`);
            expect(migration).toMatch(new RegExp(`grant execute on function public\\.${functionName}\\([^;]+\\) to service_role`));
        }
        expect(migration).toContain("and organization_id = trim(p_organization_id)");
        expect(migration).toContain("and student_profile_id = trim(p_student_profile_id)");
        expect(migration).toContain("feedback student mismatch");
    });

    it("routes teacher and student feedback screens through server action clients", () => {
        const teacher = read("src/app/teacher/attempt/[attemptId]/page.tsx");
        const dashboard = read("src/app/student/dashboard/page.tsx");
        const history = read("src/app/student/history/page.tsx");
        const review = read("src/app/student/review/[attemptId]/page.tsx");

        expect(teacher).toContain("@/lib/teacherFeedbackClient");
        expect(dashboard).toContain("@/lib/studentFeedbackClient");
        expect(history).toContain("@/lib/studentFeedbackClient");
        expect(review).toContain("@/lib/studentFeedbackClient");
        expect(teacher).not.toMatch(/\b(loadAttemptFeedback|saveAttemptFeedbackDraft|returnAttemptFeedback)\b/);
        expect(review).not.toMatch(/\b(loadReturnedAttemptFeedbackForStudent|markFeedbackOpenedForStudent)\b/);
    });
});
