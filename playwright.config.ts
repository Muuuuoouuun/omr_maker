import { defineConfig, devices } from "@playwright/test";

const externalBaseURL = process.env.PLAYWRIGHT_BASE_URL;
const baseURL = externalBaseURL || "http://localhost:3003";

export default defineConfig({
    testDir: "./e2e",
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    workers: process.env.CI ? 1 : undefined,
    reporter: [["list"]],
    use: {
        baseURL,
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            testIgnore: /pwa-mobile\.spec\.ts/,
            use: { ...devices["Desktop Chrome"] },
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
    ],
    webServer: externalBaseURL ? undefined : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
