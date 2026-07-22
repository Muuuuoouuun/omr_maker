import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => readFileSync(path.join(root, relativePath), "utf8");

describe("feedback gateway contract", () => {
    const migration = read("supabase/migrations/202607140016_feedback_gateway.sql");
    const preserveMarkupMigration = read("supabase/migrations/202607220001_preserve_feedback_markup.sql");

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

    it("preserves stored markup when the save payload omits the key and honors explicit updates", () => {
        expect(preserveMarkupMigration).toContain("create or replace function public.omr_save_feedback_v1");
        expect(preserveMarkupMigration).toContain("security definer");
        expect(preserveMarkupMigration).toContain("set search_path = ''");
        expect(preserveMarkupMigration).toMatch(/markup_drawings\s*=\s*case[\s\S]*when p_feedback \? 'markup_drawings'[\s\S]*then excluded\.markup_drawings[\s\S]*else public\.omr_attempt_feedback\.markup_drawings[\s\S]*end/);
        expect(preserveMarkupMigration).toContain("revoke all on function public.omr_save_feedback_v1(text, jsonb) from public, anon, authenticated");
        expect(preserveMarkupMigration).toContain("grant execute on function public.omr_save_feedback_v1(text, jsonb) to service_role");

        const originalFunction = migration.slice(
            migration.indexOf("create or replace function public.omr_save_feedback_v1"),
            migration.indexOf("create or replace function public.omr_return_feedback_v1"),
        ).trim();
        const replacementFunction = preserveMarkupMigration.slice(
            preserveMarkupMigration.indexOf("create or replace function public.omr_save_feedback_v1"),
            preserveMarkupMigration.indexOf("revoke all on function public.omr_save_feedback_v1"),
        ).trim();
        const normalizedReplacement = replacementFunction.replace(
            /        markup_drawings = case\n            when p_feedback \? 'markup_drawings' then excluded\.markup_drawings\n            else public\.omr_attempt_feedback\.markup_drawings\n        end,/,
            "        markup_drawings = excluded.markup_drawings,",
        );
        expect(normalizedReplacement).toBe(originalFunction);

        const applyConflictMarkup = (
            existing: unknown,
            payload: Record<string, unknown>,
            excluded: unknown,
        ) => Object.prototype.hasOwnProperty.call(payload, "markup_drawings") ? excluded : existing;

        const stored = { 1: ["existing-stroke"] };
        expect(applyConflictMarkup(stored, {}, null)).toBe(stored);
        expect(applyConflictMarkup(stored, { markup_drawings: null }, null)).toBeNull();
        expect(applyConflictMarkup(stored, { markup_drawings: {} }, {})).toEqual({});
        expect(applyConflictMarkup(stored, { markup_drawings: { 2: ["new-stroke"] } }, { 2: ["new-stroke"] }))
            .toEqual({ 2: ["new-stroke"] });
    });
});
