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

describe("CI quality gates", () => {
    it("gates lint-and-test on the production dependency audit", () => {
        const job = extractBlock("lint-and-test", 2);
        const setupNode = stepIndex(job, "uses: actions/setup-node@v4");
        const audit = stepIndex(job, "name: Production dependency audit");
        const install = stepIndex(job, "name: Install");

        expect(setupNode).toBeGreaterThanOrEqual(0);
        expect(audit).toBeGreaterThan(setupNode);
        expect(install).toBeGreaterThan(audit);
        expect(
            extractStep(job, "name: Production dependency audit")
                .split("\n")
                .map((line) => line.trim()),
        ).toContain("run: npm audit --package-lock-only --omit=dev --audit-level=high");
    });

    it("runs the live Supabase contract on Ubuntu after lint-and-test", () => {
        const job = extractBlock("supabase-live-contract", 2);
        const lines = job.split("\n").map((line) => line.trim());
        const setupNode = stepIndex(job, "uses: actions/setup-node@v4");
        const install = lineIndex(job, "run: npm ci");
        const liveContract = lineIndex(job, "run: npm run test:supabase:live");

        expect(lines).toContain("runs-on: ubuntu-latest");
        expect(lines).toContain("needs: lint-and-test");
        expect(setupNode).toBeGreaterThanOrEqual(0);
        expect(install).toBeGreaterThan(setupNode);
        expect(liveContract).toBeGreaterThan(install);
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
