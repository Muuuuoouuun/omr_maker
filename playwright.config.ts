import { defineConfig, devices } from "@playwright/test";

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
        baseURL: "http://localhost:3003",
        trace: "on-first-retry",
    },
    projects: [
        {
            name: "chromium",
            use: { ...devices["Desktop Chrome"] },
        },
    ],
    webServer: {
        command: "npm run dev",
        url: "http://localhost:3003",
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
    },
});
