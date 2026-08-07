import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("teacher notification state migration contract", () => {
    it("creates an RPC-only FORCE RLS state table with bounded retention", () => {
        const path = "supabase/migrations/202608060030_teacher_notification_state.sql";
        expect(existsSync(join(process.cwd(), path))).toBe(true);
        const sql = read(path);
        expect(sql).toContain("omr_teacher_notification_states");
        expect(sql).toContain("primary key (organization_id, teacher_user_id, notification_id)");
        expect(sql).toContain("enable row level security");
        expect(sql).toContain("force row level security");
        expect(sql).toContain("interval '14 days'");
        expect(sql).toContain("limit 64");
        expect(sql).toMatch(/revoke all on table public\.omr_teacher_notification_states\s+from public, anon, authenticated, service_role/);
    });

    it("exposes bounded service-role-only load and atomic mutation RPCs", () => {
        const sql = read("supabase/migrations/202608060030_teacher_notification_state.sql");
        expect(sql).toContain("omr_load_teacher_notification_state_v1");
        expect(sql).toContain("omr_mutate_teacher_notification_state_v1");
        expect(sql).toContain("security definer");
        expect(sql).toContain("cardinality(p_notification_ids) > 16");
        expect(sql).toContain("on conflict on constraint omr_teacher_notification_states_pkey do update");
        expect(sql).toContain("coalesce(public.omr_teacher_notification_states.dismissed_at, excluded.dismissed_at)");
        expect(sql).toMatch(/grant execute on function public\.omr_load_teacher_notification_state_v1\(text,text,text\[\]\)\s+to service_role/);
        expect(sql).toMatch(/grant execute on function public\.omr_mutate_teacher_notification_state_v1\(text,text,text,text\[\]\)\s+to service_role/);
        expect(sql).toMatch(/revoke all on function public\.omr_load_teacher_notification_state_v1\(text,text,text\[\]\)\s+from public, anon, authenticated, service_role/);
    });

    it("pins organization/user isolation, monotonic dismissal, retention, and privileges in PostgreSQL 17", () => {
        const assertionsPath = "supabase/teacher-notification-state-assertions.sql";
        expect(existsSync(join(process.cwd(), assertionsPath))).toBe(true);
        const assertions = read(assertionsPath);
        const verifier = read("scripts/verify-supabase-live.mjs");
        expect(assertions).toContain("notification state organization isolation failed");
        expect(assertions).toContain("notification state teacher isolation failed");
        expect(assertions).toContain("dismissal was resurrected by mark_read");
        expect(assertions).toContain("notification state retention cap failed");
        expect(assertions).toMatch(/has_function_privilege\(\s*'anon'/);
        expect(verifier).toContain('psqlFile("supabase/teacher-notification-state-assertions.sql")');
    });

    it("requires readiness to attest the table, FORCE RLS, exact RPCs, and denied browser access", () => {
        const boundary = read("supabase/production-server-boundary.sql");
        const readiness = read("src/lib/supabaseReadinessProbe.ts");
        expect(boundary).toContain("v_teacher_notification_state_ready");
        expect(boundary).toContain("public.omr_teacher_notification_states");
        expect(boundary).toContain("public.omr_load_teacher_notification_state_v1(text,text,text[])");
        expect(boundary).toContain("public.omr_mutate_teacher_notification_state_v1(text,text,text,text[])");
        expect(boundary).toContain("'teacherNotificationStateReady'");
        expect(readiness).toContain('"teacherNotificationStateReady"');
    });
});
