import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
    link,
    lstat,
    open,
    readdir,
    realpath,
    unlink,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
    RELEASE_ARTIFACT_CATALOG,
    RELEASE_ATOMIC_CHECKS,
    RELEASE_DIMENSIONS,
    validateReleaseManifest,
} from "./release-quality-core.mjs";
import {
    QUALIFICATION_SOURCE_CATALOG,
    buildInitialOperationsQualification,
} from "./build-initial-operations-qualification.mjs";
import { runReleaseScoreCli, validatePublishedReleaseScore } from "./score-release-quality.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const execFileAsync = promisify(execFile);
const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HMAC_SHA256 = /^[a-f0-9]{64}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9._:-]{3,200}$/;
const OPERATOR_ID = /^[A-Za-z0-9._-]{3,64}$/;
const READINESS_VERSION = /^\d{12}$/;
const VERCEL_RESOURCE_ID = /^[A-Za-z0-9_]{3,200}$/;
const HOST_SUFFIX = /^\.[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])?$/;
const MAX_JSON_BYTES = 128 * 1024;
const INPUT_KEYS = Object.freeze([
    "allowedPreviewHostSuffix",
    "expectedBuildSha",
    "expectedDatabaseProjectRefHash",
    "expectedEnvironmentDigest",
    "finalReleaseRoot",
    "manifestPath",
    "manifestSha256",
    "operatorConfirmation",
    "operatorId",
    "previewArtifactDigest",
    "previewAttestationSignature",
    "previewDeploymentId",
    "previousDeploymentId",
    "productionHost",
    "qualificationArtifactDigest",
    "qualifiedPreviewHost",
    "qualifiedPreviewUrl",
    "readinessVersion",
    "rollbackOutputPath",
    "scorePath",
    "verifierOutputPath",
    "writesPauseConfirmation",
]);
const QUALIFICATION_IDENTITY_KEYS = Object.freeze([
    "buildSha",
    "environmentDigest",
    "productionHostDigest",
    "productionProjectDigest",
    "qualificationPhase",
    "qualifiedPreviewArtifactDigest",
    "qualifiedPreviewDeploymentId",
    "qualifiedPreviewHostDigest",
    "restoreProjectDigest",
    "schemaVersion",
    "stagingHostDigest",
    "stagingProjectDigest",
    "status",
]);
const QUALIFICATION_MARKER_KEYS = Object.freeze([
    "buildSha",
    "environmentDigest",
    "qualifiedAt",
    "qualificationPhase",
    "schemaVersion",
    "scoreSha256",
    "status",
]);
const BUNDLE_INDEX_KEYS = Object.freeze([
    "artifacts",
    "buildSha",
    "environmentDigest",
    "generatedAt",
    "manifestRelativePath",
    "manifestSha256",
    "qualificationPhase",
    "qualifiedPreviewArtifactDigest",
    "qualifiedPreviewDeploymentId",
    "qualifiedPreviewHostDigest",
    "relocationRequired",
    "schemaVersion",
    "sourceAttestations",
    "sourceProvenanceRelativePath",
    "sourceProvenanceSha256",
    "status",
]);

export class QualifiedPreviewPromotionError extends Error {
    constructor(code) {
        super(code);
        this.name = "QualifiedPreviewPromotionError";
        this.code = code;
    }
}

function fail(code) {
    throw new QualifiedPreviewPromotionError(code);
}

function exactKeys(value, keys) {
    return value !== null
        && typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function safeHostname(value) {
    if (typeof value !== "string" || value.length < 4 || value.length > 253 || value !== value.toLowerCase()) {
        return false;
    }
    if (value === "localhost" || value.endsWith(".localhost") || isIP(value) !== 0 || !value.includes(".")) return false;
    return value.split(".").every((label) => (
        label.length >= 1
        && label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ));
}

function exactHttpsOrigin(value) {
    if (typeof value !== "string" || value.length < 12 || value.length > 2048) return null;
    try {
        const url = new URL(value);
        if (
            url.protocol !== "https:"
            || url.username
            || url.password
            || url.port
            || url.pathname !== "/"
            || url.search
            || url.hash
            || url.origin !== value
        ) return null;
        return url;
    } catch {
        return null;
    }
}

function safeAbsolutePath(value) {
    return typeof value === "string"
        && value.length >= 2
        && value.length <= 4096
        && !value.includes("\0")
        && isAbsolute(value)
        && resolve(value) === value;
}

export function validatePromotionInput(input) {
    if (!exactKeys(input, INPUT_KEYS)) return { ok: false, error: "invalid_input" };
    if (
        !GIT_SHA.test(input.expectedBuildSha)
        || !SHA256.test(input.expectedEnvironmentDigest)
        || !SHA256.test(input.manifestSha256)
        || !SHA256.test(input.expectedDatabaseProjectRefHash)
        || !DIGEST.test(input.previewArtifactDigest)
        || !HMAC_SHA256.test(input.previewAttestationSignature)
        || !SHA256.test(input.qualificationArtifactDigest)
        || !DEPLOYMENT_ID.test(input.previewDeploymentId)
        || !DEPLOYMENT_ID.test(input.previousDeploymentId)
        || !OPERATOR_ID.test(input.operatorId)
        || !READINESS_VERSION.test(input.readinessVersion)
        || !safeAbsolutePath(input.scorePath)
        || !safeAbsolutePath(input.manifestPath)
        || !safeAbsolutePath(input.finalReleaseRoot)
        || !safeAbsolutePath(input.verifierOutputPath)
        || !safeAbsolutePath(input.rollbackOutputPath)
        || new Set([
            input.scorePath,
            input.manifestPath,
            input.finalReleaseRoot,
            input.verifierOutputPath,
            input.rollbackOutputPath,
        ]).size !== 5
    ) return { ok: false, error: "invalid_input" };

    const preview = exactHttpsOrigin(input.qualifiedPreviewUrl);
    if (
        !preview
        || !safeHostname(input.qualifiedPreviewHost)
        || !safeHostname(input.productionHost)
        || !HOST_SUFFIX.test(input.allowedPreviewHostSuffix)
        || input.allowedPreviewHostSuffix === ".localhost"
        || preview.hostname !== input.qualifiedPreviewHost
        || input.qualifiedPreviewHost === input.productionHost
        || !input.qualifiedPreviewHost.endsWith(input.allowedPreviewHostSuffix)
        || input.qualifiedPreviewHost.length <= input.allowedPreviewHostSuffix.length
    ) return { ok: false, error: "invalid_host" };

    const expectedConfirmation = `promote-qualified-preview:${input.productionHost}:${input.expectedBuildSha}:${input.operatorId}`;
    if (input.operatorConfirmation !== expectedConfirmation) {
        return { ok: false, error: "operator_confirmation_mismatch" };
    }
    if (input.writesPauseConfirmation !== `writes-paused:${input.productionHost}`) {
        return { ok: false, error: "writes_not_paused" };
    }
    return { ok: true };
}

export function buildPromotionCommand(input) {
    const validation = validatePromotionInput(input);
    if (!validation.ok) fail(validation.error);
    return Object.freeze(["vercel", "promote", input.qualifiedPreviewUrl, "--yes"]);
}

export function buildPromotionProcessEnvironment(env) {
    if (
        !env || typeof env !== "object" || Array.isArray(env)
        || typeof env.PATH !== "string" || env.PATH.length < 1 || env.PATH.length > 8192
        || !VERCEL_RESOURCE_ID.test(env.VERCEL_ORG_ID ?? "")
        || !VERCEL_RESOURCE_ID.test(env.VERCEL_PROJECT_ID ?? "")
        || !boundedSecret(env.VERCEL_TOKEN)
    ) fail("preview_lineage_unverified");
    return Object.freeze({
        CI: "1",
        PATH: env.PATH,
        VERCEL_ORG_ID: env.VERCEL_ORG_ID,
        VERCEL_PROJECT_ID: env.VERCEL_PROJECT_ID,
        VERCEL_TOKEN: env.VERCEL_TOKEN,
    });
}

function boundedSecret(value) {
    return typeof value === "string"
        && Buffer.byteLength(value, "utf8") >= 20
        && Buffer.byteLength(value, "utf8") <= 512
        && !/[\s\0]/.test(value);
}

export async function verifyQualifiedPreviewLineage(input, overrides = {}) {
    const validation = validatePromotionInput(input);
    if (!validation.ok) fail(validation.error);
    const env = overrides.env ?? process.env;
    const fetchImpl = overrides.fetchImpl ?? fetch;
    const ownerId = env.VERCEL_ORG_ID;
    const projectId = env.VERCEL_PROJECT_ID;
    const token = env.VERCEL_TOKEN;
    const attestationSecret = env.OMR_RELEASE_ATTESTATION_SECRET;
    if (!VERCEL_RESOURCE_ID.test(ownerId ?? "") || !VERCEL_RESOURCE_ID.test(projectId ?? "")
        || !boundedSecret(token) || !boundedSecret(attestationSecret)) {
        fail("preview_lineage_unverified");
    }
    const attestationPayload = `omr-preview-identity:v1\n${input.expectedBuildSha}\n${input.previewDeploymentId}\n${input.previewArtifactDigest}`;
    const expectedAttestation = createHmac("sha256", attestationSecret).update(attestationPayload, "utf8").digest();
    const suppliedAttestation = Buffer.from(input.previewAttestationSignature, "hex");
    if (suppliedAttestation.byteLength !== expectedAttestation.byteLength
        || !timingSafeEqual(suppliedAttestation, expectedAttestation)) fail("preview_lineage_unverified");
    const getDeployment = async (host) => {
        const endpoint = new URL(`/v13/deployments/${encodeURIComponent(host)}`, "https://api.vercel.com");
        endpoint.searchParams.set("teamId", ownerId);
        let response;
        try {
            response = await fetchImpl(endpoint.href, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${token}`,
                    "user-agent": "omr-qualified-preview-promotion/1",
                },
                redirect: "error",
                signal: AbortSignal.timeout(12_000),
            });
        } catch {
            fail("preview_lineage_unverified");
        }
        const contentType = response?.headers?.get("content-type")?.toLowerCase() ?? "";
        const declaredLength = response?.headers?.get("content-length");
        if (
            response?.status !== 200
            || !contentType.startsWith("application/json")
            || (declaredLength !== null && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_JSON_BYTES))
        ) fail("preview_lineage_unverified");
        try {
            const bytes = Buffer.from(await response.arrayBuffer());
            if (bytes.byteLength < 2 || bytes.byteLength > MAX_JSON_BYTES) fail("preview_lineage_unverified");
            return parseStrictJson(bytes.toString("utf8"));
        } catch (error) {
            if (error instanceof QualifiedPreviewPromotionError) throw error;
            fail("preview_lineage_unverified");
        }
    };
    const deployment = await getDeployment(input.qualifiedPreviewHost);
    if (
        deployment?.id !== input.previewDeploymentId
        || deployment.url !== input.qualifiedPreviewHost
        || deployment.ownerId !== ownerId
        || deployment.projectId !== projectId
        || deployment.readyState !== "READY"
        || deployment.target !== null
        || deployment.meta?.githubCommitSha !== input.expectedBuildSha
    ) fail("preview_lineage_unverified");
    const currentProduction = await getDeployment(input.productionHost);
    if (
        currentProduction?.id !== input.previousDeploymentId
        || currentProduction.ownerId !== ownerId
        || currentProduction.projectId !== projectId
        || currentProduction.readyState !== "READY"
        || currentProduction.target !== "production"
    ) fail("preview_lineage_unverified");
    return Object.freeze({ status: "verified" });
}

async function readSecureBytes(path, errorCode) {
    let handle;
    try {
        const before = await lstat(path);
        if (
            !before.isFile()
            || before.isSymbolicLink()
            || before.nlink !== 1
            || (before.mode & 0o777) !== 0o600
            || before.size < 2
            || before.size > MAX_JSON_BYTES
        ) fail(errorCode);
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
            fail(errorCode);
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (
            after.dev !== opened.dev
            || after.ino !== opened.ino
            || after.size !== opened.size
            || after.mtimeMs !== opened.mtimeMs
            || bytes.byteLength !== after.size
        ) fail(errorCode);
        return bytes;
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        fail(errorCode);
    } finally {
        if (handle) {
            try { await handle.close(); } catch { /* fail closed on the read path above */ }
        }
    }
}

async function readSecureJson(path, errorCode = "post_promotion_verification_failed") {
    try {
        return parseStrictJson((await readSecureBytes(path, errorCode)).toString("utf8"));
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        fail(errorCode);
    }
}

async function assertPrivateDirectory(path, errorCode) {
    try {
        const stats = await lstat(path);
        const canonical = await realpath(path);
        const ownerMatches = typeof process.getuid !== "function" || stats.uid === process.getuid();
        if (
            canonical !== path
            || !stats.isDirectory()
            || stats.isSymbolicLink()
            || (stats.mode & 0o777) !== 0o700
            || !ownerMatches
        ) fail(errorCode);
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        fail(errorCode);
    }
}

function canonicalIso(value) {
    if (typeof value !== "string") return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function safeArtifactEntry(entry, index, manifestArtifact) {
    const kind = RELEASE_DIMENSIONS[index];
    const relativePath = `evidence-${kind}.json`;
    return exactKeys(entry, ["id", "kind", "relativePath", "sha256"])
        && entry.id === manifestArtifact.id
        && entry.kind === kind
        && entry.relativePath === relativePath
        && SHA256.test(entry.sha256)
        && entry.sha256 === manifestArtifact.sha256;
}

async function writePrivateJsonExclusive(outputPath, value, errorCode) {
    const parent = dirname(outputPath);
    await assertPrivateDirectory(parent, errorCode);
    try {
        await lstat(outputPath);
        fail(errorCode);
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        if (error?.code !== "ENOENT") fail(errorCode);
    }
    const temporaryPath = `${parent}${sep}.${randomUUID()}.json.tmp`;
    let temporaryPresent = false;
    try {
        const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        temporaryPresent = true;
        try {
            await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await link(temporaryPath, outputPath);
        await unlink(temporaryPath);
        temporaryPresent = false;
        const published = await lstat(outputPath);
        if (!published.isFile() || published.nlink !== 1 || (published.mode & 0o777) !== 0o600) fail(errorCode);
        const directoryHandle = await open(parent, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
        if (temporaryPresent) {
            try { await unlink(temporaryPath); } catch { /* best effort only */ }
        }
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        fail(errorCode);
    }
}

export async function prepareQualificationBundle(input) {
    const keys = [
        "expectedBuildSha",
        "expectedDatabaseProjectRefHash",
        "expectedEnvironmentDigest",
        "expectedProductionHost",
        "expectedQualifiedPreviewArtifactDigest",
        "expectedQualifiedPreviewDeploymentId",
        "expectedQualifiedPreviewHost",
        "outputPath",
        "qualificationRoot",
    ];
    if (
        !exactKeys(input, keys)
        || !GIT_SHA.test(input.expectedBuildSha)
        || !SHA256.test(input.expectedDatabaseProjectRefHash)
        || !SHA256.test(input.expectedEnvironmentDigest)
        || !safeHostname(input.expectedProductionHost)
        || !DIGEST.test(input.expectedQualifiedPreviewArtifactDigest)
        || !DEPLOYMENT_ID.test(input.expectedQualifiedPreviewDeploymentId)
        || !safeHostname(input.expectedQualifiedPreviewHost)
        || !safeAbsolutePath(input.qualificationRoot)
        || !safeAbsolutePath(input.outputPath)
    ) fail("qualification_bundle_invalid");
    await assertPrivateDirectory(input.qualificationRoot, "qualification_bundle_invalid");
    const releaseRoot = resolve(input.qualificationRoot, "release");
    await assertPrivateDirectory(releaseRoot, "qualification_bundle_invalid");
    if (dirname(input.outputPath) !== releaseRoot) fail("qualification_bundle_invalid");
    try {
        await lstat(resolve(input.qualificationRoot, ".INCOMPLETE"));
        fail("qualification_bundle_invalid");
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        if (error?.code !== "ENOENT") fail("qualification_bundle_invalid");
    }

    const identity = await readSecureJson(
        resolve(input.qualificationRoot, "qualification-identity.json"),
        "qualification_bundle_invalid",
    );
    const marker = await readSecureJson(
        resolve(input.qualificationRoot, "QUALIFICATION_COMPLETE"),
        "qualification_bundle_invalid",
    );
    const index = await readSecureJson(resolve(releaseRoot, "bundle-index.json"), "qualification_bundle_invalid");
    if (
        !exactKeys(identity, QUALIFICATION_IDENTITY_KEYS)
        || identity.schemaVersion !== 1
        || identity.status !== "verified"
        || identity.qualificationPhase !== "pre_promotion"
        || identity.buildSha !== input.expectedBuildSha
        || identity.environmentDigest !== input.expectedEnvironmentDigest
        || identity.qualifiedPreviewHostDigest !== createHash("sha256")
            .update(
                `omr.initial-operations.qualified-preview-host:v1\n${input.expectedQualifiedPreviewHost}`,
                "utf8",
            )
            .digest("hex")
        || identity.qualifiedPreviewDeploymentId !== input.expectedQualifiedPreviewDeploymentId
        || identity.qualifiedPreviewArtifactDigest !== input.expectedQualifiedPreviewArtifactDigest.slice("sha256:".length)
        || !SHA256.test(identity.stagingHostDigest)
        || !SHA256.test(identity.stagingProjectDigest)
        || identity.productionHostDigest !== createHash("sha256")
            .update(`omr.initial-operations.production-host:v1\n${input.expectedProductionHost}`, "utf8")
            .digest("hex")
        || identity.productionProjectDigest !== createHash("sha256")
            .update(
                `omr.initial-operations.production-project-hash:v1\n${input.expectedDatabaseProjectRefHash}`,
                "utf8",
            )
            .digest("hex")
        || !SHA256.test(identity.restoreProjectDigest)
        || !exactKeys(marker, QUALIFICATION_MARKER_KEYS)
        || marker.schemaVersion !== 1
        || marker.status !== "qualified"
        || marker.qualificationPhase !== "pre_promotion"
        || marker.buildSha !== input.expectedBuildSha
        || marker.environmentDigest !== input.expectedEnvironmentDigest
        || !SHA256.test(marker.scoreSha256)
        || !canonicalIso(marker.qualifiedAt)
        || !exactKeys(index, BUNDLE_INDEX_KEYS)
        || index.schemaVersion !== 1
        || index.status !== "verified"
        || index.qualificationPhase !== "pre_promotion"
        || index.buildSha !== input.expectedBuildSha
        || index.environmentDigest !== input.expectedEnvironmentDigest
        || index.qualifiedPreviewHostDigest !== identity.qualifiedPreviewHostDigest
        || index.qualifiedPreviewDeploymentId !== input.expectedQualifiedPreviewDeploymentId
        || index.qualifiedPreviewArtifactDigest !== input.expectedQualifiedPreviewArtifactDigest.slice("sha256:".length)
        || index.manifestRelativePath !== "release-quality-manifest.json"
        || index.sourceProvenanceRelativePath !== "source-provenance.json"
        || index.relocationRequired !== true
        || !SHA256.test(index.manifestSha256)
        || !SHA256.test(index.sourceProvenanceSha256)
        || !canonicalIso(index.generatedAt)
        || !Array.isArray(index.artifacts)
        || index.artifacts.length !== RELEASE_DIMENSIONS.length
        || !Array.isArray(index.sourceAttestations)
        || index.sourceAttestations.length !== QUALIFICATION_SOURCE_CATALOG.length
    ) fail("qualification_bundle_invalid");

    const sourcesRoot = resolve(releaseRoot, "sources");
    await assertPrivateDirectory(sourcesRoot, "qualification_bundle_invalid");
    let sourceEntries;
    try { sourceEntries = (await readdir(sourcesRoot)).sort(); } catch { fail("qualification_bundle_invalid"); }
    const expectedSourceEntries = QUALIFICATION_SOURCE_CATALOG
        .map(({ relativePath }) => relativePath.slice("sources/".length))
        .sort();
    if (sourceEntries.join("\0") !== expectedSourceEntries.join("\0")) fail("qualification_bundle_invalid");
    const sourceDocuments = [];
    for (const source of QUALIFICATION_SOURCE_CATALOG) {
        if (!source.relativePath.startsWith("sources/") || source.relativePath.includes("..")) {
            fail("qualification_bundle_invalid");
        }
        sourceDocuments.push({
            relativePath: source.relativePath,
            bytes: await readSecureBytes(resolve(releaseRoot, source.relativePath), "qualification_bundle_invalid"),
        });
    }
    let replay;
    try {
        replay = buildInitialOperationsQualification({
            buildSha: input.expectedBuildSha,
            environmentDigest: input.expectedEnvironmentDigest,
            generatedAt: index.generatedAt,
            qualifiedPreviewArtifactDigest: input.expectedQualifiedPreviewArtifactDigest.slice("sha256:".length),
            qualifiedPreviewDeploymentId: input.expectedQualifiedPreviewDeploymentId,
            qualifiedPreviewHostDigest: identity.qualifiedPreviewHostDigest,
            releaseDirectory: releaseRoot,
            sourceDocuments,
        });
    } catch {
        fail("qualification_bundle_invalid");
    }
    if (JSON.stringify(index.sourceAttestations) !== JSON.stringify(replay.bundleIndex.sourceAttestations)) {
        fail("qualification_bundle_invalid");
    }
    const sourceProvenanceBytes = await readSecureBytes(
        resolve(releaseRoot, index.sourceProvenanceRelativePath),
        "qualification_bundle_invalid",
    );
    if (
        createHash("sha256").update(sourceProvenanceBytes).digest("hex") !== index.sourceProvenanceSha256
        || !sourceProvenanceBytes.equals(Buffer.from(`${JSON.stringify(replay.provenance)}\n`, "utf8"))
    ) fail("qualification_bundle_invalid");

    const sourceManifestPath = resolve(releaseRoot, index.manifestRelativePath);
    const sourceManifestBytes = await readSecureBytes(sourceManifestPath, "qualification_bundle_invalid");
    if (createHash("sha256").update(sourceManifestBytes).digest("hex") !== index.manifestSha256) {
        fail("qualification_bundle_invalid");
    }
    let sourceManifest;
    try { sourceManifest = parseStrictJson(sourceManifestBytes.toString("utf8")); } catch { fail("qualification_bundle_invalid"); }
    if (
        sourceManifest?.buildSha !== input.expectedBuildSha
        || sourceManifest?.environmentDigest !== input.expectedEnvironmentDigest
        || !Array.isArray(sourceManifest.artifacts)
        || sourceManifest.artifacts.length !== RELEASE_DIMENSIONS.length
    ) fail("qualification_bundle_invalid");

    const reboundArtifacts = [];
    for (const [indexNumber, manifestArtifact] of sourceManifest.artifacts.entries()) {
        const bundleArtifact = index.artifacts[indexNumber];
        if (!safeArtifactEntry(bundleArtifact, indexNumber, manifestArtifact)) fail("qualification_bundle_invalid");
        const artifactPath = resolve(releaseRoot, bundleArtifact.relativePath);
        const artifactBytes = await readSecureBytes(artifactPath, "qualification_bundle_invalid");
        const replayEvidence = Buffer.from(`${JSON.stringify(replay.evidenceByDimension[bundleArtifact.kind])}\n`, "utf8");
        if (
            createHash("sha256").update(artifactBytes).digest("hex") !== bundleArtifact.sha256
            || !artifactBytes.equals(replayEvidence)
        ) {
            fail("qualification_bundle_invalid");
        }
        reboundArtifacts.push({ ...manifestArtifact, path: artifactPath });
    }
    const rebound = { ...sourceManifest, artifacts: reboundArtifacts };
    try { validateReleaseManifest(rebound); } catch { fail("qualification_bundle_invalid"); }
    await writePrivateJsonExclusive(input.outputPath, rebound, "qualification_bundle_invalid");
    const outputBytes = await readSecureBytes(input.outputPath, "qualification_bundle_invalid");
    return Object.freeze({
        status: "prepared",
        buildSha: input.expectedBuildSha,
        environmentDigest: input.expectedEnvironmentDigest,
        manifestSha256: createHash("sha256").update(outputBytes).digest("hex"),
        outputPath: input.outputPath,
    });
}

function serialized(value) {
    return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function exactEvidence(value, dimension, manifest) {
    const catalog = RELEASE_ARTIFACT_CATALOG[dimension];
    const expectedChecks = RELEASE_ATOMIC_CHECKS[dimension];
    if (
        !exactKeys(value, [
            "buildSha", "checks", "environmentDigest", "generatedAt", "hardGates", "kind", "schemaVersion", "status",
        ])
        || value.schemaVersion !== 1
        || value.kind !== dimension
        || value.buildSha !== manifest.buildSha
        || value.environmentDigest !== manifest.environmentDigest
        || value.status !== "verified"
        || value.generatedAt !== manifest.artifacts.find((artifact) => artifact.kind === dimension)?.generatedAt
        || !Array.isArray(value.checks)
        || value.checks.length !== expectedChecks.length
        || !Array.isArray(value.hardGates)
        || value.hardGates.length !== catalog.hardGates.length
    ) fail("final_release_invalid");
    for (const [index, check] of value.checks.entries()) {
        if (!exactKeys(check, ["id", "status"]) || check.id !== expectedChecks[index].id
            || !["passed", "failed", "skipped", "unverified"].includes(check.status)) fail("final_release_invalid");
    }
    for (const [index, gate] of value.hardGates.entries()) {
        if (!exactKeys(gate, ["id", "status"]) || gate.id !== catalog.hardGates[index]
            || !["passed", "failed", "skipped", "unverified"].includes(gate.status)) fail("final_release_invalid");
    }
    return value;
}

export async function finalizePromotionRelease(input, overrides = {}) {
    const keys = [
        "expectedBuildSha", "expectedEnvironmentDigest", "finalReleaseRoot", "generatedAt", "outcome",
        "operatorId", "previousDeploymentId", "productionHostDigest", "productionProjectDigest",
        "qualificationArtifactDigest", "rollbackGuardSha256", "sourceManifestPath", "sourceManifestSha256",
        "targetArtifactDigest", "targetDeploymentId", "verifierEvidence",
    ];
    if (
        !exactKeys(input, keys)
        || !GIT_SHA.test(input.expectedBuildSha)
        || !SHA256.test(input.expectedEnvironmentDigest)
        || !safeAbsolutePath(input.finalReleaseRoot)
        || !safeAbsolutePath(input.sourceManifestPath)
        || !SHA256.test(input.sourceManifestSha256)
        || !SHA256.test(input.qualificationArtifactDigest)
        || !SHA256.test(input.rollbackGuardSha256)
        || !OPERATOR_ID.test(input.operatorId)
        || !DEPLOYMENT_ID.test(input.previousDeploymentId)
        || !SHA256.test(input.productionHostDigest)
        || !SHA256.test(input.productionProjectDigest)
        || !DIGEST.test(input.targetArtifactDigest)
        || !DEPLOYMENT_ID.test(input.targetDeploymentId)
        || !canonicalIso(input.generatedAt)
        || !["verified", "failed"].includes(input.outcome)
        || (input.outcome === "verified" && input.verifierEvidence?.status !== "verified")
        || (input.outcome === "failed" && input.verifierEvidence !== null)
    ) fail("final_release_invalid");
    await assertPrivateDirectory(input.finalReleaseRoot, "final_release_invalid");
    if ((await readdir(input.finalReleaseRoot)).length !== 0) fail("final_release_invalid");
    const sourceBytes = await readSecureBytes(input.sourceManifestPath, "final_release_invalid");
    if (createHash("sha256").update(sourceBytes).digest("hex") !== input.sourceManifestSha256) {
        fail("final_release_invalid");
    }
    let sourceManifest;
    try {
        sourceManifest = parseStrictJson(sourceBytes.toString("utf8"));
        validateReleaseManifest(sourceManifest);
    } catch {
        fail("final_release_invalid");
    }
    if (
        sourceManifest.buildSha !== input.expectedBuildSha
        || sourceManifest.environmentDigest !== input.expectedEnvironmentDigest
    ) fail("final_release_invalid");

    const verifierEvidenceSha256 = createHash("sha256").update(serialized(
        input.verifierEvidence ?? { schemaVersion: 1, status: "unverified" },
    )).digest("hex");
    const operatorIdHash = createHash("sha256")
        .update(`omr.release-operator:v1\0${input.operatorId}`, "utf8")
        .digest("hex");
    const finalEnvironmentDigest = createHash("sha256").update([
        "omr.final-promotion-evidence:v1",
        input.expectedEnvironmentDigest,
        verifierEvidenceSha256,
        input.rollbackGuardSha256,
        input.qualificationArtifactDigest,
        input.operatorId,
        input.previousDeploymentId,
        input.targetDeploymentId,
        input.targetArtifactDigest,
        input.productionHostDigest,
        input.productionProjectDigest,
    ].join("\n"), "utf8").digest("hex");

    const finalArtifacts = [];
    for (const [index, dimension] of RELEASE_DIMENSIONS.entries()) {
        const sourceDescriptor = sourceManifest.artifacts[index];
        if (sourceDescriptor.kind !== dimension) fail("final_release_invalid");
        const sourceEvidence = exactEvidence(
            await readSecureJson(sourceDescriptor.path, "final_release_invalid"),
            dimension,
            sourceManifest,
        );
        const targetCheckId = dimension === "hosted_deployment"
            ? "hosted_deployment_promotion_lineage"
            : dimension === "recovery_release"
                ? "recovery_release_rollback_evidence"
                : null;
        if (targetCheckId) {
            const current = sourceEvidence.checks.find((check) => check.id === targetCheckId);
            if (current?.status !== "unverified") fail("final_release_invalid");
        }
        const changed = targetCheckId !== null;
        const finalEvidence = {
            ...sourceEvidence,
            environmentDigest: finalEnvironmentDigest,
            ...(changed ? { generatedAt: input.generatedAt } : {}),
            checks: sourceEvidence.checks.map((check) => check.id === targetCheckId
                ? { ...check, status: input.outcome === "verified" ? "passed" : "failed" }
                : check),
            hardGates: sourceEvidence.hardGates.map((gate) => (
                input.outcome === "failed" && gate.id === "health_readiness"
                    ? { ...gate, status: "failed" }
                    : gate
            )),
        };
        const outputPath = resolve(input.finalReleaseRoot, `evidence-${dimension}.json`);
        await writePrivateJsonExclusive(outputPath, finalEvidence, "final_release_invalid");
        const outputBytes = await readSecureBytes(outputPath, "final_release_invalid");
        finalArtifacts.push({
            ...sourceDescriptor,
            environmentDigest: finalEnvironmentDigest,
            path: outputPath,
            sha256: createHash("sha256").update(outputBytes).digest("hex"),
            ...(changed ? {
                generatedAt: input.generatedAt,
                freshUntil: new Date(
                    Date.parse(input.generatedAt) + RELEASE_ARTIFACT_CATALOG[dimension].maxAgeMs,
                ).toISOString(),
            } : {}),
        });
    }
    const provenance = {
        schemaVersion: 1,
        status: input.outcome === "verified" ? "verified" : "failed",
        buildSha: input.expectedBuildSha,
        sourceEnvironmentDigest: input.expectedEnvironmentDigest,
        finalEnvironmentDigest,
        generatedAt: input.generatedAt,
        qualificationArtifactDigest: input.qualificationArtifactDigest,
        rollbackGuardSha256: input.rollbackGuardSha256,
        verifierEvidenceSha256,
        operatorIdHash,
        previousDeploymentId: input.previousDeploymentId,
        targetDeploymentId: input.targetDeploymentId,
        targetArtifactDigest: input.targetArtifactDigest,
        productionHostDigest: input.productionHostDigest,
        productionProjectDigest: input.productionProjectDigest,
        checks: [
            {
                id: "hosted_deployment_promotion_lineage",
                status: input.outcome === "verified" ? "passed" : "failed",
            },
            {
                id: "recovery_release_rollback_evidence",
                status: input.outcome === "verified" ? "passed" : "failed",
            },
        ],
    };
    await writePrivateJsonExclusive(
        resolve(input.finalReleaseRoot, "final-promotion-provenance.json"),
        provenance,
        "final_release_invalid",
    );
    const finalManifest = {
        schemaVersion: sourceManifest.schemaVersion,
        buildSha: sourceManifest.buildSha,
        environmentDigest: finalEnvironmentDigest,
        generatedAt: input.generatedAt,
        artifacts: finalArtifacts,
        dimensions: sourceManifest.dimensions,
        hardGates: sourceManifest.hardGates,
    };
    try { validateReleaseManifest(finalManifest); } catch { fail("final_release_invalid"); }
    const manifestPath = resolve(input.finalReleaseRoot, "release-quality-manifest.json");
    const scorePath = resolve(input.finalReleaseRoot, "release-quality-score.json");
    await writePrivateJsonExclusive(manifestPath, finalManifest, "final_release_invalid");
    const manifestBytes = await readSecureBytes(manifestPath, "final_release_invalid");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    const scoreOutcome = await runReleaseScoreCli({
        argv: [`--manifest=${manifestPath}`, `--output=${scorePath}`],
        cwd: resolve(import.meta.dirname, ".."),
    }, {
        ...(overrides.now ? { now: overrides.now } : {}),
        ...(overrides.scorerSha ? { scorerSha: overrides.scorerSha } : {}),
    });
    if (input.outcome === "verified") {
        if (scoreOutcome.result.status !== "go") fail("final_release_invalid");
        await validatePublishedReleaseScore(scorePath, {
            buildSha: input.expectedBuildSha,
            scorerSha: input.expectedBuildSha,
            environmentDigest: finalEnvironmentDigest,
            manifestSha256,
        });
        return Object.freeze({
            status: "verified",
            scoreStatus: "go",
            manifestSha256,
            finalEnvironmentDigest,
        });
    }
    if (scoreOutcome.result.status !== "no_go") fail("final_release_invalid");
    return Object.freeze({
        status: "unverified",
        scoreStatus: "no_go",
        manifestSha256,
        finalEnvironmentDigest,
    });
}

function assertPostPromotionEvidence(evidence, input) {
    const releaseIdentity = evidence?.releaseIdentity;
    const access = evidence?.access;
    if (
        evidence?.status !== "verified"
        || evidence.productionHost !== input.productionHost
        || evidence.build !== input.expectedBuildSha
        || releaseIdentity?.verifierSha !== input.expectedBuildSha
        || releaseIdentity?.deployedSha !== input.expectedBuildSha
        || releaseIdentity?.previewDeploymentId !== input.previewDeploymentId
        || releaseIdentity?.previewArtifactDigest !== input.previewArtifactDigest
        || releaseIdentity?.previewIdentityAttested !== true
        || evidence.readinessVersion !== input.readinessVersion
        || evidence.databaseProjectRefHash !== input.expectedDatabaseProjectRefHash
        || !exactKeys(access, ["anon", "authenticated"])
        || access.anon !== "denied"
        || access.authenticated !== "denied"
    ) fail("post_promotion_verification_failed");
}

async function execute(file, args, options = {}) {
    await execFileAsync(file, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        maxBuffer: 128 * 1024,
        timeout: options.timeout ?? 15 * 60 * 1000,
        windowsHide: true,
    });
}

async function defaultRunVerifier(input, deps) {
    const repository = resolve(import.meta.dirname, "..");
    await deps.execute(process.execPath, [
        resolve(repository, "scripts/verify-production-deployment.mjs"),
        `--confirm-production-host=${input.productionHost}`,
        `--output=${input.verifierOutputPath}`,
    ], {
        cwd: repository,
        env: process.env,
    });
    return readSecureJson(input.verifierOutputPath);
}

async function assertPrivateParent(outputPath) {
    const parent = dirname(outputPath);
    const stats = await lstat(parent);
    const canonical = await realpath(parent);
    const ownerMatches = typeof process.getuid !== "function" || stats.uid === process.getuid();
    if (
        canonical !== parent
        || !stats.isDirectory()
        || stats.isSymbolicLink()
        || (stats.mode & 0o777) !== 0o700
        || !ownerMatches
    ) fail("rollback_evidence_not_written");
    return parent;
}

export async function writeRollbackRequiredEvidence(outputPath, value) {
    const parent = await assertPrivateParent(outputPath);
    try {
        await lstat(outputPath);
        fail("rollback_evidence_not_written");
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        if (error?.code !== "ENOENT") fail("rollback_evidence_not_written");
    }
    const temporaryPath = `${parent}${sep}.${randomUUID()}.rollback.tmp`;
    let temporaryPresent = false;
    try {
        const handle = await open(temporaryPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        temporaryPresent = true;
        try {
            await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
            await handle.sync();
        } finally {
            await handle.close();
        }
        await link(temporaryPath, outputPath);
        await unlink(temporaryPath);
        temporaryPresent = false;
        const published = await lstat(outputPath);
        if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1 || (published.mode & 0o777) !== 0o600) {
            fail("rollback_evidence_not_written");
        }
        const directoryHandle = await open(parent, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
        return Object.freeze({
            dev: published.dev,
            ino: published.ino,
            sha256: createHash("sha256").update(`${JSON.stringify(value)}\n`, "utf8").digest("hex"),
        });
    } catch (error) {
        if (temporaryPresent) {
            try { await unlink(temporaryPath); } catch { /* best effort only */ }
        }
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        fail("rollback_evidence_not_written");
    }
}

export async function clearRollbackRequiredEvidence(outputPath, binding) {
    const parent = await assertPrivateParent(outputPath);
    if (!Number.isSafeInteger(binding?.dev) || !Number.isSafeInteger(binding?.ino)) {
        fail("rollback_evidence_not_cleared");
    }
    try {
        const stats = await lstat(outputPath);
        if (
            !stats.isFile()
            || stats.isSymbolicLink()
            || stats.nlink !== 1
            || (stats.mode & 0o777) !== 0o600
            || stats.dev !== binding.dev
            || stats.ino !== binding.ino
        ) fail("rollback_evidence_not_cleared");
        await unlink(outputPath);
        const directoryHandle = await open(parent, constants.O_RDONLY);
        try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    } catch (error) {
        if (error instanceof QualifiedPreviewPromotionError) throw error;
        fail("rollback_evidence_not_cleared");
    }
}

function rollbackEvidence(input, now, trigger) {
    const failedAt = now();
    if (!(failedAt instanceof Date) || Number.isNaN(failedAt.getTime())) fail("rollback_evidence_not_written");
    return Object.freeze({
        schemaVersion: 1,
        status: "rollback_required",
        trigger,
        writes: "paused",
        previousDeploymentId: input.previousDeploymentId,
        targetDeploymentId: input.previewDeploymentId,
        buildSha: input.expectedBuildSha,
        failedAt: failedAt.toISOString(),
        operatorIdHash: createHash("sha256").update(`omr.release-operator:v1\0${input.operatorId}`, "utf8").digest("hex"),
    });
}

function finalReleaseInput(input, rollbackBinding, outcome, verifierEvidence, generatedAt) {
    return {
        expectedBuildSha: input.expectedBuildSha,
        expectedEnvironmentDigest: input.expectedEnvironmentDigest,
        finalReleaseRoot: input.finalReleaseRoot,
        generatedAt,
        outcome,
        operatorId: input.operatorId,
        previousDeploymentId: input.previousDeploymentId,
        productionHostDigest: createHash("sha256")
            .update(`omr.initial-operations.production-host:v1\n${input.productionHost}`, "utf8")
            .digest("hex"),
        productionProjectDigest: createHash("sha256")
            .update(
                `omr.initial-operations.production-project-hash:v1\n${input.expectedDatabaseProjectRefHash}`,
                "utf8",
            )
            .digest("hex"),
        qualificationArtifactDigest: input.qualificationArtifactDigest,
        rollbackGuardSha256: rollbackBinding.sha256,
        sourceManifestPath: input.manifestPath,
        sourceManifestSha256: input.manifestSha256,
        targetArtifactDigest: input.previewArtifactDigest,
        targetDeploymentId: input.previewDeploymentId,
        verifierEvidence,
    };
}

export async function runQualifiedPreviewPromotion(input, overrides = {}) {
    const validation = validatePromotionInput(input);
    if (!validation.ok) fail(validation.error);
    const deps = {
        validateScore: overrides.validateScore ?? validatePublishedReleaseScore,
        execute: overrides.execute ?? execute,
        promotionEnvironment: overrides.promotionEnvironment
            ?? (() => overrides.execute ? Object.freeze({}) : buildPromotionProcessEnvironment(process.env)),
        verifyPreviewLineage: overrides.verifyPreviewLineage ?? verifyQualifiedPreviewLineage,
        runVerifier: overrides.runVerifier,
        writeRollbackEvidence: overrides.writeRollbackEvidence ?? writeRollbackRequiredEvidence,
        clearRollbackEvidence: overrides.clearRollbackEvidence ?? clearRollbackRequiredEvidence,
        finalizeRelease: overrides.finalizeRelease ?? finalizePromotionRelease,
        now: overrides.now ?? (() => new Date()),
    };
    try {
        const score = await deps.validateScore(input.scorePath, {
            buildSha: input.expectedBuildSha,
            scorerSha: input.expectedBuildSha,
            environmentDigest: input.expectedEnvironmentDigest,
            manifestSha256: input.manifestSha256,
        });
        if (score?.status !== "verified" || score.score?.status !== "go") fail("qualification_failed");
    } catch {
        fail("qualification_failed");
    }
    try {
        const lineage = await deps.verifyPreviewLineage(input);
        if (lineage?.status !== "verified") fail("preview_lineage_unverified");
    } catch {
        fail("preview_lineage_unverified");
    }

    const rollbackBinding = await deps.writeRollbackEvidence(
        input.rollbackOutputPath,
        rollbackEvidence(input, deps.now, "promotion_outcome_unverified"),
    );
    const [file, ...args] = buildPromotionCommand(input);
    try {
        await deps.execute(file, args, { env: deps.promotionEnvironment() });
    } catch {
        const failedAt = deps.now();
        if (!(failedAt instanceof Date) || Number.isNaN(failedAt.getTime())) fail("final_release_invalid");
        await deps.finalizeRelease(finalReleaseInput(
            input,
            rollbackBinding,
            "failed",
            null,
            failedAt.toISOString(),
        ));
        fail("promotion_unverified");
    }

    let evidence;
    try {
        evidence = deps.runVerifier
            ? await deps.runVerifier(input)
            : await defaultRunVerifier(input, deps);
        assertPostPromotionEvidence(evidence, input);
        if (!canonicalIso(evidence.verifiedAt)) fail("post_promotion_verification_failed");
    } catch {
        const failedAt = deps.now();
        if (!(failedAt instanceof Date) || Number.isNaN(failedAt.getTime())) fail("final_release_invalid");
        await deps.finalizeRelease(finalReleaseInput(
            input,
            rollbackBinding,
            "failed",
            null,
            failedAt.toISOString(),
        ));
        fail("post_promotion_verification_failed");
    }
    const finalRelease = await deps.finalizeRelease(finalReleaseInput(
        input,
        rollbackBinding,
        "verified",
        evidence,
        evidence.verifiedAt,
    ));
    if (finalRelease?.status !== "verified" || finalRelease.scoreStatus !== "go"
        || !SHA256.test(finalRelease.finalEnvironmentDigest)
        || !SHA256.test(finalRelease.manifestSha256)) {
        fail("final_release_invalid");
    }
    await deps.clearRollbackEvidence(input.rollbackOutputPath, rollbackBinding);
    return Object.freeze({
        status: "verified",
        writes: "paused",
        buildSha: input.expectedBuildSha,
        finalEnvironmentDigest: finalRelease.finalEnvironmentDigest,
        finalManifestSha256: finalRelease.manifestSha256,
        targetDeploymentId: input.previewDeploymentId,
    });
}

function promotionInputFromEnvironment(env) {
    return {
        allowedPreviewHostSuffix: env.OMR_PROMOTION_ALLOWED_PREVIEW_HOST_SUFFIX,
        expectedBuildSha: env.OMR_PRODUCTION_EXPECTED_BUILD,
        expectedDatabaseProjectRefHash: env.OMR_PROMOTION_EXPECTED_DATABASE_PROJECT_REF_HASH,
        expectedEnvironmentDigest: env.OMR_PROMOTION_EXPECTED_ENVIRONMENT_DIGEST,
        finalReleaseRoot: env.OMR_PROMOTION_FINAL_RELEASE_ROOT,
        manifestPath: env.OMR_PROMOTION_MANIFEST_PATH,
        manifestSha256: env.OMR_PROMOTION_MANIFEST_SHA256,
        operatorConfirmation: env.OMR_PROMOTION_OPERATOR_CONFIRMATION,
        operatorId: env.OMR_PROMOTION_OPERATOR_ID,
        previewArtifactDigest: env.OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST,
        previewAttestationSignature: env.OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE,
        previewDeploymentId: env.OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID,
        previousDeploymentId: env.OMR_PROMOTION_PREVIOUS_DEPLOYMENT_ID,
        productionHost: env.OMR_PRODUCTION_HOST,
        qualificationArtifactDigest: env.OMR_PROMOTION_QUALIFICATION_ARTIFACT_DIGEST,
        qualifiedPreviewHost: env.OMR_PROMOTION_QUALIFIED_PREVIEW_HOST,
        qualifiedPreviewUrl: env.OMR_PROMOTION_QUALIFIED_PREVIEW_URL,
        readinessVersion: env.OMR_PRODUCTION_EXPECTED_READINESS_VERSION,
        rollbackOutputPath: env.OMR_PROMOTION_ROLLBACK_OUTPUT_PATH,
        scorePath: env.OMR_PROMOTION_SCORE_PATH,
        verifierOutputPath: env.OMR_PROMOTION_VERIFIER_OUTPUT_PATH,
        writesPauseConfirmation: env.OMR_PROMOTION_WRITES_PAUSE_CONFIRMATION,
    };
}

async function main() {
    if (process.argv.length !== 3) fail("invalid_input");
    const result = process.argv[2] === "prepare"
        ? await prepareQualificationBundle({
            expectedBuildSha: process.env.OMR_PRODUCTION_EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: process.env.OMR_PROMOTION_EXPECTED_DATABASE_PROJECT_REF_HASH,
            expectedEnvironmentDigest: process.env.OMR_PROMOTION_EXPECTED_ENVIRONMENT_DIGEST,
            expectedProductionHost: process.env.OMR_PRODUCTION_HOST,
            expectedQualifiedPreviewArtifactDigest: process.env.OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST,
            expectedQualifiedPreviewDeploymentId: process.env.OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID,
            expectedQualifiedPreviewHost: process.env.OMR_PROMOTION_QUALIFIED_PREVIEW_HOST,
            outputPath: process.env.OMR_PROMOTION_MANIFEST_PATH,
            qualificationRoot: process.env.OMR_PROMOTION_QUALIFICATION_ROOT,
        })
        : process.argv[2] === "promote"
            ? await runQualifiedPreviewPromotion(promotionInputFromEnvironment(process.env))
            : fail("invalid_input");
    process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        await main();
    } catch (error) {
        const code = error instanceof QualifiedPreviewPromotionError ? error.code : "promotion_unverified";
        process.stdout.write(`${JSON.stringify({ status: "unverified", code, writes: "paused" })}\n`);
        process.exitCode = 1;
    }
}
