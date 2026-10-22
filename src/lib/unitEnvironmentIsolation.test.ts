import { afterEach, describe, expect, it, vi } from "vitest";

const isolatedServiceVariables = [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_PUBLISHABLE_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
] as const;

afterEach(() => { vi.unstubAllEnvs(); });

describe("unit worker service configuration isolation", () => {
    it.each(isolatedServiceVariables)("starts %s empty even when the host provides it", name => {
        // Check only a boolean: a failing test must not serialize a host secret.
        expect(process.env[name] === "").toBe(true);
    });

    it("permits an explicit fixture override and restores the isolated baseline", () => {
        const fixtureUrl = "https://explicit-unit-fixture.invalid";
        vi.stubEnv("SUPABASE_URL", fixtureUrl);
        expect(process.env.SUPABASE_URL === fixtureUrl).toBe(true);
        vi.unstubAllEnvs();
        expect(process.env.SUPABASE_URL === "").toBe(true);
        expect(isolatedServiceVariables.every(name => process.env[name] === "")).toBe(true);
    });
});
