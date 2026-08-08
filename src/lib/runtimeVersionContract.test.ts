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
const canonicalNodeVersion = 'node-version: "22.13.0"';

function extractNodeVersionDeclarations(workflow: string): string[] {
    return workflow
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("node-version:"));
}

describe("Node runtime contract", () => {
    it("captures every raw node-version declaration before validation", () => {
        const declarations = [
            canonicalNodeVersion,
            "node-version: 22.13.0",
            "node-version: '22.13.0'",
            "node-version: \"22.13.0'",
            "node-version: '22.13.0\"",
            'node-version: "20"',
        ];
        const indentedDeclarations = declarations
            .map((line) => `          ${line}  `)
            .join("\n");

        expect(extractNodeVersionDeclarations(indentedDeclarations)).toEqual(
            declarations,
        );
    });

    it("requires the exact package Node engine", () => {
        expect(packageJson.engines?.node).toBe(">=22.13.0");
    });

    it("pins every raw workflow declaration to quoted Node 22.13.0", () => {
        expect(extractNodeVersionDeclarations(ciWorkflow)).toEqual(
            Array(6).fill(canonicalNodeVersion),
        );
        expect(
            extractNodeVersionDeclarations(productionReadinessWorkflow),
        ).toEqual([canonicalNodeVersion]);
    });

    it("uses locked installs in every workflow job that installs dependencies", () => {
        const lockedInstalls = (workflow: string) =>
            workflow
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line === "run: npm ci");

        expect(lockedInstalls(ciWorkflow)).toEqual(Array(5).fill("run: npm ci"));
        expect(lockedInstalls(productionReadinessWorkflow)).toEqual([
            "run: npm ci",
        ]);
    });
});
