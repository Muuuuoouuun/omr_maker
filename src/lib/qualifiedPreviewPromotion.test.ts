import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
    buildPromotionCommand,
    buildPromotionProcessEnvironment,
    finalizePromotionRelease,
    prepareQualificationBundle,
    runQualifiedPreviewPromotion,
    validatePromotionInput,
    verifyQualifiedPreviewLineage,
} from "../../scripts/promote-qualified-preview.mjs";
import {
    RELEASE_ARTIFACT_CATALOG,
    RELEASE_DIMENSIONS,
} from "../../scripts/release-quality-core.mjs";
import {
    QUALIFICATION_BROWSER_PROOFS,
    QUALIFICATION_SOURCE_CATALOG,
    buildInitialOperationsQualification,
} from "../../scripts/build-initial-operations-qualification.mjs";
import { runReleaseScoreCli } from "../../scripts/score-release-quality.mjs";

const BUILD_SHA = "a".repeat(40);
const ENVIRONMENT_DIGEST = "b".repeat(64);
const MANIFEST_SHA256 = "c".repeat(64);
const DATABASE_PROJECT_HASH = "d".repeat(64);
const PREVIEW_ARTIFACT_DIGEST = `sha256:${"e".repeat(64)}`;
const QUALIFICATION_ARTIFACT_DIGEST = "f".repeat(64);
const PREVIEW_URL = "https://omr-qualified-a1b2c3.vercel.app";
const PRODUCTION_HOST = "omr.example.com";
const PRODUCTION_HOST_DIGEST = createHash("sha256")
    .update(`omr.initial-operations.production-host:v1\n${PRODUCTION_HOST}`)
    .digest("hex");
const PRODUCTION_PROJECT_DIGEST = createHash("sha256")
    .update(`omr.initial-operations.production-project-hash:v1\n${DATABASE_PROJECT_HASH}`)
    .digest("hex");
const ATTESTATION_SECRET = "release_attestation_secret_abcdefghijklmnopqrstuvwxyz";
const PREVIEW_ATTESTATION_SIGNATURE = createHmac("sha256", ATTESTATION_SECRET)
    .update(`omr-preview-identity:v1\n${BUILD_SHA}\ndpl_preview_A1b2c3\n${PREVIEW_ARTIFACT_DIGEST}`)
    .digest("hex");
const QUALIFIED_PREVIEW_BUNDLE_BINDING = Object.freeze({
    expectedQualifiedPreviewArtifactDigest: PREVIEW_ARTIFACT_DIGEST,
    expectedQualifiedPreviewDeploymentId: "dpl_preview_A1b2c3",
    expectedQualifiedPreviewHost: "omr-qualified-a1b2c3.vercel.app",
});
const FINAL_PROMOTION_IDENTITY = Object.freeze({
    operatorId: "release.operator-1",
    previousDeploymentId: "dpl_previous_Z9y8x7",
    productionHostDigest: PRODUCTION_HOST_DIGEST,
    productionProjectDigest: PRODUCTION_PROJECT_DIGEST,
    targetArtifactDigest: PREVIEW_ARTIFACT_DIGEST,
    targetDeploymentId: "dpl_preview_A1b2c3",
});
const workflow = readFileSync(resolve(".github/workflows/production-readiness.yml"), "utf8");
const operationsGuide = readFileSync(resolve("docs/production-readiness.md"), "utf8");
const promotionSource = readFileSync(resolve("scripts/promote-qualified-preview.mjs"), "utf8");

function validInput(overrides: Record<string, unknown> = {}) {
    return {
        expectedBuildSha: BUILD_SHA,
        expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
        manifestSha256: MANIFEST_SHA256,
        scorePath: "/private/qualification/release/qualified-score.json",
        qualifiedPreviewUrl: PREVIEW_URL,
        qualifiedPreviewHost: "omr-qualified-a1b2c3.vercel.app",
        allowedPreviewHostSuffix: ".vercel.app",
        productionHost: PRODUCTION_HOST,
        previewDeploymentId: "dpl_preview_A1b2c3",
        previewArtifactDigest: PREVIEW_ARTIFACT_DIGEST,
        previewAttestationSignature: PREVIEW_ATTESTATION_SIGNATURE,
        qualificationArtifactDigest: QUALIFICATION_ARTIFACT_DIGEST,
        readinessVersion: "202608090001",
        expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
        previousDeploymentId: "dpl_previous_Z9y8x7",
        manifestPath: "/private/qualification/release/rebound-release-quality-manifest.json",
        finalReleaseRoot: "/private/qualification/final-release",
        operatorId: "release.operator-1",
        operatorConfirmation: `promote-qualified-preview:${PRODUCTION_HOST}:${BUILD_SHA}:release.operator-1`,
        writesPauseConfirmation: `writes-paused:${PRODUCTION_HOST}`,
        verifierOutputPath: "/private/qualification/production-readiness.json",
        rollbackOutputPath: "/private/qualification/rollback-required.json",
        ...overrides,
    };
}

function verifiedEvidence() {
    return {
        status: "verified",
        verifiedAt: "2026-08-09T01:02:03.000Z",
        productionHost: PRODUCTION_HOST,
        build: BUILD_SHA,
        releaseIdentity: {
            verifierSha: BUILD_SHA,
            deployedSha: BUILD_SHA,
            previewDeploymentId: "dpl_preview_A1b2c3",
            previewArtifactDigest: PREVIEW_ARTIFACT_DIGEST,
            previewIdentityAttested: true,
        },
        readinessVersion: "202608090001",
        databaseProjectRefHash: DATABASE_PROJECT_HASH,
        access: { anon: "denied", authenticated: "denied" },
    };
}

function verifiedVercelDeployment(overrides: Record<string, unknown> = {}) {
    return {
        id: "dpl_preview_A1b2c3",
        url: "omr-qualified-a1b2c3.vercel.app",
        ownerId: "team_owner_A1b2c3",
        projectId: "prj_omr_A1b2c3",
        readyState: "READY",
        target: null,
        meta: { githubCommitSha: BUILD_SHA },
        ...overrides,
    };
}

function verifiedProductionDeployment(overrides: Record<string, unknown> = {}) {
    return {
        id: "dpl_previous_Z9y8x7",
        url: "omr-previous-z9y8x7.vercel.app",
        ownerId: "team_owner_A1b2c3",
        projectId: "prj_omr_A1b2c3",
        readyState: "READY",
        target: "production",
        ...overrides,
    };
}

async function qualificationBundleFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omr-qualified-bundle-")));
    await chmod(root, 0o700);
    const release = join(root, "release");
    await mkdir(release, { mode: 0o700 });
    const sources = join(release, "sources");
    await mkdir(sources, { mode: 0o700 });
    const generatedAt = "2026-08-09T00:00:00.000Z";
    const sourceDocuments = QUALIFICATION_SOURCE_CATALOG.map(({ id, relativePath }) => {
        const bytes = `${JSON.stringify({
            schemaVersion: 1,
            id,
            status: "verified",
            buildSha: BUILD_SHA,
            environmentDigest: ENVIRONMENT_DIGEST,
            sourceSha256: createHash("sha256").update(`private:${id}`).digest("hex"),
            metrics: qualificationSourceMetrics(id, generatedAt),
        })}\n`;
        return { id, relativePath, bytes: Buffer.from(bytes) };
    });
    const qualification = buildInitialOperationsQualification({
        buildSha: BUILD_SHA,
        environmentDigest: ENVIRONMENT_DIGEST,
        generatedAt,
        qualifiedPreviewArtifactDigest: PREVIEW_ARTIFACT_DIGEST.slice("sha256:".length),
        qualifiedPreviewDeploymentId: "dpl_preview_A1b2c3",
        qualifiedPreviewHostDigest: createHash("sha256")
            .update("omr.initial-operations.qualified-preview-host:v1\nomr-qualified-a1b2c3.vercel.app")
            .digest("hex"),
        releaseDirectory: "/old-runner/release",
        sourceDocuments: sourceDocuments.map(({ relativePath, bytes }) => ({ relativePath, bytes })),
    });
    for (const { relativePath, bytes } of sourceDocuments) {
        await writeFile(join(release, relativePath), bytes, { mode: 0o600, flag: "wx" });
    }
    const provenanceBytes = `${JSON.stringify(qualification.provenance)}\n`;
    await writeFile(join(release, "source-provenance.json"), provenanceBytes, { mode: 0o600, flag: "wx" });
    const artifacts = [];
    const evidenceByDimension = qualification.evidenceByDimension as Record<string, unknown>;
    for (const kind of RELEASE_DIMENSIONS) {
        const catalog = RELEASE_ARTIFACT_CATALOG[kind];
        const evidence = `${JSON.stringify(evidenceByDimension[kind])}\n`;
        const relativePath = `evidence-${kind}.json`;
        const digest = createHash("sha256").update(evidence).digest("hex");
        await writeFile(join(release, relativePath), evidence, { mode: 0o600, flag: "wx" });
        artifacts.push({
            id: catalog.id,
            kind,
            evidenceClass: catalog.evidenceClass,
            path: `/old-runner/release/${relativePath}`,
            sha256: digest,
            generatedAt,
            freshUntil: new Date(Date.parse(generatedAt) + catalog.maxAgeMs).toISOString(),
            buildSha: BUILD_SHA,
            environmentDigest: ENVIRONMENT_DIGEST,
            status: "verified",
        });
    }
    const manifest = {
        ...qualification.manifest,
        artifacts,
    };
    const manifestBytes = `${JSON.stringify(manifest)}\n`;
    await writeFile(join(release, "release-quality-manifest.json"), manifestBytes, { mode: 0o600, flag: "wx" });
    await writeFile(join(release, "bundle-index.json"), `${JSON.stringify({
        ...qualification.bundleIndex,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        sourceProvenanceSha256: createHash("sha256").update(provenanceBytes).digest("hex"),
    })}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(root, "qualification-identity.json"), `${JSON.stringify({
        schemaVersion: 1,
        status: "verified",
        qualificationPhase: "pre_promotion",
        qualifiedPreviewHostDigest: createHash("sha256")
            .update("omr.initial-operations.qualified-preview-host:v1\nomr-qualified-a1b2c3.vercel.app")
            .digest("hex"),
        qualifiedPreviewDeploymentId: "dpl_preview_A1b2c3",
        qualifiedPreviewArtifactDigest: PREVIEW_ARTIFACT_DIGEST.slice("sha256:".length),
        buildSha: BUILD_SHA,
        environmentDigest: ENVIRONMENT_DIGEST,
        stagingHostDigest: "1".repeat(64),
        stagingProjectDigest: "2".repeat(64),
        productionHostDigest: createHash("sha256")
            .update(`omr.initial-operations.production-host:v1\n${PRODUCTION_HOST}`)
            .digest("hex"),
        productionProjectDigest: createHash("sha256")
            .update(`omr.initial-operations.production-project-hash:v1\n${DATABASE_PROJECT_HASH}`)
            .digest("hex"),
        restoreProjectDigest: "5".repeat(64),
    })}\n`, { mode: 0o600, flag: "wx" });
    await writeFile(join(root, "QUALIFICATION_COMPLETE"), `${JSON.stringify({
        schemaVersion: 1,
        status: "qualified",
        qualificationPhase: "pre_promotion",
        buildSha: BUILD_SHA,
        environmentDigest: ENVIRONMENT_DIGEST,
        scoreSha256: "6".repeat(64),
        qualifiedAt: generatedAt,
    })}\n`, { mode: 0o600, flag: "wx" });
    return { root, release, outputPath: join(release, "rebound-release-quality-manifest.json") };
}

function qualificationSourceMetrics(id: string, generatedAt: string) {
    const metrics: Record<string, unknown> = {
        environment: { protectedInputs: "passed", targetIsolation: "passed" },
        postgres17: { major: 17 },
        install: { lockedInstall: "passed" },
        static: {
            criticalVulnerabilities: 0, desktopAudit: "passed", highVulnerabilities: 0, lint: "passed",
            productionAudit: "passed", secretScan: "passed", typecheck: "passed",
        },
        unit: { failedTests: 0, skippedTests: 0, totalTests: 2773 },
        browser: {
            chromiumExpected: 100, chromiumFlaky: 0, chromiumSkipped: 0, chromiumUnexpected: 0,
            chromiumRuns: 10, productionExpected: 6, productionFlaky: 0, productionSkipped: 0,
            productionUnexpected: 0, productionProjects: ["prod-chromium", "prod-webkit-ipad"],
            hostedExpected: 1, hostedFlaky: 0, hostedSkipped: 0, hostedUnexpected: 0,
            proofs: QUALIFICATION_BROWSER_PROOFS,
            reportDigestSet: Array.from({ length: 10 }, (_, index) => createHash("sha256")
                .update(`report-${index}`).digest("hex")),
            retries: 0, webkitExpected: 60, webkitFlaky: 0, webkitSkipped: 0,
            webkitUnexpected: 0, workers: 1,
        },
        build: { build: "passed", budget: "passed", pwaSmoke: "passed" },
        live_pg: { contract: "passed", postgresMajor: 17 },
        hosted: {
            anonDenied: true, authenticatedDenied: true, boundary: "passed", cleanupHeartbeatFresh: "passed",
            deliveryProbe: "passed", healthSha: "passed", immutablePreview: "passed", readinessExact: "passed",
            staticCompression: "passed", teacherCanary: "passed",
        },
        load: {
            cleanupVerified: true, concurrentMaxPdfUploads: 10, concurrentSubmissions: 80, deadQueueCount: 0,
            failures: 0, gatewayReadP95Ms: 500, logRedaction: "passed", maximumQueryMs: 400,
            status: "passed", students: 80, submitEndToEndP99Ms: 8_000, submitRpcP95Ms: 1_000,
            teacherLivePollers: 10, teacherUploaders: 10, virtualUsers: 100,
        },
        alert: { alertAck: "passed", alertResolve: "passed", roundtrip: "passed", sinkReceipt: "passed" },
        backup: { backup: "verified", createdAt: generatedAt },
        restore: {
            boundary: "passed", browser: "passed", credentialRevocation: "passed", objectHashes: "passed",
            releaseSeal: "passed", rpo: "passed", rto: "passed", tableInventory: "passed",
        },
    };
    return metrics[id];
}

describe("qualified immutable preview promotion", () => {
    it("rebinds only the exact protected bundle into the private restored path", async () => {
        const fixture = await qualificationBundleFixture();
        const result = await prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: fixture.outputPath,
            qualificationRoot: fixture.root,
        });
        const stats = await lstat(fixture.outputPath);
        const rebound = JSON.parse(await readFile(fixture.outputPath, "utf8"));
        expect(stats.mode & 0o777).toBe(0o600);
        expect(rebound.artifacts.map((artifact: { path: string }) => artifact.path)).toEqual(
            RELEASE_DIMENSIONS.map((kind) => join(fixture.release, `evidence-${kind}.json`)),
        );
        expect(result).toMatchObject({ status: "prepared", buildSha: BUILD_SHA, environmentDigest: ENVIRONMENT_DIGEST });
        expect(result.manifestSha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it("rejects an incomplete or artifact-tampered qualification bundle", async () => {
        const incomplete = await qualificationBundleFixture();
        await writeFile(join(incomplete.root, ".INCOMPLETE"), "incomplete\n", { mode: 0o600, flag: "wx" });
        await expect(prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: incomplete.outputPath,
            qualificationRoot: incomplete.root,
        })).rejects.toMatchObject({ code: "qualification_bundle_invalid" });

        const tampered = await qualificationBundleFixture();
        await writeFile(join(tampered.release, "evidence-student_core.json"), "tampered\n", { flag: "a" });
        await expect(prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: tampered.outputPath,
            qualificationRoot: tampered.root,
        })).rejects.toMatchObject({ code: "qualification_bundle_invalid" });
    });

    it("rejects tampered source attestations and provenance that diverges from replay", async () => {
        const tamperedSource = await qualificationBundleFixture();
        await writeFile(join(tamperedSource.release, "sources/source-unit.json"), " ", { flag: "a" });
        await expect(prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: tamperedSource.outputPath,
            qualificationRoot: tamperedSource.root,
        })).rejects.toMatchObject({ code: "qualification_bundle_invalid" });

        const falsePass = await qualificationBundleFixture();
        const provenancePath = join(falsePass.release, "source-provenance.json");
        const provenance = JSON.parse(await readFile(provenancePath, "utf8"));
        provenance.checks.find((check: { id: string }) => check.id === "hosted_deployment_promotion_lineage").status = "passed";
        await writeFile(provenancePath, `${JSON.stringify(provenance)}\n`, { flag: "w" });
        const indexPath = join(falsePass.release, "bundle-index.json");
        const index = JSON.parse(await readFile(indexPath, "utf8"));
        index.sourceProvenanceSha256 = createHash("sha256")
            .update(await readFile(provenancePath))
            .digest("hex");
        await writeFile(indexPath, `${JSON.stringify(index)}\n`, { flag: "w" });
        await expect(prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: falsePass.outputPath,
            qualificationRoot: falsePass.root,
        })).rejects.toMatchObject({ code: "qualification_bundle_invalid" });
    });

    it("rejects a bundle qualified for a different production host or database project", async () => {
        const fixture = await qualificationBundleFixture();
        await expect(prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: "9".repeat(64),
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: fixture.outputPath,
            qualificationRoot: fixture.root,
        })).rejects.toMatchObject({ code: "qualification_bundle_invalid" });
    });

    it.each([
        { expectedQualifiedPreviewHost: "same-sha-substitute.vercel.app" },
        { expectedQualifiedPreviewDeploymentId: "dpl_same_sha_substitute" },
        { expectedQualifiedPreviewArtifactDigest: `sha256:${"9".repeat(64)}` },
    ])("rejects a same-SHA preview not bound to the qualification bundle %#", async (override) => {
        const fixture = await qualificationBundleFixture();
        await expect(prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            ...override,
            outputPath: fixture.outputPath,
            qualificationRoot: fixture.root,
        })).rejects.toMatchObject({ code: "qualification_bundle_invalid" });
    });

    it("creates and exact-path validates a final GO score from actual post-promotion proof", async () => {
        const fixture = await qualificationBundleFixture();
        const prepared = await prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: fixture.outputPath,
            qualificationRoot: fixture.root,
        });
        const finalReleaseRoot = join(fixture.root, "final-release");
        await mkdir(finalReleaseRoot, { mode: 0o700 });
        const result = await finalizePromotionRelease({
            expectedBuildSha: BUILD_SHA,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            finalReleaseRoot,
            generatedAt: "2026-08-09T01:02:03.000Z",
            outcome: "verified",
            ...FINAL_PROMOTION_IDENTITY,
            qualificationArtifactDigest: QUALIFICATION_ARTIFACT_DIGEST,
            rollbackGuardSha256: "7".repeat(64),
            sourceManifestPath: fixture.outputPath,
            sourceManifestSha256: prepared.manifestSha256,
            verifierEvidence: verifiedEvidence(),
        }, {
            now: () => new Date("2026-08-09T01:02:04.000Z"),
            scorerSha: BUILD_SHA,
        });
        const manifest = JSON.parse(await readFile(join(finalReleaseRoot, "release-quality-manifest.json"), "utf8"));
        const hosted = JSON.parse(await readFile(join(finalReleaseRoot, "evidence-hosted_deployment.json"), "utf8"));
        const recovery = JSON.parse(await readFile(join(finalReleaseRoot, "evidence-recovery_release.json"), "utf8"));
        const provenanceBytes = await readFile(join(finalReleaseRoot, "final-promotion-provenance.json"), "utf8");
        const verifierEvidenceSha256 = createHash("sha256")
            .update(`${JSON.stringify(verifiedEvidence())}\n`)
            .digest("hex");
        const expectedFinalEnvironmentDigest = createHash("sha256").update([
            "omr.final-promotion-evidence:v1",
            ENVIRONMENT_DIGEST,
            verifierEvidenceSha256,
            "7".repeat(64),
            QUALIFICATION_ARTIFACT_DIGEST,
            "release.operator-1",
            "dpl_previous_Z9y8x7",
            "dpl_preview_A1b2c3",
            PREVIEW_ARTIFACT_DIGEST,
            PRODUCTION_HOST_DIGEST,
            PRODUCTION_PROJECT_DIGEST,
        ].join("\n")).digest("hex");
        expect(hosted.checks).toContainEqual({ id: "hosted_deployment_promotion_lineage", status: "passed" });
        expect(recovery.checks).toContainEqual({ id: "recovery_release_rollback_evidence", status: "passed" });
        expect(manifest.artifacts.every((artifact: { path: string }) => artifact.path.startsWith(`${finalReleaseRoot}/`))).toBe(true);
        expect(manifest.environmentDigest).toBe(expectedFinalEnvironmentDigest);
        expect(manifest.artifacts.every((artifact: { environmentDigest: string }) => (
            artifact.environmentDigest === manifest.environmentDigest
        ))).toBe(true);
        expect(result).toMatchObject({ status: "verified", scoreStatus: "go" });
        expect(result.finalEnvironmentDigest).toBe(manifest.environmentDigest);
        expect(JSON.parse(provenanceBytes)).toMatchObject({
            sourceEnvironmentDigest: ENVIRONMENT_DIGEST,
            finalEnvironmentDigest: manifest.environmentDigest,
        });
        expect(provenanceBytes).not.toContain(PREVIEW_URL);
        expect(provenanceBytes).not.toContain(PRODUCTION_HOST);
        expect(provenanceBytes).not.toContain(DATABASE_PROJECT_HASH);
    });

    it("emits a final NO-GO score and failed evidence when a promotion attempt is unverified", async () => {
        const fixture = await qualificationBundleFixture();
        const prepared = await prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: fixture.outputPath,
            qualificationRoot: fixture.root,
        });
        const finalReleaseRoot = join(fixture.root, "final-release");
        await mkdir(finalReleaseRoot, { mode: 0o700 });
        const result = await finalizePromotionRelease({
            expectedBuildSha: BUILD_SHA,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            finalReleaseRoot,
            generatedAt: "2026-08-09T01:02:03.000Z",
            outcome: "failed",
            ...FINAL_PROMOTION_IDENTITY,
            qualificationArtifactDigest: QUALIFICATION_ARTIFACT_DIGEST,
            rollbackGuardSha256: "7".repeat(64),
            sourceManifestPath: fixture.outputPath,
            sourceManifestSha256: prepared.manifestSha256,
            verifierEvidence: null,
        }, {
            now: () => new Date("2026-08-09T01:02:04.000Z"),
            scorerSha: BUILD_SHA,
        });
        const hosted = JSON.parse(await readFile(join(finalReleaseRoot, "evidence-hosted_deployment.json"), "utf8"));
        expect(hosted.checks).toContainEqual({ id: "hosted_deployment_promotion_lineage", status: "failed" });
        expect(hosted.hardGates).toContainEqual({ id: "health_readiness", status: "failed" });
        expect(result).toMatchObject({ status: "unverified", scoreStatus: "no_go" });
    });

    it("accepts only the exact bounded promotion identity", () => {
        expect(validatePromotionInput(validInput())).toEqual({ ok: true });
        expect(validatePromotionInput(validInput({ expectedBuildSha: "short" }))).toEqual({
            ok: false,
            error: "invalid_input",
        });
        expect(validatePromotionInput(validInput({ qualificationArtifactDigest: `sha256:${QUALIFICATION_ARTIFACT_DIGEST}` }))).toEqual({
            ok: false,
            error: "invalid_input",
        });
        expect(validatePromotionInput(validInput({ previewAttestationSignature: "9".repeat(63) }))).toEqual({
            ok: false,
            error: "invalid_input",
        });
        expect(validatePromotionInput(validInput({ operatorConfirmation: "yes" }))).toEqual({
            ok: false,
            error: "operator_confirmation_mismatch",
        });
        expect(validatePromotionInput(validInput({ writesPauseConfirmation: "writes-paused:other.example.com" }))).toEqual({
            ok: false,
            error: "writes_not_paused",
        });
    });

    it.each([
        { qualifiedPreviewUrl: "http://omr-qualified-a1b2c3.vercel.app" },
        { qualifiedPreviewUrl: "https://omr-qualified-a1b2c3.vercel.app/path" },
        { qualifiedPreviewHost: PRODUCTION_HOST, qualifiedPreviewUrl: `https://${PRODUCTION_HOST}` },
        { qualifiedPreviewHost: "localhost", qualifiedPreviewUrl: "https://localhost" },
        { productionHost: "127.0.0.1" },
        { allowedPreviewHostSuffix: ".example.net" },
    ])("rejects an unpinned or unsafe host %#", (override) => {
        expect(validatePromotionInput(validInput(override))).toEqual({ ok: false, error: "invalid_host" });
    });

    it("constructs the only permitted Vercel command", () => {
        expect(buildPromotionCommand(validInput())).toEqual([
            "vercel",
            "promote",
            PREVIEW_URL,
            "--yes",
        ]);
        expect(promotionSource).not.toMatch(/vercel[^\n]*(?:deploy|build)/);
    });

    it("passes only Vercel credentials and minimal runtime state to the promotion client", () => {
        expect(buildPromotionProcessEnvironment({
            PATH: "/usr/local/bin:/usr/bin",
            VERCEL_ORG_ID: "team_owner_A1b2c3",
            VERCEL_PROJECT_ID: "prj_omr_A1b2c3",
            VERCEL_TOKEN: "vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
            OMR_PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: "must-not-reach-vercel",
            OMR_PRODUCTION_AUTHENTICATED_JWT: "must-not-reach-vercel",
            OMR_READINESS_TOKEN: "must-not-reach-vercel",
        })).toEqual({
            CI: "1",
            PATH: "/usr/local/bin:/usr/bin",
            VERCEL_ORG_ID: "team_owner_A1b2c3",
            VERCEL_PROJECT_ID: "prj_omr_A1b2c3",
            VERCEL_TOKEN: "vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
        });
    });

    it("authenticates the qualified URL to the exact Vercel deployment, project, owner, and SHA", async () => {
        const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
            void init;
            const deployment = url.includes(encodeURIComponent(PRODUCTION_HOST))
                ? verifiedProductionDeployment()
                : verifiedVercelDeployment();
            return new Response(JSON.stringify(deployment), {
                status: 200,
                headers: { "content-type": "application/json", "content-length": "320" },
            });
        });
        await expect(verifyQualifiedPreviewLineage(validInput(), {
            env: {
                VERCEL_ORG_ID: "team_owner_A1b2c3",
                VERCEL_PROJECT_ID: "prj_omr_A1b2c3",
                VERCEL_TOKEN: "vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
                OMR_RELEASE_ATTESTATION_SECRET: ATTESTATION_SECRET,
            },
            fetchImpl,
        })).resolves.toEqual({ status: "verified" });
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://api.vercel.com/v13/deployments/omr-qualified-a1b2c3.vercel.app?teamId=team_owner_A1b2c3",
            expect.objectContaining({ method: "GET", redirect: "error" }),
        );
        expect(fetchImpl).toHaveBeenCalledWith(
            "https://api.vercel.com/v13/deployments/omr.example.com?teamId=team_owner_A1b2c3",
            expect.objectContaining({ method: "GET", redirect: "error" }),
        );
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[0][1]?.headers).toMatchObject({
            authorization: "Bearer vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
        });
    });

    it.each([
        { id: "dpl_other" },
        { url: "other.vercel.app" },
        { ownerId: "team_other" },
        { projectId: "prj_other" },
        { readyState: "BUILDING" },
        { target: "production" },
        { meta: { githubCommitSha: "9".repeat(40) } },
    ])("rejects unauthenticated preview lineage %#", async (override) => {
        await expect(verifyQualifiedPreviewLineage(validInput(), {
            env: {
                VERCEL_ORG_ID: "team_owner_A1b2c3",
                VERCEL_PROJECT_ID: "prj_omr_A1b2c3",
                VERCEL_TOKEN: "vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
                OMR_RELEASE_ATTESTATION_SECRET: ATTESTATION_SECRET,
            },
            fetchImpl: async () => new Response(JSON.stringify(verifiedVercelDeployment(override)), {
                status: 200,
                headers: { "content-type": "application/json" },
            }),
        })).rejects.toMatchObject({ code: "preview_lineage_unverified" });
    });

    it("rejects a preview artifact attestation mismatch before any Vercel lookup", async () => {
        const fetchImpl = vi.fn();
        await expect(verifyQualifiedPreviewLineage(validInput({
            previewAttestationSignature: "9".repeat(64),
        }), {
            env: {
                VERCEL_ORG_ID: "team_owner_A1b2c3",
                VERCEL_PROJECT_ID: "prj_omr_A1b2c3",
                VERCEL_TOKEN: "vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
                OMR_RELEASE_ATTESTATION_SECRET: ATTESTATION_SECRET,
            },
            fetchImpl,
        })).rejects.toMatchObject({ code: "preview_lineage_unverified" });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it.each([
        { id: "dpl_stale" },
        { ownerId: "team_other" },
        { projectId: "prj_other" },
        { readyState: "BUILDING" },
        { target: null },
    ])("rejects a previous deployment not currently serving the production host %#", async (override) => {
        const fetchImpl = vi.fn(async (url: string) => new Response(JSON.stringify(
            url.includes(encodeURIComponent(PRODUCTION_HOST))
                ? verifiedProductionDeployment(override)
                : verifiedVercelDeployment(),
        ), { status: 200, headers: { "content-type": "application/json" } }));
        await expect(verifyQualifiedPreviewLineage(validInput(), {
            env: {
                VERCEL_ORG_ID: "team_owner_A1b2c3",
                VERCEL_PROJECT_ID: "prj_omr_A1b2c3",
                VERCEL_TOKEN: "vcp_token_abcdefghijklmnopqrstuvwxyz0123456789",
                OMR_RELEASE_ATTESTATION_SECRET: ATTESTATION_SECRET,
            },
            fetchImpl,
        })).rejects.toMatchObject({ code: "preview_lineage_unverified" });
    });

    it("consumes the exported exact-path score before promotion and verifies post-promotion lineage", async () => {
        const calls: string[] = [];
        const validateScore = vi.fn(async () => ({ status: "verified", score: { status: "go" } }));
        const writeRollbackEvidence = vi.fn(async () => ({ dev: 1, ino: 2 }));
        const clearRollbackEvidence = vi.fn(async () => undefined);
        const finalizeRelease = vi.fn(async () => ({
            status: "verified",
            scoreStatus: "go",
            manifestSha256: "8".repeat(64),
            finalEnvironmentDigest: "9".repeat(64),
        }));
        const outcome = await runQualifiedPreviewPromotion(validInput(), {
            validateScore,
            execute: async (file: string, args: string[]) => {
                calls.push([file, ...args].join(" "));
            },
            verifyPreviewLineage: async () => ({ status: "verified" }),
            runVerifier: async () => verifiedEvidence(),
            writeRollbackEvidence,
            clearRollbackEvidence,
            finalizeRelease,
            now: () => new Date("2026-08-09T01:02:03.000Z"),
        });

        expect(validateScore).toHaveBeenCalledWith(
            "/private/qualification/release/qualified-score.json",
            {
                buildSha: BUILD_SHA,
                scorerSha: BUILD_SHA,
                environmentDigest: ENVIRONMENT_DIGEST,
                manifestSha256: MANIFEST_SHA256,
            },
        );
        expect(calls).toEqual([`vercel promote ${PREVIEW_URL} --yes`]);
        expect(writeRollbackEvidence).toHaveBeenCalledOnce();
        expect(clearRollbackEvidence).toHaveBeenCalledWith(
            "/private/qualification/rollback-required.json",
            { dev: 1, ino: 2 },
        );
        expect(finalizeRelease).toHaveBeenCalledWith(expect.objectContaining({ outcome: "verified" }));
        expect(outcome).toMatchObject({ status: "verified", writes: "paused", buildSha: BUILD_SHA });
    });

    it("accepts a freshly rebound and scored exact path through the real exported consumer", async () => {
        const fixture = await qualificationBundleFixture();
        const prepared = await prepareQualificationBundle({
            expectedBuildSha: BUILD_SHA,
            expectedDatabaseProjectRefHash: DATABASE_PROJECT_HASH,
            expectedEnvironmentDigest: ENVIRONMENT_DIGEST,
            expectedProductionHost: PRODUCTION_HOST,
            ...QUALIFIED_PREVIEW_BUNDLE_BINDING,
            outputPath: fixture.outputPath,
            qualificationRoot: fixture.root,
        });
        const scorePath = join(fixture.release, "qualified-score.json");
        const scored = await runReleaseScoreCli({
            argv: [`--manifest=${fixture.outputPath}`, `--output=${scorePath}`],
            cwd: resolve("."),
        }, {
            now: () => new Date("2026-08-09T00:01:00.000Z"),
            scorerSha: BUILD_SHA,
        });
        expect(scored.result.status).toBe("go");
        const finalReleaseRoot = join(fixture.root, "final-release");
        await mkdir(finalReleaseRoot, { mode: 0o700 });

        const outcome = await runQualifiedPreviewPromotion(validInput({
            finalReleaseRoot,
            manifestPath: fixture.outputPath,
            manifestSha256: prepared.manifestSha256,
            rollbackOutputPath: join(fixture.root, "rollback-required.json"),
            scorePath,
            verifierOutputPath: join(fixture.root, "production-readiness.json"),
        }), {
            execute: async () => undefined,
            verifyPreviewLineage: async () => ({ status: "verified" }),
            runVerifier: async () => verifiedEvidence(),
            finalizeRelease: async (input: Parameters<typeof finalizePromotionRelease>[0]) => (
                finalizePromotionRelease(input, {
                    now: () => new Date("2026-08-09T01:02:04.000Z"),
                    scorerSha: BUILD_SHA,
                })
            ),
        });
        expect(outcome).toMatchObject({ status: "verified", buildSha: BUILD_SHA });
        await expect(lstat(join(fixture.root, "rollback-required.json"))).rejects.toThrow();
    });

    it("fails closed before promotion when the exact-path score is NO-GO or copied", async () => {
        const execute = vi.fn();
        await expect(runQualifiedPreviewPromotion(validInput(), {
            validateScore: async () => { throw new Error("invalid_published_score"); },
            execute,
        })).rejects.toMatchObject({ code: "qualification_failed" });
        await expect(runQualifiedPreviewPromotion(validInput(), {
            validateScore: async () => ({ status: "verified", score: { status: "no_go" } }),
            execute,
        })).rejects.toMatchObject({ code: "qualification_failed" });
        expect(execute).not.toHaveBeenCalled();
    });

    it.each([
        { build: "9".repeat(40) },
        { releaseIdentity: { ...verifiedEvidence().releaseIdentity, deployedSha: "9".repeat(40) } },
        { releaseIdentity: { ...verifiedEvidence().releaseIdentity, previewDeploymentId: "dpl_other" } },
        { readinessVersion: "202608080009" },
        { databaseProjectRefHash: "9".repeat(64) },
        { access: { anon: "denied", authenticated: "allowed" } },
    ])("writes safe rollback-required evidence after post-promotion mismatch %#", async (override) => {
        const temporary = await realpath(await mkdtemp(join(tmpdir(), "omr-promotion-")));
        await chmod(temporary, 0o700);
        const rollbackOutputPath = join(temporary, "rollback-required.json");
        const input = validInput({ rollbackOutputPath });
        await expect(runQualifiedPreviewPromotion(input, {
            validateScore: async () => ({ status: "verified", score: { status: "go" } }),
            execute: async () => undefined,
            verifyPreviewLineage: async () => ({ status: "verified" }),
            runVerifier: async () => ({ ...verifiedEvidence(), ...override }),
            finalizeRelease: async () => ({ status: "unverified", scoreStatus: "no_go" }),
            now: () => new Date("2026-08-09T01:02:03.000Z"),
        })).rejects.toMatchObject({ code: "post_promotion_verification_failed" });

        const stats = await lstat(rollbackOutputPath);
        const bytes = await readFile(rollbackOutputPath, "utf8");
        const evidence = JSON.parse(bytes);
        expect(stats.mode & 0o777).toBe(0o600);
        expect(evidence).toMatchObject({
            status: "rollback_required",
            writes: "paused",
            previousDeploymentId: "dpl_previous_Z9y8x7",
            targetDeploymentId: "dpl_preview_A1b2c3",
            buildSha: BUILD_SHA,
            failedAt: "2026-08-09T01:02:03.000Z",
        });
        expect(bytes).not.toContain(PREVIEW_URL);
        expect(bytes).not.toContain(PRODUCTION_HOST);
        expect(bytes).not.toContain("release.operator-1");
        expect(bytes).not.toContain(DATABASE_PROJECT_HASH);
    });

    it("records final NO-GO evidence when the verifier timestamp is not canonical", async () => {
        const finalizeRelease = vi.fn(async () => ({ status: "unverified", scoreStatus: "no_go" }));
        await expect(runQualifiedPreviewPromotion(validInput(), {
            validateScore: async () => ({ status: "verified", score: { status: "go" } }),
            execute: async () => undefined,
            verifyPreviewLineage: async () => ({ status: "verified" }),
            runVerifier: async () => ({ ...verifiedEvidence(), verifiedAt: "2026-08-09T01:02:03Z" }),
            writeRollbackEvidence: async () => ({ sha256: "7".repeat(64) }),
            finalizeRelease,
            now: () => new Date("2026-08-09T01:02:04.000Z"),
        })).rejects.toMatchObject({ code: "post_promotion_verification_failed" });
        expect(finalizeRelease).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    });

    it("keeps an uncertain promotion unverified, requests rollback, and never relaxes RLS", async () => {
        const execute = vi.fn(async () => { throw new Error("vercel unavailable"); });
        const writeRollbackEvidence = vi.fn(async () => ({ sha256: "7".repeat(64) }));
        const finalizeRelease = vi.fn(async () => ({ status: "unverified", scoreStatus: "no_go" }));
        await expect(runQualifiedPreviewPromotion(validInput(), {
            validateScore: async () => ({ status: "verified", score: { status: "go" } }),
            execute,
            verifyPreviewLineage: async () => ({ status: "verified" }),
            writeRollbackEvidence,
            finalizeRelease,
        })).rejects.toMatchObject({ code: "promotion_unverified" });
        expect(writeRollbackEvidence).toHaveBeenCalledWith(
            "/private/qualification/rollback-required.json",
            expect.objectContaining({ status: "rollback_required", trigger: "promotion_outcome_unverified", writes: "paused" }),
        );
        expect(finalizeRelease).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
        expect(promotionSource).not.toMatch(/(?:disable|relax|bypass)[^\n]{0,40}RLS/i);
    });
});

describe("production promotion workflow contract", () => {
    it("restores one protected immutable qualification artifact and re-scores it in the promotion job", () => {
        expect(workflow).toContain("actions: read");
        expect(workflow).toContain("initial-operations-qualification-${{ inputs.expected_build }}");
        expect(workflow).toContain("qualification_artifact_digest");
        expect(workflow).toContain("qualification_run_id");
        expect(workflow).toContain(".github/workflows/initial-operations-qualification.yml");
        expect(workflow).toContain('test "$(jq -r \'.event\' <<<"$RUN_RESPONSE")" = "workflow_dispatch"');
        expect(workflow).toContain('test "$(jq -r \'.conclusion\' <<<"$RUN_RESPONSE")" = "success"');
        expect(workflow).toContain('test "$(jq -r \'.head_branch\' <<<"$RUN_RESPONSE")" = "$DEFAULT_BRANCH"');
        expect(workflow).toContain(".[0].workflow_run.head_sha");
        expect(workflow).toContain('= "sha256:$QUALIFICATION_ARTIFACT_DIGEST"');
        expect(workflow).toContain("QUALIFICATION_COMPLETE");
        expect(workflow).toContain("npm run release:score --");
        expect(operationsGuide).toContain("source attestation");
        expect(operationsGuide).toMatch(/qualification\s+builder/);
        expect(workflow).not.toMatch(/(?:cp|mv)[^\n]*qualified-score\.json/);
    });

    it("promotes only through the guard and retains rollback evidence on failure", () => {
        expect(workflow).toContain("node scripts/promote-qualified-preview.mjs promote");
        expect(workflow).toContain("rollback-required.json");
        expect(workflow).toContain("Classify rollback-required evidence");
        expect(workflow).toMatch(/Retain rollback-required evidence[\s\S]{0,800}if-no-files-found: error/);
        expect(workflow).not.toMatch(/rollback-required[\s\S]{0,400}if-no-files-found: ignore/);
        expect(workflow).not.toMatch(/vercel (?:deploy|build)/);
        expect(operationsGuide).toContain("vercel promote <qualified-preview-url> --yes");
        expect(operationsGuide).toContain("hosted_deployment_promotion_lineage");
        expect(operationsGuide).toContain("recovery_release_rollback_evidence");
        expect(operationsGuide).toContain("final GO score");
        expect(operationsGuide).not.toContain("vercel deploy --prod");
        expect(operationsGuide).toMatch(/rollback-required\.json[^\n]{0,120}0600/);
    });

    it("pins every third-party action used by the protected promotion workflow", () => {
        const actionUses = [...workflow.matchAll(/uses: (actions\/(?:checkout|setup-node|download-artifact|upload-artifact))@([^\s]+)/g)];
        expect(actionUses.length).toBeGreaterThanOrEqual(5);
        for (const [, , revision] of actionUses) expect(revision).toMatch(/^[a-f0-9]{40}$/);
    });
});
