import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("teacher exam mutation surface", () => {
    it("makes the overview mutation surface an explicit fresh-only capability", () => {
        const overview = source("src/components/dashboard/tabs/OverviewTab.tsx");
        const dashboard = source("src/app/teacher/dashboard/page.tsx");

        expect(overview).toContain('export type TeacherDataCapability = "fresh_mutable" | "degraded_read_only" | "unavailable"');
        expect(overview).toContain("type OverviewTabProps = FreshOverviewTabProps | DegradedOverviewTabProps | UnavailableOverviewTabProps");
        expect(overview).toMatch(/interface DegradedOverviewTabProps[\s\S]*capability: "degraded_read_only"[\s\S]*snapshot: TeacherDashboardDegradedData/);
        expect(overview).toMatch(/const handleExamAction[\s\S]*if \(capability !== "fresh_mutable"\) return;[\s\S]*const target = exams\.find/);
        expect(overview).toMatch(/const confirmDeleteExam[\s\S]*if \(capability !== "fresh_mutable"\) return;[\s\S]*if \(!deleteTarget\) return/);
        expect(overview).toMatch(/const handleExportStatsCsv[\s\S]*if \(capability !== "fresh_mutable"\) return;[\s\S]*setIsExportingStats\(true\)/);
        expect(overview).toMatch(/useLayoutEffect\(\(\) => \{[\s\S]*isMountedRef\.current = true;[\s\S]*return \(\) => \{[\s\S]*isMountedRef\.current = false/);
        expect(overview).toMatch(/await setTeacherExamArchivedFromSummary[\s\S]*if \(!mutationIsCurrent\(\)\) return;[\s\S]*toast\.success/);
        expect(overview).toMatch(/await deleteTeacherExamMutation[\s\S]*if \(!mutationIsCurrent\(\)\) return;[\s\S]*toast\.success/);
        const capabilityBoundary = overview.slice(
            overview.indexOf("export default function OverviewTab"),
            overview.indexOf("function FreshOverviewTab"),
        );
        expect(capabilityBoundary).toContain('props.capability === "degraded_read_only"');
        expect(capabilityBoundary).not.toContain("handleExamAction");
        expect(capabilityBoundary).not.toContain("handleExportStatsCsv");
        expect(capabilityBoundary).not.toContain("onLoadDetailedAttempts");

        expect(dashboard).toContain("const teacherDataCapability: TeacherDataCapability");
        expect(dashboard).toContain('capability="degraded_read_only"');
        expect(dashboard).toContain('capability="fresh_mutable"');
        const degradedStart = dashboard.indexOf("!isMockupAccount && isDashboardDegraded && degradedDashboardData");
        const freshStart = dashboard.indexOf("activeTab === 'overview' && !isMockupAccount && !isDashboardDegraded", degradedStart);
        expect(degradedStart).toBeGreaterThan(-1);
        expect(freshStart).toBeGreaterThan(degradedStart);
        const degradedBranch = dashboard.slice(degradedStart, freshStart);
        expect(degradedBranch).toContain("<OverviewTab");
        expect(degradedBranch).toContain("snapshot={degradedDashboardData}");
        expect(degradedBranch).not.toContain("handleNavigateToExamAnalytics");
        expect(degradedBranch).not.toContain("handleNavigateToStudentAnalytics");
        expect(degradedBranch).not.toContain("loadDetailedAttempts");
    });

    it("routes overview mutations through teacher server clients", () => {
        const overview = source("src/components/dashboard/tabs/OverviewTab.tsx");
        expect(overview).not.toContain("duplicateTeacherExamFromSummary");
        expect(overview).toContain("setTeacherExamArchivedFromSummary");
        expect(overview).toContain("deleteTeacherExamMutation");
        expect(overview).toContain("const desiredArchived = !target.archived");
        expect(overview).toContain("mutationExamIds");
        expect(overview).not.toContain('from "@/lib/omrPersistence"');
    });

    it("removes exam duplication from the initial release surface", () => {
        const overview = source("src/components/dashboard/tabs/OverviewTab.tsx");
        const menu = source("src/components/dashboard/ExamActionsMenu.tsx");
        const client = source("src/lib/teacherExamClient.ts");
        const combined = `${overview}\n${menu}\n${client}`;
        for (const marker of [
            '"duplicate"',
            "duplicateTeacherExamFromSummary",
            "authorizeExamCreation",
            "releaseExamCreationAuthorization",
            "copyStoredData",
            "cleanupCreatedExamAsset",
        ]) {
            expect(combined).not.toContain(marker);
        }
    });

    it("renders a truthful detail-page fallback for redacted list question bodies", () => {
        const overview = source("src/components/dashboard/tabs/OverviewTab.tsx");
        expect(overview).toContain('entry.note.body || "질문 내용은 응시 상세에서 확인하세요."');
    });

    it("has no provisional clone target action or gateway surface", () => {
        const action = source("src/app/actions/teacherExam.ts");
        const gateway = source("src/lib/teacherExamGateway.ts");
        const schema = source("supabase/schema.sql");
        for (const marker of [
            "createTeacherCanonicalExamCloneTarget",
            "cleanupTeacherCanonicalExamCloneTarget",
            "createTeacherExamCloneTargetWithGateway",
            "cleanupTeacherExamCloneTargetWithGateway",
            "omr_create_exam_clone_target_v1",
            "omr_cleanup_exam_clone_target_v1",
        ]) {
            expect(`${action}\n${gateway}\n${schema}`).not.toContain(marker);
        }
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
