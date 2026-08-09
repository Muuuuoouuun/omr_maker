import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";

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

export const RELEASE_QUALITY_SCHEMA_VERSION = 1;

const BUILD_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IDENTIFIER = /^[a-z][a-z0-9_-]{0,63}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EVIDENCE_STATUSES = new Set(["passed", "failed", "skipped", "unverified"]);
const ARTIFACT_STATUSES = new Set(["verified", "unverified"]);
const MAX_ARTIFACTS = 256;
const MAX_CHECKS_PER_DIMENSION = 64;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

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

function validateArtifact(raw, manifestBuildSha) {
    const artifact = exactRecord(raw, [
        "id", "path", "sha256", "generatedAt", "freshUntil", "buildSha", "status",
    ]);
    const id = identifier(artifact.id);
    if (typeof artifact.path !== "string" || artifact.path.length < 2 || artifact.path.length > 4096
        || artifact.path.includes("\0") || !isAbsolute(artifact.path)) fail();
    if (typeof artifact.sha256 !== "string" || !SHA256.test(artifact.sha256)) fail();
    if (typeof artifact.buildSha !== "string" || !BUILD_SHA.test(artifact.buildSha)) fail();
    if (!ARTIFACT_STATUSES.has(artifact.status)) fail();
    const generatedAtMs = timestamp(artifact.generatedAt);
    const freshUntilMs = timestamp(artifact.freshUntil);
    if (freshUntilMs < generatedAtMs) fail();
    return Object.freeze({
        ...artifact,
        id,
        manifestBuildMatches: artifact.buildSha === manifestBuildSha,
        generatedAtMs,
        freshUntilMs,
    });
}

function validateCheck(raw, checkIds) {
    const check = exactRecord(raw, ["id", "weightTenths", "status", "artifactId"]);
    const id = identifier(check.id);
    if (checkIds.has(id)) fail("duplicate_id");
    checkIds.add(id);
    if (!Number.isSafeInteger(check.weightTenths) || check.weightTenths < 1 || check.weightTenths > 100) fail();
    if (!EVIDENCE_STATUSES.has(check.status)) fail();
    return Object.freeze({
        id,
        weightTenths: check.weightTenths,
        status: check.status,
        artifactId: identifier(check.artifactId),
    });
}

export function validateReleaseManifest(input) {
    const manifest = exactRecord(input, [
        "schemaVersion", "buildSha", "generatedAt", "artifacts", "dimensions", "hardGates",
    ]);
    if (manifest.schemaVersion !== RELEASE_QUALITY_SCHEMA_VERSION) fail("unsupported_schema");
    if (typeof manifest.buildSha !== "string" || !BUILD_SHA.test(manifest.buildSha)) fail();
    const generatedAtMs = timestamp(manifest.generatedAt);

    const artifacts = boundedArray(manifest.artifacts, 1, MAX_ARTIFACTS)
        .map((artifact) => validateArtifact(artifact, manifest.buildSha));
    if (!unique(artifacts.map((artifact) => artifact.id))) fail("duplicate_id");

    const checkIds = new Set();
    const dimensions = boundedArray(manifest.dimensions, RELEASE_DIMENSIONS.length)
        .map((raw) => {
            const dimension = exactRecord(raw, ["id", "checks"]);
            const id = identifier(dimension.id);
            const checks = boundedArray(dimension.checks, 1, MAX_CHECKS_PER_DIMENSION)
                .map((check) => validateCheck(check, checkIds));
            if (checks.reduce((sum, check) => sum + check.weightTenths, 0) !== 100) fail("invalid_weights");
            return Object.freeze({ id, checks: Object.freeze(checks) });
        });
    if (!exactAllowlist(dimensions.map((dimension) => dimension.id), RELEASE_DIMENSIONS)) fail();

    const hardGates = boundedArray(manifest.hardGates, RELEASE_HARD_GATES.length)
        .map((raw) => {
            const gate = exactRecord(raw, ["id", "status", "artifactId"]);
            if (!EVIDENCE_STATUSES.has(gate.status)) fail();
            return Object.freeze({
                id: identifier(gate.id),
                status: gate.status,
                artifactId: identifier(gate.artifactId),
            });
        });
    if (!exactAllowlist(hardGates.map((gate) => gate.id), RELEASE_HARD_GATES)) fail();

    return Object.freeze({
        schemaVersion: manifest.schemaVersion,
        buildSha: manifest.buildSha,
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
    if (artifact.status !== "verified") return "artifact_unverified";
    if (!artifact.manifestBuildMatches) return "artifact_wrong_build";
    if (artifact.generatedAtMs > manifest.generatedAtMs) return "artifact_after_manifest";
    if (artifact.generatedAtMs > nowMs) return "artifact_from_future";
    if (artifact.freshUntilMs < nowMs) return "artifact_expired";
    let bytes;
    try {
        bytes = await readArtifact(artifact.path);
    } catch {
        return "artifact_unreadable";
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_ARTIFACT_BYTES) {
        return "artifact_unreadable";
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== artifact.sha256) return "artifact_hash_mismatch";
    if (artifact.buildSha !== manifest.buildSha) return "artifact_wrong_build";
    return null;
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
        const failure = await validateArtifactEvidence(artifact, manifest, now.getTime(), readArtifact);
        artifactStates.set(artifact.id, failure === null);
        if (failure) evidenceFailures.push(Object.freeze({ artifactId: artifact.id, code: failure }));
    }
    const missingArtifactIds = new Set();
    const artifactValid = (artifactId) => {
        if (artifactStates.has(artifactId)) return artifactStates.get(artifactId) === true;
        if (!missingArtifactIds.has(artifactId)) {
            missingArtifactIds.add(artifactId);
            evidenceFailures.push(Object.freeze({ artifactId, code: "missing_artifact" }));
        }
        return false;
    };

    const dimensionScores = {};
    for (const dimension of manifest.dimensions) {
        const tenths = dimension.checks.reduce((score, check) => score + (
            check.status === "passed" && artifactValid(check.artifactId) ? check.weightTenths : 0
        ), 0);
        dimensionScores[dimension.id] = tenths / 10;
    }
    const scores = RELEASE_DIMENSIONS.map((dimension) => dimensionScores[dimension]);
    const mean = Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10) / 10;
    const minimum = Math.min(...scores);
    const hardGateFailures = manifest.hardGates
        .filter((gate) => gate.status !== "passed" || !artifactValid(gate.artifactId))
        .map((gate) => gate.id);
    if (manifest.dimensions.some((dimension) => dimension.checks.some((check) => check.status === "skipped"))
        && !hardGateFailures.includes("unexplained_skips")) {
        hardGateFailures.push("unexplained_skips");
    }
    const status = mean >= 9.3
        && minimum >= 8.7
        && hardGateFailures.length === 0
        && evidenceFailures.length === 0
        ? "go"
        : "no_go";

    return Object.freeze({
        schemaVersion: RELEASE_QUALITY_SCHEMA_VERSION,
        status,
        buildSha: manifest.buildSha,
        scorerSha,
        scoredAt: now.toISOString(),
        mean,
        minimum,
        dimensions: Object.freeze(dimensionScores),
        hardGateFailures: Object.freeze(hardGateFailures),
        evidenceFailures: Object.freeze(evidenceFailures),
    });
}
