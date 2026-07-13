import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL || "http://localhost:3003";
const enableWebKitPwa = process.env.PLAYWRIGHT_ENABLE_WEBKIT === "1";
const webKitPwaProjects = enableWebKitPwa ? [
    {
        name: "mobile-ios-webkit-pwa",
        testMatch: /pwa-mobile\.spec\.ts/,
        use: { ...devices["iPhone 13"], browserName: "webkit" as const },
    },
    {
        name: "tablet-ios-webkit-pwa",
        testMatch: /pwa-mobile\.spec\.ts/,
        use: { ...devices["iPad Pro 11"], browserName: "webkit" as const },
    },
    {
        name: "tablet-ios-webkit-landscape-pwa",
        testMatch: /pwa-mobile\.spec\.ts/,
        use: { ...devices["iPad Pro 11 landscape"], browserName: "webkit" as const },
    },
] : [];

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI || enableWebKitPwa ? 1 : undefined,
    reporter: [["list"]],
    use: {
        baseURL,
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            testIgnore: /(?:pwa-mobile|teacher-mobile)\.spec\.ts/,
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "webkit",
            testIgnore: /(?:pwa-mobile|teacher-mobile)\.spec\.ts/,
            use: { ...devices["Desktop Safari"] },
        },
        {
            name: "webkit-ipad",
            testIgnore: /(?:pwa-mobile|teacher-mobile)\.spec\.ts/,
            use: { ...devices["iPad Pro 11"] },
        },
        {
            name: "mobile-chrome-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["Pixel 5"], browserName: "chromium" },
        },
        {
            name: "mobile-ios-like-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["iPhone 13"], browserName: "chromium" },
        },
        {
            name: "tablet-android-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["Galaxy Tab S9"], browserName: "chromium" },
        },
        {
            name: "tablet-android-landscape-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["Galaxy Tab S9 landscape"], browserName: "chromium" },
        },
        {
            name: "tablet-ios-like-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["iPad Pro 11"], browserName: "chromium" },
        },
        {
            name: "tablet-ios-like-landscape-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["iPad Pro 11 landscape"], browserName: "chromium" },
        },
        ...webKitPwaProjects,
        {
            name: "teacher-mobile-chrome",
            testMatch: /teacher-mobile\.spec\.ts/,
            use: { ...devices["Pixel 5"], browserName: "chromium" },
        },
        {
            name: "teacher-tablet-ios-like",
            testMatch: /teacher-mobile\.spec\.ts/,
            use: { ...devices["iPad Pro 11"], browserName: "chromium" },
        },
    ],
    webServer: externalBaseURL ? undefined : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
        env: {
            ...process.env,
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
            // Neutralize developer-local teacher accounts (.env.local) so the
            // deterministic dev default (admin/admin123) that e2e helpers use
            // always applies. Next.js keeps existing (even empty) process.env
            // keys over .env.local values.
            TEACHER_ACCOUNTS: "",
            TEACHER_LOGIN_ID: "",
            TEACHER_PASSWORD: "",
            TEACHER_PLAN: "",
        },
    },
});
