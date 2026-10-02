import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
    QUALIFICATION_SOURCE_CATALOG,
    QUALIFICATION_ATOMIC_SOURCE_CATALOG,
    QUALIFICATION_BROWSER_PROOFS,
    QUALIFICATION_LIVE_PG_PROOFS,
    buildInitialOperationsQualification,
} from "../../scripts/build-initial-operations-qualification.mjs";
import {
    RELEASE_ATOMIC_CHECKS,
    RELEASE_DIMENSIONS,
    RELEASE_HARD_GATES,
    scoreReleaseEvidence,
} from "../../scripts/release-quality-core.mjs";

const BUILD_SHA = "a".repeat(40);
const ENVIRONMENT_DIGEST = "b".repeat(64);
const GENERATED_AT = "2026-08-09T04:05:06.000Z";
const RELEASE_DIRECTORY = "/private/qualification/release";
const QUALIFIED_PREVIEW_HOST_DIGEST = "c".repeat(64);
const QUALIFIED_PREVIEW_DEPLOYMENT_ID = "preview-deployment-123";
const QUALIFIED_PREVIEW_ARTIFACT_DIGEST = "d".repeat(64);
const HOSTED_BROWSER_PROOFS = ["provisioning_entitlement_one_time_csv"];
const LIVE_PG_WITNESSES = ["provisioning_entitlement_one_time_secret_nonpersistence"];
const LIVE_PG_ROLLBACK_PHASES = ["boundary_asserted", "rollback_asserted", "reapplied", "final_asserted"];
type ProvenanceCheck = { id: string; status: string; sourceAttestationIds: string[]; metricPredicate: string };
type ProvenanceGate = { id: string; status: string; sourceAttestationIds: string[] };

const METRICS = {
    environment: { protectedInputs: "passed", targetIsolation: "passed" },
    postgres17: { major: 17 },
    install: { lockedInstall: "passed" },
    static: {
        criticalVulnerabilities: 0,
        desktopAudit: "passed",
        highVulnerabilities: 0,
        lint: "passed",
        productionAudit: "passed",
        secretScan: "passed",
        typecheck: "passed",
    },
    unit: { failedTests: 0, skippedTests: 0, totalTests: 2773 },
    browser: {
        chromiumExpected: 100,
        chromiumFlaky: 0,
        chromiumRuns: 10,
        chromiumSkipped: 0,
        chromiumUnexpected: 0,
        retries: 0,
        productionExpected: 6,
        productionFlaky: 0,
        productionProjects: ["prod-chromium", "prod-webkit-ipad"],
        productionSkipped: 0,
        productionUnexpected: 0,
        hostedExpected: 1,
        hostedFlaky: 0,
        hostedSkipped: 0,
        hostedUnexpected: 0,
        hostedProofs: HOSTED_BROWSER_PROOFS,
        proofs: QUALIFICATION_BROWSER_PROOFS,
        reportDigestSet: Array.from({ length: 10 }, (_, index) => createHash("sha256").update(`report-${index}`).digest("hex")),
        webkitExpected: 60,
        webkitFlaky: 0,
        webkitSkipped: 0,
        webkitUnexpected: 0,
        workers: 1,
    },
    build: { build: "passed", budget: "passed", pwaSmoke: "passed" },
    live_pg: {
        contract: "passed",
        postgresMajor: 17,
        proofs: QUALIFICATION_LIVE_PG_PROOFS,
        rollbackPhases: LIVE_PG_ROLLBACK_PHASES,
        witnesses: LIVE_PG_WITNESSES,
    },
    hosted: {
        anonDenied: true,
        authenticatedDenied: true,
        boundary: "passed",
        cleanupHeartbeatFresh: "passed",
        deliveryProbe: "passed",
        healthSha: "passed",
        immutablePreview: "passed",
        readinessExact: "passed",
        staticCompression: "passed",
        teacherCanary: "passed",
    },
    load: {
        cleanupVerified: true,
        concurrentMaxPdfUploads: 10,
        concurrentSubmissions: 80,
        deadQueueCount: 0,
        failures: 0,
        gatewayReadP95Ms: 500,
        logRedaction: "passed",
        maximumQueryMs: 400,
        status: "passed",
        students: 80,
        submitEndToEndP99Ms: 8_000,
        submitRpcP95Ms: 1_000,
        teacherLivePollers: 10,
        teacherUploaders: 10,
        virtualUsers: 100,
    },
    alert: { alertAck: "passed", alertResolve: "passed", roundtrip: "passed", sinkReceipt: "passed" },
    backup: { backup: "verified", createdAt: GENERATED_AT },
    restore: {
        boundary: "passed",
        browser: "passed",
        credentialRevocation: "passed",
        objectHashes: "passed",
        releaseSeal: "passed",
        rpo: "passed",
        rto: "passed",
        tableInventory: "passed",
    },
} as const;

function sourceDocuments(overrides: Record<string, unknown> = {}) {
    return QUALIFICATION_SOURCE_CATALOG.map(({ id, relativePath }) => {
        const document = {
            schemaVersion: 1,
            id,
            status: "verified",
            buildSha: BUILD_SHA,
            environmentDigest: ENVIRONMENT_DIGEST,
            sourceSha256: createHash("sha256").update(`raw:${id}`).digest("hex"),
            metrics: METRICS[id as keyof typeof METRICS],
            ...(overrides[id] ?? {}),
        };
        return { relativePath, bytes: Buffer.from(`${JSON.stringify(document)}\n`) };
    });
}

function qualificationInput(documents = sourceDocuments()) {
    return {
        buildSha: BUILD_SHA,
        environmentDigest: ENVIRONMENT_DIGEST,
        generatedAt: GENERATED_AT,
        qualifiedPreviewHostDigest: QUALIFIED_PREVIEW_HOST_DIGEST,
        qualifiedPreviewDeploymentId: QUALIFIED_PREVIEW_DEPLOYMENT_ID,
        qualifiedPreviewArtifactDigest: QUALIFIED_PREVIEW_ARTIFACT_DIGEST,
        releaseDirectory: RELEASE_DIRECTORY,
        sourceDocuments: documents,
    };
}

describe("initial operations qualification builder", () => {
    it("derives every fixed check and hard gate from strict hashed source attestations", () => {
        const result = buildInitialOperationsQualification(qualificationInput());
        const checks = result.provenance.checks as ProvenanceCheck[];
        const gates = result.provenance.hardGates as ProvenanceGate[];
        const atomicCatalog = QUALIFICATION_ATOMIC_SOURCE_CATALOG as Array<{ id: string }>;

        expect(result.provenance.checks).toHaveLength(
            RELEASE_DIMENSIONS.flatMap((dimension) => RELEASE_ATOMIC_CHECKS[dimension]).length,
        );
        expect(gates).toHaveLength(RELEASE_HARD_GATES.length);
        expect(checks.every((check) => check.sourceAttestationIds.length > 0)).toBe(true);
        expect(checks.every((check) => check.sourceAttestationIds.length >= 1
            && typeof check.metricPredicate === "string" && check.metricPredicate.includes("."))).toBe(true);
        expect(checks.filter((check) => check.sourceAttestationIds.length > 1)).toEqual([
            expect.objectContaining({
                id: "provisioning_entitlement_one_time_csv",
                sourceAttestationIds: ["browser", "live_pg"],
                metricPredicate: "all(browser.hosted-proof:provisioning_entitlement_one_time_csv,live_pg.witness:provisioning_entitlement_one_time_secret_nonpersistence)",
            }),
        ]);
        expect(atomicCatalog.map(({ id }) => id)).toEqual(
            RELEASE_DIMENSIONS.flatMap((dimension) => (RELEASE_ATOMIC_CHECKS[dimension] as Array<{ id: string }>).map(({ id }) => id)),
        );
        expect(new Set(atomicCatalog.map(({ id }) => id)).size).toBe(
            QUALIFICATION_ATOMIC_SOURCE_CATALOG.length,
        );
        expect(gates.every((gate) => gate.status === "passed")).toBe(true);
        expect(checks.filter((check) => check.status === "unverified").map((check) => check.id)).toEqual([
            "hosted_deployment_promotion_lineage",
            "recovery_release_rollback_evidence",
        ]);
        expect(Object.fromEntries(checks.map((check) => [check.id, check.sourceAttestationIds[0]]))).toMatchObject({
            student_core_history: "browser",
            teacher_core_roster: "browser",
            provisioning_entitlement_session_revocation: "live_pg",
            data_integrity_isolation_tenant_isolation: "live_pg",
            code_supply_chain_production_audit: "static",
            browser_determinism_pwa_smoke: "build",
            browser_determinism_production_e2e: "browser",
            hosted_deployment_health_sha: "hosted",
            capacity_observability_alert_roundtrip: "alert",
            capacity_observability_cleanup_heartbeat: "hosted",
            recovery_release_backup_freshness: "backup",
            recovery_release_credential_revocation: "restore",
        });
        expect(Object.fromEntries(checks.map((check) => [check.id, check.metricPredicate]))).toMatchObject({
            student_core_history: "browser.proof:student_core_history",
            teacher_core_roster: "browser.proof:teacher_core_roster",
            ux_accessibility_responsiveness_keyboard: "browser.proof:ux_accessibility_responsiveness_keyboard",
            browser_determinism_credential_boundary: "browser.proof:browser_determinism_credential_boundary",
            browser_determinism_reduced_motion: "browser.proof:browser_determinism_reduced_motion",
            browser_determinism_fresh_context: "browser.proof:browser_determinism_fresh_context",
            provisioning_entitlement_operator_provision: "live_pg.proof:provisioning_entitlement_operator_provision",
            provisioning_entitlement_one_time_csv: "all(browser.hosted-proof:provisioning_entitlement_one_time_csv,live_pg.witness:provisioning_entitlement_one_time_secret_nonpersistence)",
            provisioning_entitlement_account_recovery: "live_pg.proof:provisioning_entitlement_account_recovery",
            data_integrity_isolation_tenant_isolation: "live_pg.proof:data_integrity_isolation_tenant_isolation",
            data_integrity_isolation_rollback_contract: "live_pg.proof:data_integrity_isolation_rollback_contract",
            code_supply_chain_live_pg17: "live_pg.postgres17_exact_contract",
        });
        expect(Object.keys(result.evidenceByDimension)).toEqual(RELEASE_DIMENSIONS);
        expect(result.manifest.artifacts.find(({ kind }) => kind === "hosted_deployment")?.freshUntil).toBe(
            "2026-08-10T04:05:06.000Z",
        );
        expect(result.manifest.artifacts.find(({ kind }) => kind === "recovery_release")?.freshUntil).toBe(
            "2026-09-08T04:05:06.000Z",
        );
        expect(result.bundleIndex).toMatchObject({
            schemaVersion: 1,
            status: "verified",
            qualificationPhase: "pre_promotion",
            qualifiedPreviewHostDigest: QUALIFIED_PREVIEW_HOST_DIGEST,
            qualifiedPreviewDeploymentId: QUALIFIED_PREVIEW_DEPLOYMENT_ID,
            qualifiedPreviewArtifactDigest: QUALIFIED_PREVIEW_ARTIFACT_DIGEST,
            sourceProvenanceRelativePath: "source-provenance.json",
            relocationRequired: true,
        });
        expect(result.provenance.qualificationPhase).toBe("pre_promotion");
        expect(Object.keys(result.provenance)).toEqual([
            "schemaVersion", "status", "qualificationPhase", "qualifiedPreviewHostDigest",
            "qualifiedPreviewDeploymentId", "qualifiedPreviewArtifactDigest", "buildSha", "environmentDigest", "generatedAt",
            "checks", "hardGates",
        ]);
        expect(Object.keys(result.provenance.checks[0])).toEqual([
            "id", "status", "sourceAttestationIds", "metricPredicate",
        ]);
        expect(Object.keys(result.provenance.hardGates[0])).toEqual(["id", "status", "sourceAttestationIds"]);
        expect(Object.keys(result.bundleIndex)).toEqual([
            "schemaVersion", "status", "qualificationPhase", "qualifiedPreviewHostDigest",
            "qualifiedPreviewDeploymentId", "qualifiedPreviewArtifactDigest", "buildSha", "environmentDigest", "generatedAt",
            "manifestRelativePath", "manifestSha256", "artifacts", "sourceProvenanceRelativePath",
            "sourceProvenanceSha256", "sourceAttestations", "relocationRequired",
        ]);
        expect(result.bundleIndex.sourceAttestations).toEqual(
            QUALIFICATION_SOURCE_CATALOG.map(({ id, relativePath }) => expect.objectContaining({
                id,
                relativePath,
                sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            })),
        );
    });

    it("requires both the exact hosted CSV owner and PostgreSQL secret-nonpersistence witness", () => {
        const browserOnlyMissing = sourceDocuments({
            browser: { metrics: { ...METRICS.browser, hostedProofs: [] } },
        });
        const pgOnlyMissing = sourceDocuments({
            live_pg: { metrics: { ...METRICS.live_pg, witnesses: [] } },
        });
        expect(() => buildInitialOperationsQualification(qualificationInput(browserOnlyMissing)))
            .toThrow("Qualification source evidence is invalid");
        expect(() => buildInitialOperationsQualification(qualificationInput(pgOnlyMissing)))
            .toThrow("Qualification source evidence is invalid");
        const passing = buildInitialOperationsQualification(qualificationInput());
        expect(passing.provenance.checks.find(
            ({ id }: { id: string }) => id === "provisioning_entitlement_one_time_csv",
        ))
            .toMatchObject({ status: "passed", sourceAttestationIds: ["browser", "live_pg"] });
    });

    it.each([
        ["unit", { metrics: { ...METRICS.unit, skippedTests: 1 } }],
        ["browser", { metrics: { ...METRICS.browser, chromiumFlaky: 1 } }],
        ["browser", { metrics: { ...METRICS.browser, chromiumExpected: 1, chromiumRuns: 1 } }],
        ["browser", { metrics: { ...METRICS.browser, chromiumRuns: 1 } }],
        ["browser", { metrics: { ...METRICS.browser, productionExpected: 0 } }],
        ["browser", { metrics: { ...METRICS.browser, proofs: [] } }],
        ["browser", { metrics: { ...METRICS.browser, hostedProofs: [] } }],
        ["live_pg", { metrics: { contract: "passed", postgresMajor: 17 } }],
        ["live_pg", { metrics: { ...METRICS.live_pg, proofs: QUALIFICATION_LIVE_PG_PROOFS.slice(0, -1) } }],
        ["live_pg", { metrics: { ...METRICS.live_pg, rollbackPhases: LIVE_PG_ROLLBACK_PHASES.slice(1) } }],
        ["live_pg", { metrics: { ...METRICS.live_pg, witnesses: [] } }],
        ["static", { metrics: { ...METRICS.static, highVulnerabilities: 1 } }],
        ["hosted", { metrics: { ...METRICS.hosted, anonDenied: false } }],
        ["hosted", { metrics: { ...METRICS.hosted, cleanupHeartbeatFresh: "failed" } }],
        ["load", { metrics: { ...METRICS.load, virtualUsers: 99 } }],
        ["load", { metrics: { ...METRICS.load, submitRpcP95Ms: 1_500 } }],
        ["load", { metrics: { ...METRICS.load, deadQueueCount: 1 } }],
        ["load", { metrics: { ...METRICS.load, logRedaction: "failed" } }],
        ["alert", { metrics: { ...METRICS.alert, sinkReceipt: "failed" } }],
        ["restore", { metrics: { ...METRICS.restore, credentialRevocation: "failed" } }],
    ])("rejects false-pass source evidence for %s", (id, override) => {
        expect(() => buildInitialOperationsQualification(
            qualificationInput(sourceDocuments({ [id]: override })),
        )).toThrow("Qualification source evidence is invalid");
    });

    it("rejects missing, extra-key, wrong-build, and oversized source envelopes", () => {
        const valid = sourceDocuments();
        expect(() => buildInitialOperationsQualification(qualificationInput(valid.slice(1))))
            .toThrow("Qualification source evidence is invalid");

        const extra = sourceDocuments({ environment: { extra: true } });
        const wrongBuild = sourceDocuments({ environment: { buildSha: "c".repeat(40) } });
        const huge = sourceDocuments();
        huge[0] = { ...huge[0], bytes: Buffer.alloc(128 * 1024 + 1, 65) };
        for (const documents of [extra, wrongBuild, huge]) {
            expect(() => buildInitialOperationsQualification(qualificationInput(documents)))
                .toThrow("Qualification source evidence is invalid");
        }
    });

    it("rejects malformed or substitutable qualified preview bindings", () => {
        for (const override of [
            { qualifiedPreviewHostDigest: "C".repeat(64) },
            { qualifiedPreviewDeploymentId: "../preview" },
            { qualifiedPreviewArtifactDigest: "sha256:" + "d".repeat(64) },
        ]) expect(() => buildInitialOperationsQualification({ ...qualificationInput(), ...override }))
            .toThrow("Qualification source evidence is invalid");
    });

    it("never serializes source contents, paths outside release, tokens, or answers", () => {
        const result = buildInitialOperationsQualification(qualificationInput());
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain("raw:");
        expect(serialized).not.toContain("token");
        expect(serialized).not.toContain("answer");
        expect(serialized).not.toContain("/tmp/");
    });

    it("produces an honest pre-promotion GO with only the two approved weighted checks unverified", async () => {
        const result = buildInitialOperationsQualification(qualificationInput());
        const evidenceByPath = new Map(RELEASE_DIMENSIONS.map((dimension) => [
            `${RELEASE_DIRECTORY}/evidence-${dimension}.json`,
            Buffer.from(`${JSON.stringify((result.evidenceByDimension as Record<string, unknown>)[dimension])}\n`),
        ]));
        const score = await scoreReleaseEvidence(result.manifest, {
            scorerSha: BUILD_SHA,
            now: () => new Date(GENERATED_AT),
            readArtifact: async (path: string) => evidenceByPath.get(path) ?? Buffer.alloc(0),
        });

        expect(score).toMatchObject({ status: "go", mean: 9.82, minimum: 9, hardGateFailures: [] });
        expect(score.dimensions).toMatchObject({ hosted_deployment: 9.2, recovery_release: 9 });
    });
});
