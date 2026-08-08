import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const path = (relativePath: string) => join(process.cwd(), relativePath);

describe("teacher notification summary server surface", () => {
    it("defines a service-role-only organization-scoped aggregate contract", () => {
        const migrationPath = path("supabase/migrations/202608060011_teacher_notification_summary.sql");
        expect(existsSync(migrationPath)).toBe(true);
        const migration = readFileSync(migrationPath, "utf8");

        expect(migration).toContain("omr_teacher_notification_summary_v1");
        expect(migration).toContain("p_organization_id");
        expect(migration).toContain("security definer");
        expect(migration).toContain("student_question_summaries");
        expect(migration).toContain("queued_student_question_count");
        expect(migration).toContain("queued_student_question_version");
        expect(migration).toContain("recent_event_version");
        expect(migration).toContain("queued_event_version");
        expect(migration).toMatch(/grant execute on function public\.omr_teacher_notification_summary_v1\(text\)\s+to service_role/);
        expect(migration).toMatch(/revoke all on function public\.omr_teacher_notification_summary_v1\(text\)\s+from public, anon, authenticated/);
    });

    it("runs organization isolation, count semantics, and privilege assertions in PostgreSQL 17", () => {
        const assertionsPath = path("supabase/teacher-notification-summary-assertions.sql");
        expect(existsSync(assertionsPath)).toBe(true);
        const assertions = readFileSync(assertionsPath, "utf8");
        const verifier = readFileSync(path("scripts/verify-supabase-live.mjs"), "utf8");

        expect(assertions).toContain("recent_completed_attempt_count");
        expect(assertions).toContain("queued_student_question_count");
        expect(assertions).toMatch(/has_function_privilege\(\s*'anon'/);
        expect(assertions).toContain("notification summary organization isolation failed");
        expect(verifier).toContain('psqlFile("supabase/teacher-notification-summary-assertions.sql")');
    });

    it("keeps the browser notification payload bounded behind a signed teacher server action", () => {
        const actionPath = path("src/app/actions/teacherNotifications.ts");
        expect(existsSync(actionPath)).toBe(true);
        const action = readFileSync(actionPath, "utf8");

        expect(action).toContain("TEACHER_SERVER_SESSION_COOKIE");
        expect(action).toContain("resolveAuthorizedTeacherSessionCookie");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("workspaceContextFromTeacherSession");
        expect(action).toContain("loadTeacherNotificationSummaryWithGateway");
        expect(action).toContain("createHmac");
        expect(action).toContain("scopeKey");
        expect(action).toContain("loadTeacherNotificationStateWithGateway");
        expect(action).toContain("mutateTeacherNotificationStateWithGateway");
        expect(action).toContain("context.actorUserId");
        expect(action).toContain("notificationsFromTeacherSummary");
        expect(action).not.toContain("error instanceof Error ? error.message");
        expect(action).not.toContain("listTeacherCanonicalAttempts");
    });

    it("keeps canonical summary normalization and notification merging independently testable", () => {
        const helperPath = path("src/lib/teacherNotificationSummary.ts");
        expect(existsSync(helperPath)).toBe(true);
        const helper = readFileSync(helperPath, "utf8");

        expect(helper).toContain("normalizeTeacherNotificationSummary");
        expect(helper).toContain("notificationsFromTeacherSummary");
        expect(helper).toContain("mergeCanonicalTeacherNotifications");
        expect(helper).toContain("resolveTeacherNotificationRefresh");
    });

    it("routes the aggregate through one RPC instead of attempt payload reads", () => {
        const gatewayPath = path("src/lib/teacherNotificationSummaryGateway.ts");
        expect(existsSync(gatewayPath)).toBe(true);
        const gateway = readFileSync(gatewayPath, "utf8");

        expect(gateway).toContain('rpc("omr_teacher_notification_summary_v1"');
        expect(gateway).not.toContain("omr_attempts");
        expect(gateway).not.toContain("studentQuestions");
    });

    it("refreshes canonical counts only while visible and fences stale or unmounted responses", () => {
        const bell = readFileSync(path("src/components/NotificationBell.tsx"), "utf8");

        expect(bell).toContain("loadTeacherNotificationSummary");
        expect(bell).toContain("refreshGenerationRef");
        expect(bell).toContain('document.visibilityState === "hidden"');
        expect(bell).toContain("refreshGenerationRef.current += 1");
        expect(bell).toContain("resolveTeacherNotificationRefresh");
        expect(bell).toContain("storageNamespaceRef");
        expect(bell).toContain("mutateTeacherNotificationState");
        expect(bell).toContain('"mark_read"');
        expect(bell).toContain('"dismiss"');
        expect(bell).toContain("알림 삭제");
        expect(bell).not.toContain("applyAutoNotifications(localAuto)");
    });

    it("requires the latest readiness probe to attest the exact notification RPC", () => {
        const probe = readFileSync(path("src/lib/supabaseReadinessProbe.ts"), "utf8");
        const boundary = readFileSync(path("supabase/production-server-boundary.sql"), "utf8");

        expect(probe).toContain('SUPABASE_READINESS_VERSION = "202608080006"');
        expect(probe).toContain('"teacherNotificationSummaryReady"');
        expect(probe).toContain('"teacherNotificationStateReady"');
        expect(boundary).toContain("v_teacher_notification_summary_ready");
        expect(boundary).toContain("v_teacher_notification_state_ready");
        expect(boundary).toContain("public.omr_teacher_notification_summary_v1(text)");
        expect(boundary).toContain("public.omr_load_teacher_notification_state_v1(text,text,text[])");
        expect(boundary).toContain("'teacherNotificationSummaryReady'");
        expect(boundary).toContain("'teacherNotificationStateReady'");
    });
});
