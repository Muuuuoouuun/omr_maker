import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
    process.cwd(),
    "supabase/migrations/202608060025_teacher_session_revocation.sql",
);
const assertionPath = resolve(
    process.cwd(),
    "supabase/teacher-session-revocation-assertions.sql",
);

describe("teacher session revocation migration contract", () => {
    it("adds a monotonic JavaScript-safe account session generation", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const migration = readFileSync(migrationPath, "utf8");

        expect(migration).toMatch(/add column if not exists session_generation bigint not null default 1/i);
        expect(migration).toMatch(/session_generation\s*=\s*session_generation\s*\+\s*1/i);
        expect(migration).toContain("9007199254740991");
        expect(migration).toMatch(/where id = v_account_id and status = 'active'/i);
        expect(migration).toContain("omr_teacher_accounts_advance_session_on_disable");
        expect(migration).toMatch(/old\.status = 'active' and new\.status <> 'active'/i);
        expect(migration).toMatch(/new\.session_generation\s*:=\s*old\.session_generation\s*\+\s*1/i);
    });

    it("exposes only an exact active-generation boolean RPC to the service role", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const migration = readFileSync(migrationPath, "utf8").toLowerCase();

        expect(migration).toContain("omr_validate_teacher_session_v1");
        expect(migration).toContain("account.status = 'active'");
        expect(migration).toContain("account.session_generation = p_session_generation");
        expect(migration).toContain(
            "revoke all on function public.omr_validate_teacher_session_v1(text, bigint) from public, anon, authenticated",
        );
        expect(migration).toContain(
            "grant execute on function public.omr_validate_teacher_session_v1(text, bigint) to service_role",
        );
        expect(migration).not.toMatch(/grant\s+(select|insert|update|delete|all)\s+on\s+(table\s+)?public\.omr_teacher_accounts/i);
    });

    it("returns the generation only through the existing server-only login lookup", () => {
        expect(existsSync(migrationPath)).toBe(true);
        if (!existsSync(migrationPath)) return;
        const migration = readFileSync(migrationPath, "utf8").toLowerCase();

        expect(migration).toMatch(/returns table\s*\([\s\S]*session_generation bigint[\s\S]*\)/i);
        expect(migration).toContain("account.session_generation");
        expect(migration).toContain(
            "revoke all on function public.omr_lookup_teacher_account_v1(text) from public, anon, authenticated",
        );
        expect(migration).toContain(
            "grant execute on function public.omr_lookup_teacher_account_v1(text) to service_role",
        );
    });

    it("ships a PostgreSQL fixture for reset, disable, and reactivation revocation", () => {
        expect(existsSync(assertionPath)).toBe(true);
        if (!existsSync(assertionPath)) return;
        const sql = readFileSync(assertionPath, "utf8").toLowerCase();

        expect(sql).toContain("omr_complete_teacher_password_reset_v1");
        expect(sql).toContain("omr_validate_teacher_session_v1");
        expect(sql).toContain("password reset did not revoke generation 1");
        expect(sql).toContain("disable did not revoke generation 2");
        expect(sql).toContain("reactivation revived a revoked generation");
        expect(sql).toContain("rollback;");
    });
});
