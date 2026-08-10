#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
    RELEASE_ARTIFACT_CATALOG,
    RELEASE_ATOMIC_CHECKS,
    RELEASE_DIMENSIONS,
    RELEASE_HARD_GATE_PREDICATES,
    RELEASE_HARD_GATES,
} from "./release-quality-core.mjs";
import { BROWSER_RELEASE_PROOF_IDS } from "./browser-release-proof-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const BUILD_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PREVIEW_DEPLOYMENT_ID = /^[A-Za-z0-9._:-]{3,200}$/;
const MAX_SOURCE_BYTES = 128 * 1024;
export const QUALIFICATION_PHASE = "pre_promotion";
const SOURCE_IDS = Object.freeze([
    "environment", "postgres17", "install", "static", "unit", "browser", "build", "live_pg",
    "hosted", "load", "alert", "backup", "restore",
]);

export const QUALIFICATION_SOURCE_CATALOG = Object.freeze(SOURCE_IDS.map((id) => Object.freeze({
    id,
    relativePath: `sources/source-${id}.json`,
})));

export const QUALIFICATION_BROWSER_PROOFS = BROWSER_RELEASE_PROOF_IDS;

function atomicSourceRule(id) {
    const [dimension, name] = RELEASE_DIMENSIONS
        .map((candidate) => [candidate, id.slice(candidate.length + 1)])
        .find(([candidate]) => id.startsWith(`${candidate}_`)) ?? [];
    if (!dimension || !name) fail();
    if (["student_core", "teacher_core", "ux_accessibility_responsiveness"].includes(dimension)) {
        return { sourceId: "browser", metricPredicate: `browser.proof:${id}` };
    }
    if (dimension === "provisioning_entitlement") {
        return { sourceId: "live_pg", metricPredicate: "live_pg.exact_contract" };
    }
    if (dimension === "data_integrity_isolation") {
        return { sourceId: "live_pg", metricPredicate: "live_pg.exact_contract" };
    }
    if (dimension === "code_supply_chain") {
        const rules = {
            locked_install: ["install", "install.locked"],
            production_audit: ["static", "static.production_vulnerabilities_zero"],
            desktop_audit: ["static", "static.desktop_audit"],
            lint: ["static", "static.lint"],
            typecheck: ["static", "static.typecheck"],
            unit_suite: ["unit", "unit.zero_failure_skip"],
            live_pg17: ["live_pg", "live_pg.postgres17_exact_contract"],
            build_budget: ["build", "build.budget"],
            secret_scan: ["static", "static.secret_scan"],
            artifact_provenance: ["environment", "environment.protected_identity"],
        };
        const rule = rules[name];
        if (!rule) fail();
        return { sourceId: rule[0], metricPredicate: rule[1] };
    }
    if (dimension === "browser_determinism") {
        if (BROWSER_RELEASE_PROOF_IDS.includes(id)) {
            return { sourceId: "browser", metricPredicate: `browser.proof:${id}` };
        }
        if (name === "pwa_smoke") return { sourceId: "build", metricPredicate: "build.pwa_smoke" };
        if (name === "production_e2e") return { sourceId: "browser", metricPredicate: "browser.production_e2e" };
        return { sourceId: "browser", metricPredicate: `browser.${name}` };
    }
    if (dimension === "hosted_deployment") {
        if (name === "promotion_lineage") return { sourceId: "environment", metricPredicate: "phase.post_promotion_required" };
        return { sourceId: "hosted", metricPredicate: `hosted.${name}` };
    }
    if (dimension === "capacity_observability") {
        if (["central_sink", "alert_roundtrip"].includes(name)) {
            return { sourceId: "alert", metricPredicate: `alert.${name}` };
        }
        if (name === "cleanup_heartbeat") {
            return { sourceId: "hosted", metricPredicate: "hosted.cleanup_heartbeat" };
        }
        return { sourceId: "load", metricPredicate: `load.${name}` };
    }
    if (dimension === "recovery_release") {
        if (name === "backup_freshness") return { sourceId: "backup", metricPredicate: "backup.fresh" };
        if (name === "rollback_evidence") return { sourceId: "restore", metricPredicate: "phase.post_promotion_required" };
        return { sourceId: "restore", metricPredicate: `restore.${name}` };
    }
    fail();
}

export const QUALIFICATION_ATOMIC_SOURCE_CATALOG = Object.freeze(
    RELEASE_DIMENSIONS.flatMap((dimension) => RELEASE_ATOMIC_CHECKS[dimension].map(({ id }) => Object.freeze({
        id,
        ...atomicSourceRule(id),
    }))),
);

const UNVERIFIED_CHECKS = new Set([
    "hosted_deployment_promotion_lineage",
    "recovery_release_rollback_evidence",
]);

export class InitialOperationsQualificationError extends Error {
    constructor() {
        super("Qualification source evidence is invalid");
        this.name = "InitialOperationsQualificationError";
    }
}

function fail() {
    throw new InitialOperationsQualificationError();
}

function exactRecord(value, expectedKeys) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail();
    const actual = keys.sort();
    const expected = [...expectedKeys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail();
    for (const key of actual) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) fail();
    }
    return Object.fromEntries(actual.map((key) => [key, descriptors[key].value]));
}

function exactArray(value, length) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length !== length) fail();
    const keys = Reflect.ownKeys(value);
    if (keys.length !== length + 1 || keys[length] !== "length"
        || keys.slice(0, length).some((key, index) => key !== String(index))) fail();
    return [...value];
}

function canonicalIso(value) {
    if (typeof value !== "string") fail();
    const milliseconds = Date.parse(value);
    if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) fail();
    return milliseconds;
}

function passed(value) {
    if (value !== "passed") fail();
}

function zero(value) {
    if (value !== 0) fail();
}

function positiveInteger(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail();
}

function validateMetrics(id, value) {
    const predicates = [];
    if (id === "environment") {
        const metrics = exactRecord(value, ["protectedInputs", "targetIsolation"]);
        passed(metrics.protectedInputs); passed(metrics.targetIsolation);
        predicates.push("environment.protected_identity");
    } else if (id === "postgres17") {
        const metrics = exactRecord(value, ["major"]);
        if (metrics.major !== 17) fail();
        predicates.push("postgres17.major");
    } else if (id === "install") {
        passed(exactRecord(value, ["lockedInstall"]).lockedInstall);
        predicates.push("install.locked");
    } else if (id === "static") {
        const metrics = exactRecord(value, [
            "criticalVulnerabilities", "desktopAudit", "highVulnerabilities", "lint", "productionAudit",
            "secretScan", "typecheck",
        ]);
        zero(metrics.criticalVulnerabilities); zero(metrics.highVulnerabilities);
        for (const key of ["desktopAudit", "lint", "productionAudit", "secretScan", "typecheck"]) passed(metrics[key]);
        predicates.push("static.production_vulnerabilities_zero", "static.desktop_audit", "static.lint",
            "static.typecheck", "static.secret_scan");
    } else if (id === "unit") {
        const metrics = exactRecord(value, ["failedTests", "skippedTests", "totalTests"]);
        zero(metrics.failedTests); zero(metrics.skippedTests); positiveInteger(metrics.totalTests);
        predicates.push("unit.zero_failure_skip");
    } else if (id === "browser") {
        const metrics = exactRecord(value, [
            "chromiumExpected", "chromiumFlaky", "chromiumRuns", "chromiumSkipped", "chromiumUnexpected",
            "hostedExpected", "hostedFlaky", "hostedSkipped", "hostedUnexpected", "productionExpected",
            "productionFlaky", "productionProjects", "productionSkipped", "productionUnexpected", "proofs",
            "reportDigestSet", "retries", "webkitExpected",
            "webkitFlaky", "webkitSkipped", "webkitUnexpected", "workers",
        ]);
        if (!Number.isSafeInteger(metrics.chromiumExpected) || metrics.chromiumExpected < 40
            || metrics.chromiumRuns !== 10
            || !Number.isSafeInteger(metrics.webkitExpected) || metrics.webkitExpected < 10) fail();
        const digestSet = exactArray(metrics.reportDigestSet, 10);
        if (digestSet.some((digest) => typeof digest !== "string" || !SHA256.test(digest))
            || new Set(digestSet).size !== 10) fail();
        if (!Number.isSafeInteger(metrics.productionExpected) || metrics.productionExpected < 6) fail();
        positiveInteger(metrics.hostedExpected);
        const productionProjects = exactArray(metrics.productionProjects, 2);
        if (productionProjects[0] !== "prod-chromium" || productionProjects[1] !== "prod-webkit-ipad") fail();
        for (const key of [
            "chromiumFlaky", "chromiumSkipped", "chromiumUnexpected", "retries", "webkitFlaky",
            "webkitSkipped", "webkitUnexpected", "hostedFlaky", "hostedSkipped", "hostedUnexpected",
            "productionFlaky", "productionSkipped", "productionUnexpected",
        ]) zero(metrics[key]);
        if (metrics.workers !== 1) fail();
        const proofs = exactArray(metrics.proofs, QUALIFICATION_BROWSER_PROOFS.length);
        if (proofs.some((proof, index) => proof !== QUALIFICATION_BROWSER_PROOFS[index])) fail();
        predicates.push(...proofs.map((proof) => `browser.proof:${proof}`));
        predicates.push("browser.zero_failure_full_suite", "browser.chromium_repeat", "browser.webkit_core",
            "browser.production_e2e", "browser.zero_retry", "browser.zero_order_dependence", "browser.skip_accounting");
    } else if (id === "build") {
        const metrics = exactRecord(value, ["budget", "build", "pwaSmoke"]);
        passed(metrics.budget); passed(metrics.build); passed(metrics.pwaSmoke);
        predicates.push("build.budget", "build.pwa_smoke");
    } else if (id === "live_pg") {
        const metrics = exactRecord(value, ["contract", "postgresMajor"]);
        passed(metrics.contract); if (metrics.postgresMajor !== 17) fail();
        predicates.push("live_pg.exact_contract", "live_pg.postgres17_exact_contract");
    } else if (id === "hosted") {
        const metrics = exactRecord(value, [
            "anonDenied", "authenticatedDenied", "boundary", "cleanupHeartbeatFresh", "deliveryProbe", "healthSha",
            "immutablePreview", "readinessExact", "staticCompression", "teacherCanary",
        ]);
        if (metrics.anonDenied !== true || metrics.authenticatedDenied !== true) fail();
        for (const key of ["boundary", "cleanupHeartbeatFresh", "deliveryProbe", "healthSha", "immutablePreview", "readinessExact",
            "staticCompression", "teacherCanary"]) passed(metrics[key]);
        predicates.push("hosted.immutable_preview", "hosted.health_sha", "hosted.readiness_exact",
            "hosted.database_boundary", "hosted.anon_denial", "hosted.authenticated_denial",
            "hosted.teacher_canary", "hosted.delivery_probe", "hosted.static_compression");
        predicates.push("hosted.cleanup_heartbeat");
    } else if (id === "load") {
        const metrics = exactRecord(value, [
            "cleanupVerified", "concurrentMaxPdfUploads", "concurrentSubmissions", "failures",
            "deadQueueCount", "gatewayReadP95Ms", "logRedaction", "maximumQueryMs", "status", "students",
            "submitEndToEndP99Ms", "submitRpcP95Ms", "teacherLivePollers", "teacherUploaders", "virtualUsers",
        ]);
        if (metrics.status !== "passed" || metrics.cleanupVerified !== true || metrics.virtualUsers !== 100
            || metrics.students !== 80 || metrics.teacherLivePollers !== 10 || metrics.teacherUploaders !== 10
            || metrics.concurrentSubmissions !== 80 || metrics.concurrentMaxPdfUploads !== 10) fail();
        zero(metrics.failures); zero(metrics.deadQueueCount);
        passed(metrics.logRedaction);
        for (const key of ["gatewayReadP95Ms", "maximumQueryMs", "submitEndToEndP99Ms", "submitRpcP95Ms"]) {
            if (typeof metrics[key] !== "number" || !Number.isFinite(metrics[key]) || metrics[key] < 0) fail();
        }
        if (metrics.gatewayReadP95Ms >= 750 || metrics.submitRpcP95Ms >= 1_500
            || metrics.submitEndToEndP99Ms >= 9_000 || metrics.maximumQueryMs > 500) fail();
        predicates.push("load.hundred_user_load", "load.read_p95", "load.submit_p95", "load.submit_p99",
            "load.query_budget", "load.log_redaction", "load.dead_queue");
    } else if (id === "alert") {
        const metrics = exactRecord(value, ["alertAck", "alertResolve", "roundtrip", "sinkReceipt"]);
        for (const key of Object.keys(metrics)) passed(metrics[key]);
        predicates.push("alert.central_sink", "alert.alert_roundtrip");
    } else if (id === "backup") {
        const metrics = exactRecord(value, ["backup", "createdAt"]);
        if (metrics.backup !== "verified") fail(); canonicalIso(metrics.createdAt);
        predicates.push("backup.fresh");
    } else if (id === "restore") {
        const metrics = exactRecord(value, [
            "boundary", "browser", "credentialRevocation", "objectHashes", "releaseSeal", "rpo", "rto",
            "tableInventory",
        ]);
        for (const key of Object.keys(metrics)) passed(metrics[key]);
        predicates.push("restore.rpo", "restore.rto", "restore.table_inventory", "restore.object_hashes",
            "restore.restore_boundary", "restore.restore_browser", "restore.credential_revocation",
            "restore.release_seal");
    } else fail();
    return Object.freeze(predicates);
}

function parseSourceDocument(document, catalog, buildSha, environmentDigest) {
    const entry = exactRecord(document, ["bytes", "relativePath"]);
    if (entry.relativePath !== catalog.relativePath || !(entry.bytes instanceof Uint8Array)
        || entry.bytes.byteLength < 2 || entry.bytes.byteLength > MAX_SOURCE_BYTES) fail();
    let raw;
    try { raw = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes)); } catch { fail(); }
    const value = exactRecord(raw, [
        "buildSha", "environmentDigest", "id", "metrics", "schemaVersion", "sourceSha256", "status",
    ]);
    if (value.schemaVersion !== 1 || value.id !== catalog.id || value.status !== "verified"
        || value.buildSha !== buildSha || value.environmentDigest !== environmentDigest
        || !SHA256.test(value.sourceSha256)) fail();
    const metricPredicates = validateMetrics(value.id, value.metrics);
    return Object.freeze({
        id: value.id,
        relativePath: entry.relativePath,
        sha256: createHash("sha256").update(entry.bytes).digest("hex"),
        metricPredicates,
    });
}

function serialized(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function exactInput(input) {
    const value = exactRecord(input, [
        "buildSha", "environmentDigest", "generatedAt", "qualifiedPreviewArtifactDigest",
        "qualifiedPreviewDeploymentId", "qualifiedPreviewHostDigest", "releaseDirectory", "sourceDocuments",
    ]);
    if (!BUILD_SHA.test(value.buildSha) || !SHA256.test(value.environmentDigest)
        || !SHA256.test(value.qualifiedPreviewHostDigest)
        || !SHA256.test(value.qualifiedPreviewArtifactDigest)
        || !PREVIEW_DEPLOYMENT_ID.test(value.qualifiedPreviewDeploymentId)
        || !isAbsolute(value.releaseDirectory) || resolve(value.releaseDirectory) !== value.releaseDirectory) fail();
    canonicalIso(value.generatedAt);
    return value;
}

export function buildInitialOperationsQualification(input) {
    const value = exactInput(input);
    const documents = exactArray(value.sourceDocuments, QUALIFICATION_SOURCE_CATALOG.length);
    const parsedSources = documents.map((document, index) => parseSourceDocument(
        document,
        QUALIFICATION_SOURCE_CATALOG[index],
        value.buildSha,
        value.environmentDigest,
    ));
    const sourceAttestations = parsedSources.map(({ id, relativePath, sha256 }) => Object.freeze({ id, relativePath, sha256 }));
    const sourceIds = new Set(parsedSources.map(({ id }) => id));
    const predicateBySource = new Map(parsedSources.map(({ id, metricPredicates }) => [id, new Set(metricPredicates)]));
    const ruleByCheck = new Map(QUALIFICATION_ATOMIC_SOURCE_CATALOG.map((rule) => [rule.id, rule]));
    const checks = RELEASE_DIMENSIONS.flatMap((dimension) => RELEASE_ATOMIC_CHECKS[dimension].map(({ id }) => {
        const rule = ruleByCheck.get(id);
        if (!rule || !sourceIds.has(rule.sourceId)
            || (!UNVERIFIED_CHECKS.has(id) && !predicateBySource.get(rule.sourceId)?.has(rule.metricPredicate))) fail();
        return Object.freeze({
            id,
            status: UNVERIFIED_CHECKS.has(id) ? "unverified" : "passed",
            sourceAttestationIds: Object.freeze([rule.sourceId]),
            metricPredicate: rule.metricPredicate,
        });
    }));
    const checkStatus = new Map(checks.map((check) => [check.id, check.status]));
    const hardGates = RELEASE_HARD_GATES.map((id) => Object.freeze({
        id,
        status: RELEASE_HARD_GATE_PREDICATES[id].every((checkId) => checkStatus.get(checkId) === "passed")
            ? "passed" : "failed",
        sourceAttestationIds: Object.freeze([...new Set(RELEASE_HARD_GATE_PREDICATES[id]
            .map((checkId) => ruleByCheck.get(checkId)?.sourceId))]),
    }));
    const provenance = Object.freeze({
        schemaVersion: 1,
        status: "verified",
        qualificationPhase: QUALIFICATION_PHASE,
        qualifiedPreviewHostDigest: value.qualifiedPreviewHostDigest,
        qualifiedPreviewDeploymentId: value.qualifiedPreviewDeploymentId,
        qualifiedPreviewArtifactDigest: value.qualifiedPreviewArtifactDigest,
        buildSha: value.buildSha,
        environmentDigest: value.environmentDigest,
        generatedAt: value.generatedAt,
        checks: Object.freeze(checks),
        hardGates: Object.freeze(hardGates),
    });
    const provenanceBytes = serialized(provenance);
    const gateStatus = new Map(hardGates.map((gate) => [gate.id, gate.status]));
    const evidenceByDimension = {};
    const artifacts = [];
    const bundleArtifacts = [];
    for (const dimension of RELEASE_DIMENSIONS) {
        const catalog = RELEASE_ARTIFACT_CATALOG[dimension];
        const evidence = Object.freeze({
            schemaVersion: 1,
            kind: dimension,
            buildSha: value.buildSha,
            environmentDigest: value.environmentDigest,
            generatedAt: value.generatedAt,
            status: "verified",
            checks: Object.freeze(RELEASE_ATOMIC_CHECKS[dimension].map(({ id }) => Object.freeze({
                id, status: checkStatus.get(id),
            }))),
            hardGates: Object.freeze(catalog.hardGates.map((id) => Object.freeze({ id, status: gateStatus.get(id) }))),
        });
        evidenceByDimension[dimension] = evidence;
        const relativePath = `evidence-${dimension}.json`;
        const digest = createHash("sha256").update(serialized(evidence)).digest("hex");
        artifacts.push(Object.freeze({
            id: catalog.id,
            kind: dimension,
            evidenceClass: catalog.evidenceClass,
            path: join(value.releaseDirectory, relativePath),
            sha256: digest,
            generatedAt: value.generatedAt,
            freshUntil: new Date(Date.parse(value.generatedAt) + catalog.maxAgeMs).toISOString(),
            buildSha: value.buildSha,
            environmentDigest: value.environmentDigest,
            status: "verified",
        }));
        bundleArtifacts.push(Object.freeze({ id: catalog.id, kind: dimension, relativePath, sha256: digest }));
    }
    const dimensions = RELEASE_DIMENSIONS.map((id) => Object.freeze({
        id,
        checks: Object.freeze(RELEASE_ATOMIC_CHECKS[id].map((check) => Object.freeze({
            ...check,
            artifactId: RELEASE_ARTIFACT_CATALOG[id].id,
        }))),
    }));
    const manifestHardGates = RELEASE_HARD_GATES.map((id) => {
        const dimension = RELEASE_DIMENSIONS.find((candidate) => RELEASE_ARTIFACT_CATALOG[candidate].hardGates.includes(id));
        return Object.freeze({ id, artifactId: RELEASE_ARTIFACT_CATALOG[dimension].id });
    });
    const manifest = Object.freeze({
        schemaVersion: 1,
        buildSha: value.buildSha,
        environmentDigest: value.environmentDigest,
        generatedAt: value.generatedAt,
        artifacts: Object.freeze(artifacts),
        dimensions: Object.freeze(dimensions),
        hardGates: Object.freeze(manifestHardGates),
    });
    const manifestBytes = serialized(manifest);
    const bundleIndex = Object.freeze({
        schemaVersion: 1,
        status: "verified",
        qualificationPhase: QUALIFICATION_PHASE,
        qualifiedPreviewHostDigest: value.qualifiedPreviewHostDigest,
        qualifiedPreviewDeploymentId: value.qualifiedPreviewDeploymentId,
        qualifiedPreviewArtifactDigest: value.qualifiedPreviewArtifactDigest,
        buildSha: value.buildSha,
        environmentDigest: value.environmentDigest,
        generatedAt: value.generatedAt,
        manifestRelativePath: "release-quality-manifest.json",
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        artifacts: Object.freeze(bundleArtifacts),
        sourceProvenanceRelativePath: "source-provenance.json",
        sourceProvenanceSha256: createHash("sha256").update(provenanceBytes).digest("hex"),
        sourceAttestations: Object.freeze(sourceAttestations),
        relocationRequired: true,
    });
    return Object.freeze({
        provenance,
        evidenceByDimension: Object.freeze(evidenceByDimension),
        manifest,
        bundleIndex,
    });
}

async function readBoundedFile(path) {
    let handle;
    try {
        const before = await lstat(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
            || before.size < 2 || before.size > MAX_SOURCE_BYTES) fail();
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (bytes.byteLength !== opened.size || after.dev !== opened.dev || after.ino !== opened.ino
            || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail();
        return bytes;
    } catch (error) {
        if (error instanceof InitialOperationsQualificationError) throw error;
        fail();
    } finally {
        if (handle) await handle.close().catch(() => fail());
    }
}

async function writeExclusive(path, value) {
    let handle;
    try {
        handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        await handle.writeFile(serialized(value));
        await handle.sync();
        const stats = await handle.stat();
        if (!stats.isFile() || (stats.mode & 0o777) !== 0o600) fail();
    } finally {
        if (handle) await handle.close();
    }
}

function parseArgs(argv) {
    if (!Array.isArray(argv) || argv.length !== 7) fail();
    const result = {};
    for (const argument of argv) {
        if (typeof argument !== "string") fail();
        const match = /^--(build|environment|generated-at|preview-host-digest|preview-deployment-id|preview-artifact-digest|release)=(.*)$/.exec(argument);
        if (!match || Object.hasOwn(result, match[1])) fail();
        result[match[1]] = match[2];
    }
    return result;
}

export async function writeInitialOperationsQualificationBundle(input) {
    const documents = await Promise.all(QUALIFICATION_SOURCE_CATALOG.map(async ({ relativePath }) => ({
        relativePath,
        bytes: await readBoundedFile(join(input.releaseDirectory, relativePath)),
    })));
    const result = buildInitialOperationsQualification({ ...input, sourceDocuments: documents });
    for (const dimension of RELEASE_DIMENSIONS) {
        await writeExclusive(join(input.releaseDirectory, `evidence-${dimension}.json`), result.evidenceByDimension[dimension]);
    }
    await writeExclusive(join(input.releaseDirectory, "source-provenance.json"), result.provenance);
    await writeExclusive(join(input.releaseDirectory, "release-quality-manifest.json"), result.manifest);
    await writeExclusive(join(input.releaseDirectory, "bundle-index.json"), result.bundleIndex);
    return result;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await writeInitialOperationsQualificationBundle({
        buildSha: args.build,
        environmentDigest: args.environment,
        generatedAt: args["generated-at"],
        qualifiedPreviewHostDigest: args["preview-host-digest"],
        qualifiedPreviewDeploymentId: args["preview-deployment-id"],
        qualifiedPreviewArtifactDigest: args["preview-artifact-digest"],
        releaseDirectory: args.release,
    });
    process.stdout.write("verified: qualification_bundle_built\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try { await main(); } catch { process.stderr.write("unverified: qualification_bundle_invalid\n"); process.exitCode = 1; }
}
