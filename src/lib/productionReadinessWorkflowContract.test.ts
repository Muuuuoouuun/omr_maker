import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(resolve(".github/workflows/production-readiness.yml"), "utf8");

describe("production readiness workflow release identity", () => {
    it.each(["preview_deployment_id", "preview_artifact_digest"])(
        "requires the %s dispatch input",
        (input) => {
            expect(workflow).toMatch(new RegExp(
                `      ${input}:\\n(?:        .+\\n)*?        required: true\\n`,
            ));
        },
    );

    it("checks out the exact expected build", () => {
        expect(workflow).toContain("          ref: ${{ inputs.expected_build }}");
        expect(workflow).not.toContain("          ref: ${{ github.event.repository.default_branch }}");
    });

    it("checks HEAD equality before installing any repository code", () => {
        const headCheck = 'run: test "$(git rev-parse --verify HEAD)" = "$OMR_PRODUCTION_EXPECTED_BUILD"';
        expect(workflow).toContain(`        ${headCheck}`);
        expect(workflow.indexOf(headCheck)).toBeLessThan(workflow.indexOf("run: npm ci"));
    });

    it("passes preview identity through verifier environment without shell logging", () => {
        expect(workflow).toContain(
            "          OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID: ${{ inputs.preview_deployment_id }}",
        );
        expect(workflow).toContain(
            "          OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST: ${{ inputs.preview_artifact_digest }}",
        );
        expect(workflow).not.toMatch(/run:.*preview_(?:deployment_id|artifact_digest)/);
        expect(workflow).not.toMatch(/(?:echo|print|set -x).*OMR_PRODUCTION_/);
    });
});
