import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
    base: {
        testDir: "./e2e",
        testMatch: /security-contract/,
        fullyParallel: false,
        forbidOnly: true,
        retries: 0,
        workers: 1,
        reporter: [["list"]],
        use: { baseURL: "http://localhost:3103", trace: "retain-on-failure" },
        webServer: { command: "synthetic-server", env: { FIXTURE_LABEL: "synthetic" } },
        projects: [
            { name: "prod-chromium", use: { viewport: { width: 1280, height: 720 } } },
            { name: "prod-webkit-ipad", use: { viewport: { width: 834, height: 1194 }, isMobile: true } },
        ],
    },
}));

// Exercise composition without evaluating the existing server-fixture config.
vi.mock("../../playwright.production.config", () => ({ default: fixture.base }));
vi.mock("@playwright/test", () => ({ defineConfig: (config: unknown) => config }));

import ciConfig from "../../playwright.production.ci.config";

describe("production CI browser selection", () => {
    it("selects full Chromium only for the existing Chromium project", () => {
        expect(ciConfig.projects?.[0].name).toBe("prod-chromium");
        expect(ciConfig.projects?.[0].use?.channel).toBe("chromium");
        expect(ciConfig.projects?.[0].use?.viewport).toBe(fixture.base.projects[0].use.viewport);
    });

    it("retains the WebKit project object and options unchanged", () => {
        expect(ciConfig.projects?.[1]).toBe(fixture.base.projects[1]);
        expect(ciConfig.projects?.[1].use).not.toHaveProperty("channel");
    });

    it("retains every base option except the composed project array", () => {
        for (const [key, value] of Object.entries(fixture.base)) {
            if (key === "projects") continue;
            expect(Reflect.get(ciConfig, key)).toBe(value);
        }
    });

    it("does not mutate the original Chromium project or base fixture", () => {
        expect(fixture.base.projects[0].use).not.toHaveProperty("channel");
        expect(ciConfig.webServer).toBe(fixture.base.webServer);
        expect(ciConfig.retries).toBe(0);
        expect(ciConfig.workers).toBe(1);
    });

    it("uses the composed config in the existing production-security CI step", () => {
        const workflow = readFileSync(join(process.cwd(), ".github/workflows/ci.yml"), "utf8");
        expect(workflow).toContain("- name: Production security E2E");
        expect(workflow).toContain("run: npx playwright test --config=playwright.production.ci.config.ts");
    });
});
