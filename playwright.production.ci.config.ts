import { defineConfig } from "@playwright/test";
import productionConfig from "./playwright.production.config";

// Preserve the security suite and fixture configuration while using the full
// Chromium new-headless binary instead of the legacy headless shell.
// https://playwright.dev/docs/browsers#chromium-new-headless-mode
export default defineConfig({
    ...productionConfig,
    projects: productionConfig.projects?.map(project => project.name === "prod-chromium"
        ? { ...project, use: { ...project.use, channel: "chromium" } }
        : project),
});
