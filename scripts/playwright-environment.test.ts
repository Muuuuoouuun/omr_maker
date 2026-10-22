import { describe, expect, it, vi } from "vitest";
import type { PlaywrightTestConfig } from "@playwright/test";

// Load the real config/defineConfig, but never read developer .env files. Even a
// future regression must only serialize synthetic credentials in this test.
vi.mock("@next/env", () => ({ loadEnvConfig: vi.fn() }));

const syntheticCredentials = {
    OMR_UNRELATED_CREDENTIAL_SENTINEL: "synthetic-unrelated-secret-never-report",
    CLAUDE_API_KEY_KR1: "synthetic-claude-secret-never-report",
    VERCEL_TOKEN: "synthetic-vercel-secret-never-report",
    GEMINI_API_KEY: "synthetic-gemini-secret-never-report",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-supabase-secret-never-report",
    OMR_SUPABASE_SERVICE_ROLE_KEY: "synthetic-alternate-supabase-secret-never-report",
};

const configurations = [
    { name: "development", load: () => import("../playwright.config") },
    { name: "production", load: () => import("../playwright.production.config") },
    { name: "production CI", load: () => import("../playwright.production.ci.config") },
];

async function loadIsolatedConfig(load: () => Promise<{ default: PlaywrightTestConfig }>) {
    const originalEnvironment = process.env;
    // Do not spread originalEnvironment: the fixture is safe even when CI/cloud
    // has real credentials, and does not print or persist their values on failure.
    process.env = {
        NODE_ENV: "test",
        OMR_PRODUCTION_EXPECTED_BUILD: "synthetic-build-id",
        PLAYWRIGHT_PORT: "3195",
        PLAYWRIGHT_PRODUCTION_PORT: "3193",
        ...syntheticCredentials,
    };
    try {
        vi.resetModules();
        const config = (await load()).default;
        const serialized = JSON.stringify(config);
        const webServer = config.webServer;
        if (!webServer || Array.isArray(webServer)) throw new Error("Expected a local test server configuration");
        return {
            serialized,
            serverEnvironment: webServer.env,
            inheritedGeminiKey: process.env.GEMINI_API_KEY,
            inheritedSentinel: process.env.OMR_UNRELATED_CREDENTIAL_SENTINEL,
            command: webServer.command,
            baseURL: config.use?.baseURL,
        };
    } finally {
        process.env = originalEnvironment;
    }
}

describe("Playwright configuration report boundaries", () => {
    it.each(configurations)("$name serializes explicit test overrides without inherited secrets", async ({ name, load }) => {
        const result = await loadIsolatedConfig(load);
        // Serialization of the executed config reproduces the reporter boundary;
        // no source-string pattern check or mock replacement config is involved.
        for (const secret of Object.values(syntheticCredentials)) {
            expect(result.serialized).not.toContain(secret);
        }
        expect(result.serverEnvironment).not.toHaveProperty("OMR_UNRELATED_CREDENTIAL_SENTINEL");
        expect(result.serverEnvironment).not.toHaveProperty("CLAUDE_API_KEY_KR1");
        expect(result.serverEnvironment).not.toHaveProperty("VERCEL_TOKEN");
        // Inheritance remains available to the child. Isolation must override
        // Gemini/database credentials rather than mutate the parent environment.
        expect(result.inheritedSentinel).toBe(syntheticCredentials.OMR_UNRELATED_CREDENTIAL_SENTINEL);
        expect(result.inheritedGeminiKey).toBe(syntheticCredentials.GEMINI_API_KEY);
        expect(result.serverEnvironment).toMatchObject({
            GEMINI_API_KEY: "",
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
            SUPABASE_URL: "",
            SUPABASE_SERVICE_ROLE_KEY: "",
            OMR_SUPABASE_SERVICE_ROLE_KEY: "",
        });
        if (name === "development") {
            expect(result.baseURL).toBe("http://localhost:3195");
            expect(result.command).toContain("next dev");
            expect(result.serverEnvironment).toMatchObject({ OMR_ISOLATED_E2E: "1", OMR_PLAN_DEV_SIMULATION: "1", OMR_DEV_PLAN: "free" });
        } else {
            expect(result.baseURL).toBe("http://localhost:3193");
            expect(result.command).toContain("npm run start");
            expect(result.serverEnvironment).toMatchObject({ VERCEL_GIT_COMMIT_SHA: "synthetic-build-id", GIT_SHA: "synthetic-build-id" });
        }
    });
});
