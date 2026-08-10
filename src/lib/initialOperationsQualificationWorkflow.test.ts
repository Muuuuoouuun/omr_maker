import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { load } = require("js-yaml") as {
    load(source: string): unknown;
};

const workflowPath = join(
    process.cwd(),
    ".github/workflows/initial-operations-qualification.yml",
);
const workflowSource = readFileSync(workflowPath, "utf8");
const productionPlaywrightSource = readFileSync(join(process.cwd(), "playwright.production.config.ts"), "utf8");
const workflow = load(workflowSource) as {
    on?: {
        workflow_dispatch?: {
            inputs?: Record<string, { default?: string; required?: boolean; type?: string }>;
        };
    };
    permissions?: Record<string, string>;
    concurrency?: Record<string, unknown>;
    jobs?: Record<string, {
        environment?: string;
        "runs-on"?: string;
        steps?: Array<Record<string, unknown>>;
    }>;
};

function qualificationSteps(): Array<Record<string, unknown>> {
    const steps = workflow.jobs?.qualification?.steps;
    expect(Array.isArray(steps)).toBe(true);
    return steps ?? [];
}

function namedStep(name: string): Record<string, unknown> {
    const step = qualificationSteps().find((candidate) => candidate.name === name);
    expect(step, `missing workflow step: ${name}`).toBeDefined();
    return step ?? {};
}

function stepIndex(name: string): number {
    return qualificationSteps().findIndex((step) => step.name === name);
}

describe("initial operations qualification workflow", () => {
    it("is manually dispatched with an exact immutable build identity", () => {
        const inputs = workflow.on?.workflow_dispatch?.inputs;

        expect(inputs?.build_sha).toMatchObject({ required: true, type: "string" });
        expect(inputs?.expected_readiness_version).toMatchObject({
            default: "202608090001",
            required: true,
            type: "string",
        });
        expect(workflow.permissions).toEqual({ contents: "read" });
        expect(workflow.concurrency).toEqual({
            group: "initial-operations-qualification",
            "cancel-in-progress": false,
        });
        expect(workflow.jobs?.qualification).toMatchObject({
            environment: "initial-operations-staging",
            "runs-on": "ubuntu-latest",
        });

        const inputGuard = String(namedStep("Validate qualification request and protected environment").run);
        const checkout = qualificationSteps().find((step) => String(step.uses).startsWith("actions/checkout@"));
        const headGuard = String(namedStep("Assert immutable checkout").run);

        expect(inputGuard).toContain("^[a-f0-9]{40}$");
        expect(inputGuard).toContain('test "$OMR_BUILD_SHA" = "$GITHUB_SHA"');
        expect(checkout?.uses).toMatch(/^actions\/checkout@[a-f0-9]{40}$/);
        expect(checkout?.with).toMatchObject({
            ref: "${{ inputs.build_sha }}",
            "fetch-depth": 0,
            "persist-credentials": false,
        });
        expect(headGuard).toContain('test "$(git rev-parse --verify HEAD)" = "$OMR_BUILD_SHA"');
        expect(headGuard).toContain("git diff --exit-code --no-ext-diff");
    });

    it("pins the runtime and executes every required gate in fail-closed order", () => {
        const setupNode = qualificationSteps().find((step) => String(step.uses).startsWith("actions/setup-node@"));
        expect(setupNode?.uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
        expect(setupNode?.with).toMatchObject({ "node-version": "22.13.0", cache: "npm" });

        const ordered = [
            "Install locked dependencies",
            "Run static supply-chain gates",
            "Run unit tests",
            "Build immutable application",
            "Run live PostgreSQL contract",
            "Verify immutable staging preview",
            "Run exact 80 + 10 + 10 initial workload",
            "Exercise external alert roundtrip",
            "Create staging backup",
            "Verify disposable restore and core journey",
            "Generate release score",
            "Seal qualification success",
        ].map(stepIndex);

        expect(ordered.every((index) => index >= 0)).toBe(true);
        expect(ordered).toEqual([...ordered].sort((left, right) => left - right));
        expect(String(namedStep("Install locked dependencies").run)).toContain("npm ci");
        expect(String(namedStep("Run static supply-chain gates").run)).toContain("npm run lint");
        expect(String(namedStep("Run static supply-chain gates").run)).toContain("npx tsc --noEmit");
        expect(String(namedStep("Run unit tests").run)).toContain("npm test");
        expect(String(namedStep("Build immutable application").run)).toContain("npm run build");
        expect(String(namedStep("Run live PostgreSQL contract").run)).toContain("npm run test:supabase:live");
        expect(String(namedStep("Run exact 80 + 10 + 10 initial workload").run)).toContain(
            "npm run test:ops:initial -- --run",
        );
        expect(String(namedStep("Exercise external alert roundtrip").run)).toContain("npm run ops:alert:verify");
        expect(String(namedStep("Verify disposable restore and core journey").run)).toContain("npm run ops:restore:verify");
        expect(String(namedStep("Generate release score").run)).toContain("npm run release:score");

        for (const step of qualificationSteps().filter((candidate) => typeof candidate.run === "string")) {
            expect(String(step.run).trimStart().startsWith("set -euo pipefail"), String(step.name)).toBe(true);
        }
        expect(workflowSource).not.toContain("continue-on-error:");
    });

    it("fails closed on missing protected state and production-target equality", () => {
        const guard = String(namedStep("Validate qualification request and protected environment").run);

        expect(guard).toContain('"status":"unverified"');
        expect(guard).toContain("missing_protected_environment");
        expect(guard).toContain('test "$STAGING_HOST" != "$PRODUCTION_HOST"');
        expect(guard).toContain('test "$STAGING_PROJECT_REF" != "$PRODUCTION_PROJECT_REF"');
        expect(guard).toContain("omr.initial-operations.environment:v1");
        expect(guard).toContain("omr.initial-operations.qualified-preview-host:v1");
        expect(guard).toContain('QUALIFIED_PREVIEW_ARTIFACT_DIGEST="${PREVIEW_ARTIFACT_DIGEST#sha256:}"');
        expect(guard).toContain("sha256sum");
        expect(String(namedStep("Run exact 80 + 10 + 10 initial workload").run)).toContain(
            '--confirm-load-fixture="initial-ops-100"',
        );
    });

    it("binds hosted, load, alert, backup, and restore evidence to the requested SHA", () => {
        const preview = namedStep("Verify immutable staging preview");
        const loadStep = namedStep("Run exact 80 + 10 + 10 initial workload");
        const alert = namedStep("Exercise external alert roundtrip");
        const backup = namedStep("Create staging backup");
        const restore = namedStep("Verify disposable restore and core journey");

        expect(preview.env).toMatchObject({ OMR_PRODUCTION_EXPECTED_BUILD: "${{ inputs.build_sha }}" });
        expect(loadStep.env).toMatchObject({ OMR_INITIAL_OPS_EXPECTED_BUILD: "${{ inputs.build_sha }}" });
        expect(alert.env).toMatchObject({ OMR_BUILD_SHA: "${{ inputs.build_sha }}" });
        expect(String(backup.run)).toContain('--confirm-source-project-ref="$STAGING_PROJECT_REF"');
        expect(restore.env).toMatchObject({
            OMR_DEPLOYMENT_TIER: "staging",
            OMR_RESTORE_EXPECTED_BUILD: "${{ inputs.build_sha }}",
        });
        expect(String(restore.run)).toContain("--confirm-target-project-ref=\"$RESTORE_PROJECT_REF\"");
    });

    it("requires ten zero-retry Chromium runs, WebKit core, and an actual immutable-preview E2E", () => {
        const localBrowser = String(namedStep("Run deterministic core browser gates").run);
        const preview = String(namedStep("Verify immutable staging preview").run);

        expect(localBrowser).toContain("for RUN_NUMBER in {1..10}");
        expect(localBrowser).toContain('if (( RUN_NUMBER % 2 == 1 ))');
        expect(localBrowser).toContain("chromium-run-$RUN_NUMBER.json");
        expect(localBrowser).toContain("--workers=1 --retries=0 --reporter=json");
        expect(localBrowser).toContain("new Set(metrics.reportDigestSet).size !== 10");
        expect(localBrowser).toContain("test:e2e:ios-webkit");
        expect(preview).toContain("e2e/student-credential-batch.spec.ts");
        expect(preview).toContain("npm run test:e2e:prod -- --workers=1 --retries=0 --reporter=json");
        expect(namedStep("Verify immutable staging preview").env).toMatchObject({
            OMR_STUDENT_CREDENTIAL_HOSTED_MODE: "1",
        });
        expect(preview).toContain("productionExpected: productionStats.expected");
        expect(preview).toContain("QUALIFICATION_BROWSER_PROOFS");
        expect(productionPlaywrightSource).not.toContain("Teacher and student full journey|");
        for (const title of [
            "production health exposes the exact immutable build without cache",
            "production static assets use immutable same-origin delivery",
            "production root boot scrubs legacy student start codes without reading or displaying them",
        ]) expect(productionPlaywrightSource).toContain(title);
        expect(productionPlaywrightSource).toContain("testMatch: /production-security\\.spec\\.ts/");
    });

    it("enforces exact evidence freshness and only seals after an exact-path GO score", () => {
        const score = String(namedStep("Generate release score").run);
        const seal = String(namedStep("Seal qualification success").run);

        expect(score).toContain("node scripts/build-initial-operations-qualification.mjs");
        expect(score).toContain('--generated-at="$GENERATED_AT"');
        expect(score).toContain('--preview-host-digest="$QUALIFIED_PREVIEW_HOST_DIGEST"');
        expect(score).toContain('--preview-deployment-id="$QUALIFIED_PREVIEW_DEPLOYMENT_ID"');
        expect(score).toContain('--preview-artifact-digest="$QUALIFIED_PREVIEW_ARTIFACT_DIGEST"');
        expect(score).toContain('qualificationPhase)\' "$RELEASE_DIR/bundle-index.json")" = "pre_promotion"');
        expect(score).toContain("release-quality-manifest.json");
        expect(score).toContain("release-quality-score.json");
        expect(score).toContain("validatePublishedReleaseScore");
        expect(seal).toContain("QUALIFICATION_COMPLETE");
        expect(seal).toContain("chmod 600");
        expect(stepIndex("Seal qualification success")).toBeGreaterThan(stepIndex("Generate release score"));
    });

    it("uploads evidence on every conclusion without converting failures into success", () => {
        const upload = namedStep("Upload qualification evidence");
        const summary = namedStep("Record immutable bundle digest");

        expect(upload.if).toBe("${{ always() }}");
        expect(upload.uses).toMatch(/^actions\/upload-artifact@[a-f0-9]{40}$/);
        expect(upload.with).toMatchObject({
            name: "initial-operations-qualification-${{ inputs.build_sha }}",
            path: "${{ runner.temp }}/initial-operations-qualification",
            "include-hidden-files": true,
            "if-no-files-found": "error",
            "retention-days": 90,
            "compression-level": 0,
        });
        expect(stepIndex("Upload qualification evidence")).toBeGreaterThan(
            stepIndex("Clean private qualification material"),
        );
        expect(stepIndex("Seal qualification success")).toBeGreaterThan(
            stepIndex("Clean private qualification material"),
        );
        expect(summary.if).toContain("steps.upload-qualification-evidence.outcome == 'success'");
        expect(String(summary.run)).toContain('[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]');
        expect(String(summary.run)).toContain('${ENVIRONMENT_DIGEST:-unverified}');
    });

    it("publishes a deterministic relocatable raw-evidence bundle without private load or backup bytes", () => {
        const load = String(namedStep("Run exact 80 + 10 + 10 initial workload").run);
        const backup = String(namedStep("Create staging backup").run);
        const cleanup = String(namedStep("Clean private qualification material").run);
        const score = String(namedStep("Generate release score").run);

        expect(load).toContain("$RUNNER_TEMP/initial-operations-private-load");
        expect(load).toContain("source-load.json");
        expect(backup).toContain("$RUNNER_TEMP/initial-operations-private-backup");
        expect(backup).toContain("source-backup.json");
        expect(cleanup).toContain("initial-operations-private-load");
        expect(cleanup).toContain("initial-operations-private-backup");
        expect(score).toContain("bundle-index.json");
        expect(score).toContain("build-initial-operations-qualification.mjs");
        expect(score).not.toContain("RELEASE_ATOMIC_CHECKS");
        expect(workflowSource).not.toContain('status: "passed" })),');
        expect(workflowSource).not.toMatch(/\$RAW_DIR\/[A-Za-z0-9._-]+\.log/);
        expect(workflowSource).toContain("qualification-identity.json");
    });

    it("applies the just-created backup through a pinned protected runner before verification", () => {
        const guard = String(namedStep("Validate qualification request and protected environment").run);
        const apply = String(namedStep("Apply backup to disposable restore target").run);
        const restore = String(namedStep("Verify disposable restore and core journey").run);

        expect(guard).toContain("OMR_RESTORE_PREPARE_RUNNER_SHA256");
        expect(guard).toContain('test "$RESTORE_APP_HOST" != "$PRODUCTION_HOST"');
        expect(guard).toContain('test "$RESTORE_APP_HOST" != "$STAGING_HOST"');
        expect(apply).toContain('node "$PRIVATE_RUNNER_DIR/runner.mjs"');
        expect(apply).toContain('value.status !== "restored"');
        expect(apply).toContain("backupManifestSha256");
        expect(apply).toContain("targetProjectRefHash");
        expect(stepIndex("Apply backup to disposable restore target")).toBeGreaterThan(stepIndex("Create staging backup"));
        expect(stepIndex("Verify disposable restore and core journey")).toBeGreaterThan(
            stepIndex("Apply backup to disposable restore target"),
        );
        expect(restore).toContain('value.disposableCredentialsRevoked !== true');
        expect(restore).toContain("source-restore.json");
    });
});
