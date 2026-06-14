import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("persistence integration", () => {
    it("solve page does not shadow the shared exam loader", () => {
        const source = readProjectFile("src/app/solve/[id]/page.tsx");

        expect(source).not.toMatch(/const\s+loadExam\s*=\s*async/);
    });

    it("primary read screens use the shared persistence layer", () => {
        const screens = [
            { file: "src/app/teacher/dashboard/page.tsx", functions: ["loadExams", "loadAttempts"] },
            { file: "src/app/student/dashboard/page.tsx", functions: ["loadExams", "loadAttempts"] },
            { file: "src/app/student/history/page.tsx", functions: ["loadAttempts"] },
            { file: "src/app/student/review/[attemptId]/page.tsx", functions: ["loadAttempt", "loadExam"] },
            { file: "src/app/teacher/exam/[id]/page.tsx", functions: ["loadExam", "loadAttempts"] },
            { file: "src/app/teacher/attempt/[attemptId]/page.tsx", functions: ["loadAttempt", "loadExam"] },
            { file: "src/app/teacher/live/page.tsx", functions: ["loadExams", "loadAttempts"] },
        ];

        for (const screen of screens) {
            const source = readProjectFile(screen.file);
            expect(source, screen.file).toContain("@/lib/omrPersistence");
            for (const fn of screen.functions) {
                expect(source, `${screen.file} should use ${fn}`).toContain(fn);
            }
        }
    });

    it("Supabase schema includes alpha organization boundaries", () => {
        const schema = readProjectFile("supabase/schema.sql");

        expect(schema).toContain("create table if not exists public.omr_organizations");
        expect(schema).toContain("create table if not exists public.omr_organization_members");
        expect(schema).toContain("create table if not exists public.omr_classes");
        expect(schema).toContain("create table if not exists public.omr_audit_logs");
        expect(schema).toContain("organization_id text");
        expect(schema).toContain("class_id text");
    });

    it("Supabase schema models users, rosters, materials, assignments, and feedback", () => {
        const schema = readProjectFile("supabase/schema.sql");
        const expectedTables = [
            "public.omr_user_profiles",
            "public.omr_teacher_profiles",
            "public.omr_student_profiles",
            "public.omr_class_teachers",
            "public.omr_class_students",
            "public.omr_materials",
            "public.omr_exam_materials",
            "public.omr_assignments",
            "public.omr_assignment_targets",
            "public.omr_assignment_submissions",
            "public.omr_comments",
        ];

        for (const table of expectedTables) {
            expect(schema, `${table} table`).toContain(`create table if not exists ${table}`);
            expect(schema, `${table} RLS`).toContain(`alter table ${table} enable row level security`);
        }

        expect(schema).toContain("assignment_id text");
        expect(schema).toContain("student_profile_id text");
        expect(schema).toContain("storage_bucket text");
        expect(schema).toContain("storage_path text");
        expect(schema).toContain("target_type text not null");
        expect(schema).toContain("entity_type text not null");
        expect(schema).toContain("check (role in ('owner', 'admin', 'teacher', 'assistant', 'viewer'))");
        expect(schema).toContain("check (material_type in ('problem_pdf', 'answer_key', 'solution', 'worksheet', 'image', 'video', 'link', 'note', 'other'))");
        expect(schema).toContain("omr_assignment_submissions_student_idx");
        expect(schema).toContain("omr_materials_org_owner_idx");
    });

    it("Supabase docs warn that alpha RLS is open", () => {
        const docs = readProjectFile("supabase/README.md");

        expect(docs).toContain("alpha/local testing");
        expect(docs).toContain("real student data");
        expect(docs).toContain("Supabase Auth");
    });
});
