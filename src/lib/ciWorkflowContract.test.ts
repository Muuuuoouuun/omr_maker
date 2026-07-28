import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
    join(process.cwd(), ".github/workflows/ci.yml"),
    "utf8",
);

function extractBlock(key: string, indent: number, source = workflow): string {
    const prefix = `${" ".repeat(indent)}${key}:`;
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line === prefix);

    expect(start, `missing ${key} block`).toBeGreaterThanOrEqual(0);

    let end = start + 1;
    while (
        end < lines.length
        && (lines[end].trim() === "" || lines[end].search(/\S/) > indent)
    ) {
        end += 1;
    }

    return lines.slice(start, end).join("\n");
}

function stepIndex(job: string, heading: string): number {
    return job.split("\n").findIndex((line) => line.trim() === `- ${heading}`);
}

function lineIndex(source: string, value: string): number {
    return source.split("\n").findIndex((line) => line.trim() === value);
}

function extractStep(job: string, heading: string): string {
    const lines = job.split("\n");
    const start = stepIndex(job, heading);

    expect(start, `missing ${heading} step`).toBeGreaterThanOrEqual(0);

    let end = start + 1;
    while (end < lines.length && !/^ {6}- /.test(lines[end])) {
        end += 1;
    }

    return lines.slice(start, end).join("\n");
}

function extractCheckoutSteps(source = workflow): string[] {
    const lines = source.split("\n");
    const starts = lines.flatMap((line, index) =>
        line.trim().startsWith("- uses: actions/checkout@") ? [index] : [],
    );

    return starts.map((start) => {
        const indent = lines[start].search(/\S/);
        let end = start + 1;
        while (end < lines.length && !new RegExp(`^ {${indent}}- `).test(lines[end])) {
            end += 1;
        }
        return lines.slice(start, end).join("\n");
    });
}

describe("CI quality gates", () => {
    it("limits execution and permissions at the workflow level", () => {
        const triggers = extractBlock("on", 0);
        const push = extractBlock("push", 2, triggers);
        const pullRequest = extractBlock("pull_request", 2, triggers);
        const concurrency = extractBlock("concurrency", 0);
        const permissions = extractBlock("permissions", 0);

        expect(push.split("\n").map((line) => line.trim())).toContain(
            'branches: [main, "premier0.1"]',
        );
        expect(pullRequest.split("\n").map((line) => line.trim())).toContain(
            'branches: [main, "premier0.1"]',
        );
        expect(concurrency.split("\n").map((line) => line.trim())).toEqual(
            expect.arrayContaining([
                "group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}",
                "cancel-in-progress: true",
            ]),
        );
        expect(permissions.split("\n").map((line) => line.trim())).toContain(
            "contents: read",
        );
    });

    it("hardens every checkout and rejects bypasses for CI gates", () => {
        const checkouts = extractCheckoutSteps();
        const lines = workflow.split("\n").map((line) => line.trim());

        expect(checkouts.length).toBeGreaterThan(0);
        for (const checkout of checkouts) {
            expect(checkout.split("\n").map((line) => line.trim())).toContain(
                "persist-credentials: false",
            );
        }
        expect(lines).not.toContain("continue-on-error: true");
        expect(lines).not.toContain("if: false");
    });

    it("gates lint-and-test on production and desktop/build dependency audits", () => {
        const job = extractBlock("lint-and-test", 2);
        const setupNode = stepIndex(job, "uses: actions/setup-node@v4");
        const productionAudit = stepIndex(job, "name: Production dependency audit");
        const desktopAudit = stepIndex(job, "name: Desktop/build dependency audit");
        const install = stepIndex(job, "name: Install");

        expect(setupNode).toBeGreaterThanOrEqual(0);
        expect(productionAudit).toBeGreaterThan(setupNode);
        expect(desktopAudit).toBeGreaterThan(productionAudit);
        expect(install).toBeGreaterThan(desktopAudit);
        expect(
            extractStep(job, "name: Production dependency audit")
                .split("\n")
                .map((line) => line.trim()),
        ).toContain("run: npm audit --package-lock-only --omit=dev --audit-level=high");
        expect(
            extractStep(job, "name: Desktop/build dependency audit")
                .split("\n")
                .map((line) => line.trim()),
        ).toContain("run: node scripts/verify-desktop-dependency-audit.mjs");
    });

    it("runs the live Supabase contract directly on Ubuntu after lint-and-test", () => {
        const job = extractBlock("supabase-live-contract", 2);
        const lines = job.split("\n").map((line) => line.trim());
        const setupNode = stepIndex(job, "uses: actions/setup-node@v4");
        const liveContract = lineIndex(job, "run: node scripts/verify-supabase-live.mjs");

        expect(lines).toContain("runs-on: ubuntu-latest");
        expect(lines).toContain("needs: lint-and-test");
        expect(setupNode).toBeGreaterThanOrEqual(0);
        expect(lines).toContain('node-version: "20"');
        expect(lines).not.toContain('cache: "npm"');
        expect(lines).not.toContain("run: npm ci");
        expect(liveContract).toBeGreaterThan(setupNode);
    });

    it("packages and smoke-tests the Windows Electron runtime", () => {
        const job = extractBlock("desktop-windows-smoke", 2);
        const lines = job.split("\n").map((line) => line.trim());
        const setupNode = stepIndex(job, "uses: actions/setup-node@v4");
        const install = lineIndex(job, "run: npm ci");
        const pack = lineIndex(job, "run: npm run desktop:pack");
        const smoke = lineIndex(job, "run: npm run desktop:smoke:packaged");
        const timeout = Number(
            lines.find((line) => line.startsWith("timeout-minutes:"))?.split(":")[1],
        );

        expect(lines).toContain("runs-on: windows-latest");
        expect(lines).toContain("needs: lint-and-test");
        expect(timeout).toBeGreaterThanOrEqual(5);
        expect(timeout).toBeLessThanOrEqual(60);
        expect(setupNode).toBeGreaterThanOrEqual(0);
        expect(install).toBeGreaterThan(setupNode);
        expect(pack).toBeGreaterThan(install);
        expect(smoke).toBeGreaterThan(pack);
    });
});
