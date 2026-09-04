import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseBrowserAuthConfig } from "./supabaseBrowserAuth";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("teacher self-serve signup", () => {
    it("requires both public Supabase values in the browser", () => {
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_public");
        expect(getSupabaseBrowserAuthConfig()).toEqual({
            url: "https://example.supabase.co",
            publishableKey: "sb_publishable_public",
        });

        vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");
        vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
        expect(getSupabaseBrowserAuthConfig()).toBeNull();
    });

    it("offers passwordless email and Google while keeping students on quick entry", () => {
        const signup = source("src/app/signup/page.tsx");
        expect(signup).toContain("signInWithOtp");
        expect(signup).toContain("shouldCreateUser: true");
        expect(signup).toContain('provider: "google"');
        expect(signup).toContain("학생은 회원가입 없이");
    });

    it("exchanges a verified provider session for the existing signed teacher session", () => {
        const callback = source("src/app/auth/callback/page.tsx");
        const action = source("src/app/actions/auth.ts");
        expect(callback).toContain("startSupabaseTeacherSession");
        expect(callback).toContain("saveTeacherSessionWithIdentity");
        expect(action).toContain("verifySupabaseAuthAccessToken");
        expect(action).toContain("bootstrapWorkspaceWithServiceRole");
        expect(action).toContain("createSignedTeacherSessionCookie");
        expect(action).toContain("if (!authConfig.ready)");
    });
});
