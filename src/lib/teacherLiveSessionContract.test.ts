import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const migrationPath = join(root, "supabase/migrations/202608060020_teacher_live_attempt_sessions.sql");

describe("teacher durable live session SQL contract", () => {
    it("defines answer-free bounded projection and service-role-only atomic force finish", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const sql = readFileSync(migrationPath, "utf8").toLowerCase();
        const projection = sql.slice(
            sql.indexOf("create or replace function public.omr_list_active_attempt_sessions_v1"),
            sql.indexOf("create or replace function public.omr_prepare_teacher_force_finish_sessions_v1"),
        );

        expect(sql).toContain("omr_list_active_attempt_sessions_v1");
        expect(sql).toContain("p_limit not between 1 and 101");
        expect(sql).toContain("answered_count");
        expect(sql).toContain("total_question_count");
        expect(projection).not.toContain("grading_snapshot");
        expect(projection).not.toContain("answers jsonb");

        expect(sql).toContain("omr_prepare_teacher_force_finish_sessions_v1");
        expect(sql).toContain("omr_force_finish_attempt_sessions_v1");
        expect(sql).toContain("for update");
        expect(sql).toContain("expected_revision");
        expect(sql).toContain("expected_answers");
        expect(sql).toContain("expected_grading_snapshot");
        expect(sql).toContain("omr_submit_session_attempt_v1");
        expect(sql).toContain("submitted_attempt_id = v_session.attempt_id");
        expect(sql).toContain("omr_teacher_attempt_write_allowed_v1");
        expect(sql).toContain("attempt class assignment denied");

        for (const signature of [
            "omr_list_active_attempt_sessions_v1(text,text,text,text,integer)",
            "omr_prepare_teacher_force_finish_sessions_v1(text,text[],text,text)",
            "omr_force_finish_attempt_sessions_v1(text,text[],timestamptz,text,text,text,jsonb)",
        ]) {
            expect(sql).toContain(`revoke all on function public.${signature} from public, anon, authenticated`);
            expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
        }

        const boundary = readFileSync(join(root, "supabase/production-server-boundary.sql"), "utf8");
        const readiness = readFileSync(join(root, "src/lib/supabaseReadinessProbe.ts"), "utf8");
        expect(boundary).toContain("teacherLiveSessionsReady");
        expect(boundary).toContain("'version', '202608080007'");
        expect(readiness).toContain('SUPABASE_READINESS_VERSION = "202608080007"');
        expect(readiness).toContain('"teacherLiveSessionsReady"');

    });

    it("wires active sessions into the real teacher live poll and force-finish path", () => {
        const page = readFileSync(join(root, "src/app/teacher/live/page.tsx"), "utf8");
        const action = readFileSync(join(root, "src/app/actions/teacherAttempts.ts"), "utf8");
        expect(page).toContain("loadTeacherActiveAttemptSessions");
        expect(page).toContain("forceFinishTeacherAttemptSessions");
        expect(page).toContain("activeSessions");
        expect(action).toContain("listTeacherCanonicalActiveAttemptSessions");
        expect(action).toContain("forceFinishTeacherCanonicalAttemptSessions");
    });
});
