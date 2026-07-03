import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
    testDir: "./e2e",
    testMatch: /(?:full-journey|teacher-pages)\.spec\.ts/,
    grep: /Teacher and student full journey|issued student start code gates the student portal login/,
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: 1,
    reporter: [["list"]],
    use: {
        baseURL: "http://localhost:3003",
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
        command: "npm run start -- -p 3003",
        url: "http://localhost:3003",
        reuseExistingServer: false,
        timeout: 60_000,
        env: {
            ...process.env,
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
        },
    },
});
