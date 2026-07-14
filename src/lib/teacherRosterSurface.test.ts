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
        expect(migration.indexOf("roster enrollment target scope mismatch"))
            .toBeLessThan(migration.indexOf("update public.omr_class_students row"));
        expect(migration).toContain("revoke all on function public.omr_save_roster_v1");
        expect(migration).toContain("grant execute on function public.omr_save_roster_v1");
        expect(migration).toContain("revoke all on public.omr_roster_invites from anon, authenticated");
    });
});
