import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("teacher roster server surface", () => {
    it("uses teacher cookie, same-origin checks, service role, and production fail-closed policy", () => {
        const action = source("src/app/actions/teacherRoster.ts");
        expect(action).toContain("TEACHER_SERVER_SESSION_COOKIE");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("createSupabaseAdminClient");
        expect(action).toContain('process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only"');
    });

    it("routes teacher users and settings through the server roster client", () => {
        const users = source("src/app/teacher/users/page.tsx");
        const settings = source("src/app/teacher/settings/page.tsx");
        expect(users).toContain("loadTeacherRosterSnapshot");
        expect(users).toContain("saveTeacherRosterSnapshot");
        expect(settings).toContain("loadTeacherRosterSnapshot");
        expect(users).not.toContain('from "@/lib/rosterPersistence"');
    });

    it("uses only the exact scoped roster cache after a complete request-identity fence", () => {
        const users = source("src/app/teacher/users/page.tsx");
        const distribution = source("src/components/DistributeModal.tsx");
        for (const surface of [users, distribution]) {
            expect(surface).toContain("readTeacherRosterDegradedCache");
            expect(surface).toContain("persistTeacherRosterCompletionIfCurrent");
            expect(surface).toContain("sameTeacherRosterLoadIdentity");
            expect(surface).not.toContain("TEACHER_ROSTER_CACHE_STALE_AT_KEY");
            expect(surface).not.toContain("omr_teacher_roster_cache_stale_at_v1");
        }
    });

    it("fences roster mutations, undo, CSV parsing, distribution assignment, invite, and bearer continuations", () => {
        const users = source("src/app/teacher/users/page.tsx");
        const distribution = source("src/components/DistributeModal.tsx");
        expect(users).toContain("saveTeacherRosterSnapshotIfCurrent");
        expect(users).toContain("canContinueTeacherRosterIdentityOperation");
        expect(users).toContain("undoOperation");
        expect(users).toMatch(/file\.arrayBuffer\(\)[\s\S]*csvIsCurrent/);
        expect(distribution).toContain("distributionOperationEpochRef");
        expect(distribution).toContain("canContinueTeacherRosterIdentityOperation");
        expect(distribution).toMatch(/await onSaveAndShare[\s\S]*operationIsCurrent/);
        expect(distribution).toMatch(/await onRevokeInvite[\s\S]*operationIsCurrent/);
        expect(distribution).toMatch(/onLoadInviteMetadata[\s\S]*operationIsCurrent/);
        expect(distribution).toMatch(/onLoadStudentAssignment[\s\S]*operationIsCurrent/);
    });

    it("loads analytics only behind a fresh roster capability and removes degraded child actions", () => {
        const users = source("src/app/teacher/users/page.tsx");
        const groups = source("src/components/teacher/users/GroupsTab.tsx");
        const invites = source("src/components/teacher/users/InvitesTab.tsx");
        expect(users).toContain("const rosterIsFresh = rosterLoadState.state");
        expect(users).toContain("}, [rosterLoadState.state]);");
        expect(users).toContain("if (!selected || rosterMutationsDisabled) return []");
        expect(users).toContain("if (rosterMutationsDisabled) return;");
        expect(users).toContain("setDetailedAttempts(null)");
        expect(groups).toContain('capability: "degraded_read_only"');
        expect(groups).toContain('capability: "fresh_mutable"');
        expect(groups).toContain('if (props.capability === "degraded_read_only")');
        expect(invites).toContain('capability: "degraded_read_only"');
        expect(invites).toContain('capability: "fresh_mutable"');
        expect(invites).toContain('if (props.capability === "degraded_read_only")');
        expect(users).toContain('capability="degraded_read_only"');
        expect(users).toContain('capability="fresh_mutable"');
        expect(users).not.toContain("readOnly={rosterMutationsDisabled}");
        expect(users).toContain("pendingDeleteUndoRef");
        expect(users).toContain("rosterSnapshotRef");
        expect(users).toContain("restoreDeletedStudentsIntoCurrentRoster");
        expect(users).toContain("const currentSnapshot = rosterSnapshotRef.current");
        expect(users).toContain('toast.action("info", "학생 삭제됨"');
        expect(users).not.toContain('toast.action("info", `${label} 삭제됨`');
        expect(users).toContain("!isDemoRoster && !rosterMutationsDisabled");
        expect(users).toContain("!rosterMutationsDisabled && studentGrowthReportsEnabled");
        expect(groups).not.toContain("readOnly:");
        expect(invites).not.toContain("readOnly:");
    });

    it("tells stale-device writers to refresh instead of blaming connectivity", () => {
        const users = source("src/app/teacher/users/page.tsx");
        expect(users).toContain("ROSTER_REVISION_CONFLICT_ERROR");
        expect(users).toContain("다른 기기에서 명단이 변경됨");
        expect(users).toContain("새로고침");
    });

    it("contains no browser publishable Supabase client in roster persistence", () => {
        const persistence = source("src/lib/rosterPersistence.ts");
        expect(persistence).not.toContain("NEXT_PUBLIC_SUPABASE");
        expect(persistence).not.toContain('import("@supabase/supabase-js")');
        expect(persistence).not.toContain("publishableKey");
    });

    it("restricts the atomic roster RPC and invite table to service role", () => {
        const migration = source("supabase/migrations/202607140011_teacher_roster_gateway.sql");
        expect(migration).toContain("security definer");
        expect(migration).toContain("roster organization scope mismatch");
        expect(migration).toContain("roster enrollment target scope mismatch");
        expect(migration).toContain("lock withdrawal targets before credential deletion");
        expect(migration).toMatch(/for\s+update/i);
        expect(migration.indexOf("lock withdrawal targets before credential deletion"))
            .toBeLessThan(migration.indexOf("delete from public.omr_student_start_credentials credential"));
        expect(migration).toContain("delete from public.omr_student_start_credentials credential");
        expect(migration.indexOf("delete from public.omr_student_start_credentials credential"))
            .toBeLessThan(migration.indexOf("update public.omr_student_profiles row"));
        expect(migration.indexOf("roster enrollment target scope mismatch"))
            .toBeLessThan(migration.indexOf("update public.omr_class_students row"));
        expect(migration).toContain("revoke all on function public.omr_save_roster_v1");
        expect(migration).toContain("grant execute on function public.omr_save_roster_v1");
        expect(migration).toContain("revoke all on public.omr_roster_invites from anon, authenticated");
    });
});
