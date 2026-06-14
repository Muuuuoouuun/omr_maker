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

    it("Supabase docs warn that alpha RLS is open", () => {
        const docs = readProjectFile("supabase/README.md");

        expect(docs).toContain("alpha/local testing");
        expect(docs).toContain("real student data");
        expect(docs).toContain("Supabase Auth");
    });
});
