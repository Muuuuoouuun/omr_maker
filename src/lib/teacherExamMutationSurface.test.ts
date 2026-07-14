import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("teacher exam mutation surface", () => {
    it("routes overview mutations through teacher server clients", () => {
        const overview = source("src/components/dashboard/tabs/OverviewTab.tsx");
        expect(overview).toContain("saveTeacherExamMutation");
        expect(overview).toContain("deleteTeacherExamMutation");
        expect(overview).not.toContain('from "@/lib/omrPersistence"');
    });

    it("keeps delete scoped and atomic behind service role", () => {
        const migration = source("supabase/migrations/202607140014_teacher_exam_delete.sql");
        expect(migration).toContain("security definer");
        expect(migration).toContain("exam.organization_id = p_organization_id");
        expect(migration).toContain("delete from public.omr_question_results");
        expect(migration).toContain("delete from public.omr_attempts");
        expect(migration).toContain("delete from public.omr_exam_questions");
        expect(migration).toContain("grant execute on function public.omr_delete_exam_v1(text, text) to service_role");
    });
});
