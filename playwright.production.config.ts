import { defineConfig, devices } from "@playwright/test";
import { execFileSync } from "node:child_process";

const port = Number(process.env.PLAYWRIGHT_PRODUCTION_PORT || 3103);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid local production test port");
const baseURL = `http://localhost:${port}`;
const build = process.env.OMR_PRODUCTION_EXPECTED_BUILD || execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
process.env.OMR_PRODUCTION_EXPECTED_BUILD = build;

export default defineConfig({
    testDir: "./e2e",
    testMatch: /(?:production-security|teacher-provisioned-links)\.spec\.ts/,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: [["list"]],
    use: {
        baseURL,
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "prod-chromium",
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "prod-webkit-ipad",
            use: { ...devices["iPad Pro 11"] },
        },
    ],
    webServer: {
        command: `npm run start -- -H 127.0.0.1 -p ${port}`,
        url: baseURL,
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
            ...process.env,
            VERCEL_GIT_COMMIT_SHA: build,
            GIT_SHA: build,
            // Neutralize developer-local account JSON — TEACHER_ACCOUNTS takes
            // precedence over TEACHER_LOGIN_ID/TEACHER_PASSWORD when present.
            TEACHER_ACCOUNTS: "",
            TEACHER_LOGIN_ID: "admin",
            TEACHER_NAME: "Demo Admin",
            TEACHER_PASSWORD: "admin123",
            TEACHER_SESSION_SECRET: "e2e-production-teacher-session-secret",
            OMR_ALLOW_INSECURE_TEACHER_COOKIE_FOR_LOCAL_E2E: "true",
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
            SUPABASE_URL: "",
            SUPABASE_SERVICE_ROLE_KEY: "",
            OMR_SUPABASE_SERVICE_ROLE_KEY: "",
            GEMINI_API_KEY: "",
        },
    },
});
