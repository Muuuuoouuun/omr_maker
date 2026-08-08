import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const packageJson = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
) as { engines?: { node?: string } };
const ciWorkflow = readFileSync(
    join(root, ".github/workflows/ci.yml"),
    "utf8",
);
const productionReadinessWorkflow = readFileSync(
    join(root, ".github/workflows/production-readiness.yml"),
    "utf8",
);

function versionTuple(version: string): [number, number, number] {
    const match = version.match(/^(?:>=)?(\d+)\.(\d+)\.(\d+)$/);

    expect(match, `invalid Node version: ${version}`).not.toBeNull();

    return [Number(match![1]), Number(match![2]), Number(match![3])];
}

function versionNumber(version: string): number {
    const [major, minor, patch] = versionTuple(version);
    return major * 1_000_000 + minor * 1_000 + patch;
}

function extractNodeVersions(workflow: string): string[] {
    return Array.from(
        workflow.matchAll(/^\s*node-version:\s*"([^"\r\n]+)"\s*$/gm),
        (match) => match[1],
    );
}

describe("Node runtime contract", () => {
    it("extracts only double-quoted Node versions", () => {
        const invalidQuoting = [
            "node-version: 22.13.0",
            "node-version: '22.13.0'",
            "node-version: \"22.13.0'",
            "node-version: '22.13.0\"",
        ].join("\n");

        expect(extractNodeVersions(invalidQuoting)).toEqual([]);
        expect(extractNodeVersions('node-version: "22.13.0"')).toEqual([
            "22.13.0",
        ]);
    });

    it("requires a package engine of at least Node 22.13.0", () => {
        const engine = packageJson.engines?.node;

        expect(engine).toBeDefined();
        expect(versionNumber(engine!)).toBeGreaterThanOrEqual(
            versionNumber("22.13.0"),
        );
    });

    it("pins every executable workflow to Node 22.13.0", () => {
        expect(extractNodeVersions(ciWorkflow)).toEqual(
            Array(6).fill("22.13.0"),
        );
        expect(extractNodeVersions(productionReadinessWorkflow)).toEqual([
            "22.13.0",
        ]);
    });
});
