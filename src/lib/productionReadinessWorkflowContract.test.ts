import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/production-readiness.yml"), "utf8");
const defaultBranchOnly = "if: github.ref == format('refs/heads/{0}', github.event.repository.default_branch)";

function hasDefaultBranchOnlyGate(candidate: string): boolean {
    return candidate.split("\n").some((line) => line.trim() === defaultBranchOnly);
}

describe("production readiness workflow release identity", () => {
    it.each(["preview_deployment_id", "preview_artifact_digest", "preview_attestation_signature"])(
        "requires the %s dispatch input",
        (input) => {
            expect(workflow).toMatch(new RegExp(
                `      ${input}:\\n(?:        .+\\n)*?        required: true\\n`,
            ));
        },
    );

    it("checks out the exact expected build", () => {
        expect(workflow).toContain("          ref: ${{ inputs.expected_build }}");
        expect(workflow).toContain("          fetch-depth: 0");
        expect(workflow).not.toContain("          ref: ${{ github.event.repository.default_branch }}");
    });

    it("rejects a historical build before checkout or repository-controlled execution", () => {
        const workflowGate = "- name: Verify requested build matches trusted workflow revision";
        const equalityCheck = 'test "$OMR_PRODUCTION_EXPECTED_BUILD" = "$WORKFLOW_SHA"';
        const gate = workflow.indexOf(workflowGate);
        const equality = workflow.indexOf(equalityCheck);
        const checkout = workflow.indexOf("- uses: actions/checkout@v4");
        const setupNode = workflow.indexOf("- uses: actions/setup-node@v4");
        const install = workflow.indexOf("run: npm ci");
        const verifier = workflow.indexOf("- name: Verify hosted production deployment");

        expect(gate).toBeGreaterThan(-1);
        expect(workflow.slice(gate, checkout)).toContain("WORKFLOW_SHA: ${{ github.sha }}");
        expect(equality).toBeGreaterThan(gate);
        expect(equality).toBeLessThan(checkout);
        expect(equality).toBeLessThan(setupNode);
        expect(equality).toBeLessThan(install);
        expect(equality).toBeLessThan(verifier);

        const historical = spawnSync("sh", ["-c", equalityCheck], {
            env: {
                ...process.env,
                OMR_PRODUCTION_EXPECTED_BUILD: "a".repeat(40),
                WORKFLOW_SHA: "b".repeat(40),
            },
        });
        expect(historical.status).not.toBe(0);
    });

    it("rejects a workflow shape that is not restricted to the protected default branch", () => {
        expect(hasDefaultBranchOnlyGate(workflow)).toBe(true);
        expect(hasDefaultBranchOnlyGate(workflow.replace(defaultBranchOnly, "if: always()"))).toBe(false);
        expect(hasDefaultBranchOnlyGate(workflow.replace(
            defaultBranchOnly,
            `${defaultBranchOnly} || github.ref == 'refs/heads/untrusted'`,
        ))).toBe(false);
    });

    it("checks exact HEAD and default-branch ancestry before repository-controlled commands", () => {
        const gateStart = workflow.indexOf("- name: Verify trusted immutable verifier checkout");
        const setupNode = workflow.indexOf("- uses: actions/setup-node@v4");
        const install = workflow.indexOf("run: npm ci");
        const verifier = workflow.indexOf("- name: Verify hosted production deployment");
        const gate = workflow.slice(gateStart, setupNode);
        const runBlock = gate.slice(gate.indexOf("run: |"));

        expect(gateStart).toBeGreaterThan(-1);
        expect(gate).toContain("OMR_PRODUCTION_EXPECTED_BUILD: ${{ inputs.expected_build }}");
        expect(gate).toContain("OMR_PRODUCTION_DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}");
        expect(runBlock).toContain('test "$(git rev-parse --verify HEAD)" = "$OMR_PRODUCTION_EXPECTED_BUILD"');
        expect(runBlock).toContain('git rev-parse --verify "origin/$OMR_PRODUCTION_DEFAULT_BRANCH^{commit}"');
        expect(runBlock).toContain('git merge-base --is-ancestor "$OMR_PRODUCTION_EXPECTED_BUILD" "origin/$OMR_PRODUCTION_DEFAULT_BRANCH"');
        expect(runBlock).not.toContain("${{");
        expect(workflow.indexOf("git merge-base --is-ancestor")).toBeLessThan(setupNode);
        expect(workflow.indexOf("git merge-base --is-ancestor")).toBeLessThan(install);
        expect(workflow.indexOf("git merge-base --is-ancestor")).toBeLessThan(verifier);
    });

    it("passes preview identity through verifier environment without shell logging", () => {
        expect(workflow).toContain(
            "          OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID: ${{ inputs.preview_deployment_id }}",
        );
        expect(workflow).toContain(
            "          OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST: ${{ inputs.preview_artifact_digest }}",
        );
        expect(workflow).toContain(
            "          OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE: ${{ inputs.preview_attestation_signature }}",
        );
        expect(workflow).toContain(
            "          OMR_RELEASE_ATTESTATION_SECRET: ${{ secrets.OMR_RELEASE_ATTESTATION_SECRET }}",
        );
        expect(workflow).not.toMatch(/run:.*preview_(?:deployment_id|artifact_digest|attestation_signature)/);
        expect(workflow).not.toMatch(/(?:echo|print|set -x).*OMR_PRODUCTION_/);
    });
});
