import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { parseStrictJson } from "./strict-json.mjs";

export const RELEASE_DIMENSIONS = Object.freeze([
    "student_core",
    "teacher_core",
    "provisioning_entitlement",
    "data_integrity_isolation",
    "code_supply_chain",
    "browser_determinism",
    "ux_accessibility_responsiveness",
    "hosted_deployment",
    "capacity_observability",
    "recovery_release",
]);

export const RELEASE_HARD_GATES = Object.freeze([
    "core_e2e",
    "health_readiness",
    "production_boundary",
    "hundred_user_load",
    "submission_integrity",
    "data_exposure",
    "secret_hygiene",
    "log_hygiene",
    "sink_alert_heartbeat",
    "restore_rpo_rto",
    "production_vulnerabilities",
    "unexplained_skips",
]);

const FIXED_CHECK_WEIGHTS = Object.freeze([13, 8, 7, 12, 10, 10, 10, 10, 10, 10]);
const CHECK_NAMES = Object.freeze({
    student_core: ["identity_entry", "assignment_state", "autosave_resume", "exact_submit", "history", "question_feedback", "cross_device", "handwriting_recovery", "retake", "guest_boundary"],
    teacher_core: ["teacher_login", "truthful_load_states", "draft_create", "publish_distribution", "live_monitor", "results_feedback", "statistics", "csv_export", "roster", "retest"],
    provisioning_entitlement: ["operator_provision", "provision_audit", "pilot_grant", "student_batch", "one_time_csv", "credential_rotation", "session_revocation", "invite_lifecycle", "assignment_binding", "account_recovery"],
    data_integrity_isolation: ["tenant_isolation", "canonical_acl", "submission_replay", "quota_atomicity", "receipt_replay", "session_generation", "roster_cas", "question_atomicity", "storage_isolation", "rollback_contract"],
    code_supply_chain: ["locked_install", "production_audit", "desktop_audit", "lint", "typecheck", "unit_suite", "live_pg17", "build_budget", "secret_scan", "artifact_provenance"],
    browser_determinism: ["chromium_repeat", "webkit_core", "production_e2e", "zero_retry", "zero_order_dependence", "credential_boundary", "reduced_motion", "fresh_context", "pwa_smoke", "skip_accounting"],
    ux_accessibility_responsiveness: ["student_mobile", "teacher_mobile", "tablet", "desktop", "keyboard", "screen_reader", "contrast", "reduced_motion", "load_states", "error_recovery"],
    hosted_deployment: ["immutable_preview", "promotion_lineage", "health_sha", "readiness_exact", "database_boundary", "anon_denial", "authenticated_denial", "teacher_canary", "delivery_probe", "static_compression"],
    capacity_observability: ["hundred_user_load", "read_p95", "submit_p95", "submit_p99", "query_budget", "log_redaction", "central_sink", "alert_roundtrip", "cleanup_heartbeat", "dead_queue"],
    recovery_release: ["backup_freshness", "rpo", "rto", "table_inventory", "object_hashes", "restore_boundary", "restore_browser", "credential_revocation", "rollback_evidence", "release_seal"],
});

export const RELEASE_ATOMIC_CHECKS = Object.freeze(Object.fromEntries(
    RELEASE_DIMENSIONS.map((dimension) => [dimension, Object.freeze(
        CHECK_NAMES[dimension].map((name, index) => Object.freeze({
            id: `${dimension}_${name}`,
            weightTenths: FIXED_CHECK_WEIGHTS[index],
        })),
    )]),
));

export const RELEASE_HARD_GATE_PREDICATES = Object.freeze(Object.fromEntries(Object.entries({
    core_e2e: [
        "teacher_core_teacher_login",
        "browser_determinism_chromium_repeat",
        "browser_determinism_webkit_core",
        "browser_determinism_production_e2e",
        "browser_determinism_zero_retry",
        "browser_determinism_zero_order_dependence",
    ],
    health_readiness: [
        "hosted_deployment_health_sha",
        "hosted_deployment_readiness_exact",
    ],
    production_boundary: [
        "data_integrity_isolation_tenant_isolation",
        "data_integrity_isolation_canonical_acl",
        "hosted_deployment_database_boundary",
        "hosted_deployment_anon_denial",
        "hosted_deployment_authenticated_denial",
    ],
    hundred_user_load: ["capacity_observability_hundred_user_load"],
    submission_integrity: [
        "student_core_exact_submit",
        "data_integrity_isolation_submission_replay",
        "data_integrity_isolation_receipt_replay",
        "data_integrity_isolation_question_atomicity",
    ],
    data_exposure: [
        "data_integrity_isolation_tenant_isolation",
        "data_integrity_isolation_canonical_acl",
        "data_integrity_isolation_storage_isolation",
    ],
    secret_hygiene: [
        "provisioning_entitlement_one_time_csv",
        "code_supply_chain_secret_scan",
    ],
    log_hygiene: ["capacity_observability_log_redaction"],
    sink_alert_heartbeat: [
        "capacity_observability_central_sink",
        "capacity_observability_alert_roundtrip",
        "capacity_observability_cleanup_heartbeat",
    ],
    restore_rpo_rto: [
        "recovery_release_backup_freshness",
        "recovery_release_rpo",
        "recovery_release_rto",
        "recovery_release_table_inventory",
        "recovery_release_object_hashes",
        "recovery_release_restore_boundary",
        "recovery_release_restore_browser",
    ],
    production_vulnerabilities: ["code_supply_chain_production_audit"],
    unexplained_skips: ["browser_determinism_skip_accounting"],
}).map(([gate, checks]) => [gate, Object.freeze(checks)])));

const HARD_GATE_ARTIFACT_KIND = Object.freeze({
    core_e2e: "browser_determinism",
    health_readiness: "hosted_deployment",
    production_boundary: "data_integrity_isolation",
    hundred_user_load: "capacity_observability",
    submission_integrity: "student_core",
    data_exposure: "data_integrity_isolation",
    secret_hygiene: "code_supply_chain",
    log_hygiene: "capacity_observability",
    sink_alert_heartbeat: "capacity_observability",
    restore_rpo_rto: "recovery_release",
    production_vulnerabilities: "code_supply_chain",
    unexplained_skips: "browser_determinism",
});

const DAY_MS = 24 * 60 * 60 * 1000;
export const RELEASE_ARTIFACT_CATALOG = Object.freeze(Object.fromEntries(
    RELEASE_DIMENSIONS.map((kind) => [kind, Object.freeze({
        id: `evidence-${kind}`,
        kind,
        evidenceClass: kind === "recovery_release"
            ? "restore_30d"
            : ["hosted_deployment", "capacity_observability"].includes(kind)
                ? "hosted_bound_24h"
                : "source_browser_24h",
        maxAgeMs: kind === "recovery_release" ? 30 * DAY_MS : DAY_MS,
        hardGates: Object.freeze(RELEASE_HARD_GATES.filter((gate) => HARD_GATE_ARTIFACT_KIND[gate] === kind)),
    })]),
));

export const RELEASE_QUALITY_SCHEMA_VERSION = 1;

const BUILD_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_STATUSES = new Set(["passed", "failed", "skipped", "unverified"]);
const ARTIFACT_STATUSES = new Set(["verified", "unverified"]);
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class ReleaseQualityError extends Error {
    constructor(code = "invalid_manifest") {
        super("Release quality evidence is invalid");
        this.name = "ReleaseQualityError";
        this.code = code;
    }
}

function fail(code = "invalid_manifest") {
    throw new ReleaseQualityError(code);
}

function descriptors(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    const properties = Object.getOwnPropertyDescriptors(value);
    for (const key of Reflect.ownKeys(properties)) {
        const descriptor = properties[key];
        if (!("value" in descriptor) || typeof descriptor.get === "function" || typeof descriptor.set === "function") fail();
    }
    return properties;
}

function exactRecord(value, expectedKeys) {
    const properties = descriptors(value);
    const ownKeys = Reflect.ownKeys(properties);
    if (ownKeys.some((key) => typeof key !== "string")) fail();
    const keys = ownKeys.sort();
    const expected = [...expectedKeys].sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) fail();
    return Object.fromEntries(keys.map((key) => [key, properties[key].value]));
}

function boundedArray(value, exactLength, maximumLength = exactLength) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length < exactLength || value.length > maximumLength) fail();
    const properties = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(properties);
    if (ownKeys.length !== value.length + 1 || ownKeys[value.length] !== "length") fail();
    const values = [];
    for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        if (ownKeys[index] !== key) fail();
        const descriptor = properties[key];
        if (!descriptor || !("value" in descriptor) || typeof descriptor.get === "function"
            || typeof descriptor.set === "function") fail();
        values.push(descriptor.value);
    }
    return values;
}

function timestamp(value) {
    if (typeof value !== "string" || !ISO_TIMESTAMP.test(value)) fail();
    const milliseconds = Date.parse(value);
    if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) fail();
    return milliseconds;
}

function identifier(value) {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) fail();
    return value;
}

function unique(values) {
    return new Set(values).size === values.length;
}

function exactAllowlist(actual, expected) {
    return actual.length === expected.length
        && unique(actual)
        && [...actual].sort().every((value, index) => value === [...expected].sort()[index]);
}

function validateArtifact(raw, manifestBuildSha, manifestEnvironmentDigest) {
    const artifact = exactRecord(raw, [
        "id", "kind", "evidenceClass", "path", "sha256", "generatedAt", "freshUntil", "buildSha",
        "environmentDigest", "status",
    ]);
    const id = identifier(artifact.id);
    const kind = identifier(artifact.kind);
    const catalog = RELEASE_ARTIFACT_CATALOG[kind];
    if (!catalog || id !== catalog.id || artifact.evidenceClass !== catalog.evidenceClass) {
        fail("invalid_scoring_catalog");
    }
    if (typeof artifact.path !== "string" || artifact.path.length < 2 || artifact.path.length > 4096
        || artifact.path.includes("\0") || !isAbsolute(artifact.path)) fail();
    if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) fail();
    if (typeof artifact.buildSha !== "string" || !BUILD_SHA.test(artifact.buildSha)) fail();
    if (typeof artifact.environmentDigest !== "string" || !SHA256.test(artifact.environmentDigest)) fail();
    if (!ARTIFACT_STATUSES.has(artifact.status)) fail();
    const generatedAtMs = timestamp(artifact.generatedAt);
    const freshUntilMs = timestamp(artifact.freshUntil);
    return Object.freeze({
        ...artifact,
        id,
        kind,
        catalog,
        manifestBuildMatches: artifact.buildSha === manifestBuildSha,
        manifestEnvironmentMatches: artifact.environmentDigest === manifestEnvironmentDigest,
        ttlMatches: freshUntilMs - generatedAtMs === catalog.maxAgeMs,
        generatedAtMs,
        freshUntilMs,
    });
}

function validateCheck(raw, expected, expectedArtifactId, checkIds) {
    const check = exactRecord(raw, ["id", "weightTenths", "artifactId"]);
    const id = identifier(check.id);
    if (checkIds.has(id)) fail("duplicate_id");
    checkIds.add(id);
    if (!Number.isSafeInteger(check.weightTenths) || check.weightTenths < 1 || check.weightTenths > 100) fail();
    if (id !== expected.id || check.weightTenths !== expected.weightTenths
        || check.artifactId !== expectedArtifactId) fail("invalid_scoring_catalog");
    return Object.freeze({
        id,
        weightTenths: check.weightTenths,
        artifactId: identifier(check.artifactId),
    });
}

export function validateReleaseManifest(input) {
    const manifest = exactRecord(input, [
        "schemaVersion", "buildSha", "environmentDigest", "generatedAt", "artifacts", "dimensions", "hardGates",
    ]);
    if (manifest.schemaVersion !== RELEASE_QUALITY_SCHEMA_VERSION) fail("unsupported_schema");
    if (typeof manifest.buildSha !== "string" || !BUILD_SHA.test(manifest.buildSha)) fail();
    if (typeof manifest.environmentDigest !== "string" || !SHA256.test(manifest.environmentDigest)) fail();
    const generatedAtMs = timestamp(manifest.generatedAt);

    const artifacts = boundedArray(manifest.artifacts, RELEASE_DIMENSIONS.length)
        .map((artifact) => validateArtifact(artifact, manifest.buildSha, manifest.environmentDigest));
    if (!unique(artifacts.map((artifact) => artifact.id))) fail("duplicate_id");
    if (!exactAllowlist(artifacts.map((artifact) => artifact.kind), RELEASE_DIMENSIONS)) {
        fail("invalid_scoring_catalog");
    }

    const checkIds = new Set();
    const dimensions = boundedArray(manifest.dimensions, RELEASE_DIMENSIONS.length)
        .map((raw) => {
            const dimension = exactRecord(raw, ["id", "checks"]);
            const id = identifier(dimension.id);
            const expectedChecks = RELEASE_ATOMIC_CHECKS[id];
            const expectedArtifact = RELEASE_ARTIFACT_CATALOG[id];
            if (!expectedChecks || !expectedArtifact) fail("invalid_scoring_catalog");
            const checks = boundedArray(dimension.checks, expectedChecks.length)
                .map((check, index) => validateCheck(check, expectedChecks[index], expectedArtifact.id, checkIds));
            if (checks.reduce((sum, check) => sum + check.weightTenths, 0) !== 100) fail("invalid_weights");
            return Object.freeze({ id, checks: Object.freeze(checks) });
        });
    if (!exactAllowlist(dimensions.map((dimension) => dimension.id), RELEASE_DIMENSIONS)) fail();

    const hardGates = boundedArray(manifest.hardGates, RELEASE_HARD_GATES.length)
        .map((raw) => {
            const gate = exactRecord(raw, ["id", "artifactId"]);
            const expectedKind = HARD_GATE_ARTIFACT_KIND[gate.id];
            const expectedArtifact = RELEASE_ARTIFACT_CATALOG[expectedKind];
            if (!expectedArtifact || gate.artifactId !== expectedArtifact.id) fail("invalid_scoring_catalog");
            return Object.freeze({
                id: identifier(gate.id),
                artifactId: identifier(gate.artifactId),
            });
        });
    if (!exactAllowlist(hardGates.map((gate) => gate.id), RELEASE_HARD_GATES)) fail();

    return Object.freeze({
        schemaVersion: manifest.schemaVersion,
        buildSha: manifest.buildSha,
        environmentDigest: manifest.environmentDigest,
        generatedAt: manifest.generatedAt,
        generatedAtMs,
        artifacts: Object.freeze(artifacts),
        dimensions: Object.freeze(dimensions),
        hardGates: Object.freeze(hardGates),
    });
}

async function readBoundedArtifact(path) {
    const pathStats = await lstat(path);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1
        || pathStats.size < 1 || pathStats.size > MAX_ARTIFACT_BYTES) {
        throw new Error("artifact unreadable");
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== pathStats.dev || before.ino !== pathStats.ino
            || before.size !== pathStats.size) throw new Error("artifact unreadable");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs || bytes.byteLength !== after.size) {
            throw new Error("artifact changed");
        }
        return bytes;
    } finally {
        await handle.close();
    }
}

function safeNow(now) {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) fail("invalid_clock");
    return value;
}

async function validateArtifactEvidence(artifact, manifest, nowMs, readArtifact) {
    let bytes;
    try {
        bytes = await readArtifact(artifact.path);
    } catch {
        return { failure: "artifact_unreadable", evidence: null };
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
        return { failure: "artifact_unreadable", evidence: null };
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) return { failure: "artifact_hash_mismatch", evidence: null };
    let evidence;
    try {
        const raw = parseStrictJson(UTF8_DECODER.decode(bytes));
        const record = exactRecord(raw, [
            "schemaVersion", "kind", "buildSha", "environmentDigest", "generatedAt", "status", "checks", "hardGates",
        ]);
        if (record.schemaVersion !== RELEASE_QUALITY_SCHEMA_VERSION || record.kind !== artifact.kind
            || record.buildSha !== artifact.buildSha || record.environmentDigest !== artifact.environmentDigest
            || record.generatedAt !== artifact.generatedAt || record.status !== artifact.status) fail();
        const expectedChecks = RELEASE_ATOMIC_CHECKS[artifact.kind];
        const checks = boundedArray(record.checks, expectedChecks.length).map((rawCheck, index) => {
            const check = exactRecord(rawCheck, ["id", "status"]);
            if (check.id !== expectedChecks[index].id || !EVIDENCE_STATUSES.has(check.status)) fail();
            return Object.freeze({ id: check.id, status: check.status });
        });
        const expectedHardGates = artifact.catalog.hardGates;
        const hardGates = boundedArray(record.hardGates, expectedHardGates.length).map((rawGate, index) => {
            const gate = exactRecord(rawGate, ["id", "status"]);
            if (gate.id !== expectedHardGates[index] || !EVIDENCE_STATUSES.has(gate.status)) fail();
            return Object.freeze({ id: gate.id, status: gate.status });
        });
        evidence = Object.freeze({
            checks: new Map(checks.map((check) => [check.id, check.status])),
            hardGates: new Map(hardGates.map((gate) => [gate.id, gate.status])),
        });
    } catch {
        return { failure: "artifact_schema_invalid", evidence: null };
    }
    let failure = null;
    if (artifact.status !== "verified") failure = "artifact_unverified";
    else if (!artifact.manifestBuildMatches || artifact.buildSha !== manifest.buildSha) failure = "artifact_wrong_build";
    else if (!artifact.manifestEnvironmentMatches) failure = "artifact_wrong_environment";
    else if (!artifact.ttlMatches) failure = "artifact_ttl_exceeded";
    else if (artifact.generatedAtMs > manifest.generatedAtMs) failure = "artifact_after_manifest";
    else if (artifact.generatedAtMs > nowMs) failure = "artifact_from_future";
    else if (artifact.freshUntilMs < nowMs) failure = "artifact_expired";
    return { failure, evidence };
}

export async function scoreReleaseEvidence(input, overrides = {}) {
    const manifest = validateReleaseManifest(input);
    const now = safeNow(overrides.now ?? (() => new Date()));
    if (manifest.generatedAtMs > now.getTime()) fail("invalid_clock");
    const scorerSha = overrides.scorerSha;
    if (typeof scorerSha !== "string" || !BUILD_SHA.test(scorerSha)) fail("invalid_scorer_sha");
    const readArtifact = overrides.readArtifact ?? readBoundedArtifact;
    if (typeof readArtifact !== "function") fail();

    const artifactStates = new Map();
    const evidenceFailures = [];
    for (const artifact of manifest.artifacts) {
        const { failure, evidence } = await validateArtifactEvidence(artifact, manifest, now.getTime(), readArtifact);
        artifactStates.set(artifact.id, Object.freeze({ valid: failure === null, evidence }));
        if (failure) evidenceFailures.push(Object.freeze({ artifactId: artifact.id, code: failure }));
    }
    const missingArtifactIds = new Set();
    const artifactValid = (artifactId) => {
        if (artifactStates.has(artifactId)) return artifactStates.get(artifactId).valid === true;
        if (!missingArtifactIds.has(artifactId)) {
            missingArtifactIds.add(artifactId);
            evidenceFailures.push(Object.freeze({ artifactId, code: "missing_artifact" }));
        }
        return false;
    };

    const dimensionScores = {};
    const dimensionTenths = {};
    const atomicStatuses = new Map();
    for (const dimension of manifest.dimensions) {
        let tenths = 0;
        for (const check of dimension.checks) {
            const status = artifactValid(check.artifactId)
                ? artifactStates.get(check.artifactId).evidence?.checks.get(check.id)
                : undefined;
            atomicStatuses.set(check.id, status);
            if (status === "passed") tenths += check.weightTenths;
        }
        dimensionTenths[dimension.id] = tenths;
        dimensionScores[dimension.id] = tenths / 10;
    }
    const tenths = RELEASE_DIMENSIONS.map((dimension) => dimensionTenths[dimension]);
    const totalTenths = tenths.reduce((sum, score) => sum + score, 0);
    const mean = Math.round((totalTenths / (RELEASE_DIMENSIONS.length * 10)) * 100) / 100;
    const minimumTenths = Math.min(...tenths);
    const minimum = minimumTenths / 10;
    const hardGateFailures = manifest.hardGates
        .filter((gate) => !artifactValid(gate.artifactId)
            || artifactStates.get(gate.artifactId).evidence?.hardGates.get(gate.id) !== "passed"
            || RELEASE_HARD_GATE_PREDICATES[gate.id]
                .some((checkId) => atomicStatuses.get(checkId) !== "passed"))
        .map((gate) => gate.id);
    if ([...atomicStatuses.values()].some((status) => status === "skipped")
        && !hardGateFailures.includes("unexplained_skips")) {
        hardGateFailures.push("unexplained_skips");
    }
    const status = totalTenths >= 930
        && minimumTenths >= 87
        && hardGateFailures.length === 0
        && evidenceFailures.length === 0
        ? "go"
        : "no_go";

    return Object.freeze({
        schemaVersion: RELEASE_QUALITY_SCHEMA_VERSION,
        status,
        buildSha: manifest.buildSha,
        environmentDigest: manifest.environmentDigest,
        scorerSha,
        scoredAt: now.toISOString(),
        mean,
        minimum,
        dimensions: Object.freeze(dimensionScores),
        hardGateFailures: Object.freeze(hardGateFailures),
        evidenceFailures: Object.freeze(evidenceFailures),
    });
}
