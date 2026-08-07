import { defineConfig, devices } from "@playwright/test";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const e2eTeacherSessionSecret = "omr-maker-e2e-teacher-session-secret-2026";
process.env.TEACHER_SESSION_SECRET = e2eTeacherSessionSecret;

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL || "http://localhost:3003";
const enableWebKitPwa = process.env.PLAYWRIGHT_ENABLE_WEBKIT === "1";
const conditionalWebKitProjects = enableWebKitPwa ? [
    {
        name: "ios-se-webkit",
        testMatch: /ios-mobile-layout\.spec\.ts/,
        use: {
            ...devices["iPhone 13"],
            browserName: "webkit" as const,
            viewport: { width: 320, height: 568 },
        },
    },
    {
        name: "ios-standard-webkit",
        testMatch: /ios-mobile-layout\.spec\.ts/,
        use: {
            ...devices["iPhone 13"],
            browserName: "webkit" as const,
            viewport: { width: 393, height: 852 },
        },
    },
    {
        name: "ios-max-webkit",
        testMatch: /ios-mobile-layout\.spec\.ts/,
        use: {
            ...devices["iPhone 13"],
            browserName: "webkit" as const,
            viewport: { width: 430, height: 932 },
        },
    },
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
    {
        name: "mobile-ios-webkit-teacher",
        testMatch: /teacher-mobile\.spec\.ts/,
        use: { ...devices["iPhone 13"], browserName: "webkit" as const },
    },
    {
        name: "tablet-ios-webkit-teacher",
        testMatch: /teacher-mobile\.spec\.ts/,
        use: { ...devices["iPad Pro 11"], browserName: "webkit" as const },
    },
    {
        name: "tablet-ios-webkit-landscape-teacher",
        testMatch: /teacher-mobile\.spec\.ts/,
        use: { ...devices["iPad Pro 11 landscape"], browserName: "webkit" as const },
    },
] : [];

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    // The app is localStorage-heavy and starts through one dev server; serial
    // browser workers avoid intermittent page.goto aborts under load.
    workers: 1,
    reporter: [["list"]],
    use: {
        baseURL,
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            testIgnore: /(?:ios-mobile-layout|pwa-mobile|teacher-mobile)\.spec\.ts/,
            use: { ...devices["Desktop Chrome"] },
        },
        {
            name: "webkit",
            testIgnore: /(?:ios-mobile-layout|pwa-mobile|teacher-mobile)\.spec\.ts/,
            use: { ...devices["Desktop Safari"] },
        },
        {
            name: "webkit-ipad",
            testIgnore: /(?:ios-mobile-layout|pwa-mobile|teacher-mobile)\.spec\.ts/,
            use: { ...devices["iPad Pro 11"] },
        },
        {
            name: "mobile-chrome-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: { ...devices["Pixel 5"], browserName: "chromium" },
        },
        {
            name: "mobile-375-chrome-pwa",
            testMatch: /pwa-mobile\.spec\.ts/,
            use: {
                ...devices["Pixel 5"],
                browserName: "chromium",
                viewport: { width: 375, height: 812 },
            },
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
        ...conditionalWebKitProjects,
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
        reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1",
        timeout: 60_000,
        env: {
            ...process.env,
            OMR_PLAN_DEV_SIMULATION: "1",
            OMR_DEV_PLAN: "free",
            TEACHER_SESSION_SECRET: e2eTeacherSessionSecret,
            TEACHER_ACCOUNTS: JSON.stringify([{
                id: "admin",
                email: "admin@example.com",
                name: "E2E Admin",
                password: "admin123",
                organizationId: "default",
                organizationName: "E2E Workspace",
                memberRole: "admin",
            }]),
            OMR_TEACHER_ACCOUNTS: "",
            TEACHER_LOGIN_ID: "admin",
            TEACHER_PASSWORD: "admin123",
            TEACHER_PASSWORD_HASH: "",
            NEXT_PUBLIC_SUPABASE_URL: "",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "",
            NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
            TEACHER_PLAN: "",
            SUPABASE_URL: "",
            SUPABASE_SERVICE_ROLE_KEY: "",
            OMR_SUPABASE_SERVICE_ROLE_KEY: "",
            STUDENT_ATTEMPT_SECRET: "",
            OMR_STUDENT_ATTEMPT_SECRET: "",
            STUDENT_SESSION_SECRET: "omr-maker-e2e-student-session-secret-2026",
            OMR_E2E_STUDENT_SUBMISSION_SIMULATION: "1",
            OMR_E2E_STUDENT_SUBMISSION_EXAM_ID: "e2e-korean-integrated-exam",
            OMR_E2E_STUDENT_SUBMISSION_EXAM_TITLE: "E2E 국어 통합 시험",
            OMR_E2E_STUDENT_SUBMISSION_ANSWER_KEY: "2,3,4",
        },
    },
});
