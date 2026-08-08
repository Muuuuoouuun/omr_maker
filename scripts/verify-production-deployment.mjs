import { execFileSync } from "node:child_process";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { parseStrictJson } from "./strict-json.mjs";
import { probeStaticAssetCompression } from "./verify-initial-operations.mjs";

const GIT_SHA = /^[a-f0-9]{40}$/;
const READINESS_VERSION = /^\d{12}$/;
const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,62}$/;
const PREVIEW_DEPLOYMENT_ID = /^[A-Za-z0-9._:-]{3,200}$/;
const PREVIEW_ARTIFACT_DIGEST = /^sha256:[a-f0-9]{64}$/;
const PREVIEW_ATTESTATION_SIGNATURE = /^[a-f0-9]{64}$/;
const PROVISIONED_TEACHER_ACCOUNT_ID = /^teacher_[a-f0-9]{16}$/;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const ASSET_GC_REQUEST_TIMEOUT_MS = 65_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 65_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function setOnce(target, key, value) {
    if (Object.hasOwn(target, key)) throw new Error(`Duplicate production verification argument: ${key}`);
    target[key] = value;
}

function parseArgs(argv) {
    if (!Array.isArray(argv)) throw new Error("Production verification arguments are invalid");
    const parsed = {};
    for (const argument of argv) {
        if (argument.startsWith("--confirm-production-host=")) {
            setOnce(parsed, "confirmedHost", argument.slice("--confirm-production-host=".length));
        } else if (argument.startsWith("--output=")) {
            setOnce(parsed, "outputPath", argument.slice("--output=".length));
        } else {
            throw new Error(`Unknown production verification argument: ${String(argument).slice(0, 48)}`);
        }
    }
    return parsed;
}

function strictOrigin(value, label, suffix = "") {
    let url;
    try {
        url = new URL(clean(value));
    } catch {
        throw new Error(`${label} is missing or invalid`);
    }
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || url.pathname !== "/"
        || url.search
        || url.hash
        || (suffix && !url.hostname.endsWith(suffix))
    ) throw new Error(`${label} is missing or invalid`);
    return { origin: url.origin, hostname: url.hostname.toLowerCase() };
}

function strongSecret(value, label) {
    const secret = clean(value);
    const length = Buffer.byteLength(secret, "utf8");
    if (length < 32 || length > 4096 || /\s/.test(secret)) throw new Error(`${label} is missing or invalid`);
    return secret;
}

function releaseAttestationSecret(value) {
    const secret = typeof value === "string" ? value : "";
    const length = Buffer.byteLength(secret, "utf8");
    if (length < 32 || length > 512 || /\s/.test(secret)) {
        throw new Error("Release attestation secret is missing or invalid");
    }
    return secret;
}

function assetGcCronSecret(value) {
    const secret = typeof value === "string" ? value : "";
    const length = Buffer.byteLength(secret, "utf8");
    if (length < 32 || length > 256 || /\s/.test(secret)) {
        throw new Error("Asset GC cron secret is missing or invalid");
    }
    return secret;
}

export function buildPreviewIdentityAttestationPayload({ expectedBuild, previewDeploymentId, previewArtifactDigest }) {
    return `omr-preview-identity:v1\n${expectedBuild}\n${previewDeploymentId}\n${previewArtifactDigest}`;
}

function verifyPreviewIdentityAttestation({ expectedBuild, previewDeploymentId, previewArtifactDigest, signature, secret }) {
    if (!PREVIEW_ATTESTATION_SIGNATURE.test(signature)) {
        throw new Error("Release attestation signature is missing or invalid");
    }
    const payload = buildPreviewIdentityAttestationPayload({
        expectedBuild,
        previewDeploymentId,
        previewArtifactDigest,
    });
    const expectedSignature = createHmac("sha256", secret).update(payload, "utf8").digest();
    const providedSignature = Buffer.from(signature, "hex");
    if (!timingSafeEqual(expectedSignature, providedSignature)) {
        throw new Error("Release attestation signature is missing or invalid");
    }
}

function safeOutputPath(value, cwd) {
    const raw = clean(value);
    if (!isAbsolute(raw)) throw new Error("Production verification output is missing or invalid");
    const output = resolve(raw);
    const root = parse(output).root;
    const repository = resolve(cwd);
    const repositoryRelative = relative(repository, output);
    if (
        output === root
        || output === repository
        || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".." && !isAbsolute(repositoryRelative))
    ) throw new Error("Production verification output must be outside the repository");
    return output;
}

function resolveVerifierSha(cwd) {
    let verifierSha;
    try {
        verifierSha = clean(execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
            cwd,
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "" },
            stdio: ["ignore", "pipe", "ignore"],
        }));
    } catch {
        throw new Error("Verifier checkout HEAD is missing or invalid");
    }
    if (!GIT_SHA.test(verifierSha)) throw new Error("Verifier checkout HEAD is missing or invalid");
    return verifierSha;
}

export function resolveProductionDeploymentConfig(input) {
    const args = parseArgs(input?.argv ?? []);
    const env = input?.env ?? {};
    const app = strictOrigin(env.OMR_PRODUCTION_BASE_URL, "Production base URL");
    if (clean(args.confirmedHost).toLowerCase() !== app.hostname) {
        throw new Error("Confirmed production host is missing or invalid");
    }
    const database = strictOrigin(env.OMR_PRODUCTION_SUPABASE_URL, "Production Supabase URL", ".supabase.co");
    const schedulerPauseConfirmation = typeof env.OMR_PRODUCTION_ASSET_GC_PAUSED_REF === "string"
        ? env.OMR_PRODUCTION_ASSET_GC_PAUSED_REF
        : "";
    if (schedulerPauseConfirmation !== `asset-gc-paused:${app.hostname}`) {
        throw new Error("Asset GC scheduler pause confirmation is missing or invalid");
    }
    const projectRef = database.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] ?? "";
    if (!PROJECT_REF.test(projectRef)) throw new Error("Production Supabase project ref is invalid");
    const expectedBuild = typeof env.OMR_PRODUCTION_EXPECTED_BUILD === "string"
        ? env.OMR_PRODUCTION_EXPECTED_BUILD
        : "";
    const expectedReadinessVersion = clean(env.OMR_PRODUCTION_EXPECTED_READINESS_VERSION);
    if (!GIT_SHA.test(expectedBuild)) throw new Error("Expected production build is missing or invalid");
    const verifierSha = resolveVerifierSha(input.cwd);
    if (verifierSha !== expectedBuild) throw new Error("Verifier checkout HEAD does not match expected build");
    if (!READINESS_VERSION.test(expectedReadinessVersion)) {
        throw new Error("Expected readiness version is missing or invalid");
    }
    const previewDeploymentId = typeof env.OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID === "string"
        ? env.OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID
        : "";
    if (!PREVIEW_DEPLOYMENT_ID.test(previewDeploymentId)) {
        throw new Error("Preview deployment ID is missing or invalid");
    }
    const previewArtifactDigest = typeof env.OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST === "string"
        ? env.OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST
        : "";
    if (!PREVIEW_ARTIFACT_DIGEST.test(previewArtifactDigest)) {
        throw new Error("Preview artifact digest is missing or invalid");
    }
    const releaseAttestation = releaseAttestationSecret(env.OMR_RELEASE_ATTESTATION_SECRET);
    const previewAttestationSignature = typeof env.OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE === "string"
        ? env.OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE
        : "";
    verifyPreviewIdentityAttestation({
        expectedBuild,
        previewDeploymentId,
        previewArtifactDigest,
        signature: previewAttestationSignature,
        secret: releaseAttestation,
    });
    const readinessToken = strongSecret(env.OMR_READINESS_TOKEN, "Readiness token");
    const anonKey = strongSecret(env.OMR_PRODUCTION_SUPABASE_ANON_KEY, "Production anon key");
    const authenticatedJwt = strongSecret(env.OMR_PRODUCTION_AUTHENTICATED_JWT, "Production authenticated JWT");
    const serviceRoleKey = strongSecret(env.OMR_PRODUCTION_SUPABASE_SERVICE_ROLE_KEY, "Production service role key");
    const gcCronSecret = assetGcCronSecret(env.OMR_ASSET_GC_CRON_SECRET);
    const canaryAccountId = env.OMR_PRODUCTION_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID;
    if (typeof canaryAccountId !== "string" || !PROVISIONED_TEACHER_ACCOUNT_ID.test(canaryAccountId)) {
        throw new Error("Provisioned teacher canary account ID is missing or invalid");
    }
    if (new Set([
        readinessToken,
        anonKey,
        authenticatedJwt,
        serviceRoleKey,
        releaseAttestation,
        gcCronSecret,
    ]).size !== 6) {
        throw new Error("Production verification credentials must be distinct");
    }
    const config = {
        baseUrl: app.origin,
        productionHost: app.hostname,
        supabaseUrl: database.origin,
        databaseProjectRefHash: createHash("sha256").update(projectRef).digest("hex"),
        schedulerPauseConfirmationHash: createHash("sha256")
            .update(schedulerPauseConfirmation)
            .digest("hex"),
        expectedBuild,
        verifierSha,
        previewDeploymentId,
        previewArtifactDigest,
        previewIdentityAttested: true,
        expectedReadinessVersion,
        outputPath: safeOutputPath(args.outputPath, input.cwd),
    };
    Object.defineProperties(config, {
        readinessToken: { value: readinessToken, enumerable: false },
        anonKey: { value: anonKey, enumerable: false },
        authenticatedJwt: { value: authenticatedJwt, enumerable: false },
        serviceRoleKey: { value: serviceRoleKey, enumerable: false },
        gcCronSecret: { value: gcCronSecret, enumerable: false },
        canaryAccountId: { value: canaryAccountId, enumerable: false },
    });
    return Object.freeze(config);
}

async function boundedJson(response) {
    const type = clean(response.headers.get("content-type")).toLowerCase();
    const declared = response.headers.get("content-length");
    if (!type.startsWith("application/json")) throw new Error("Hosted verification response type is invalid");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
        throw new Error("Hosted verification response is too large");
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("Hosted verification response is too large");
    try {
        return parseStrictJson(bytes.toString("utf8"));
    } catch {
        throw new Error("Hosted verification response JSON is invalid");
    }
}

export async function requestJson(
    url,
    init,
    fetchImpl,
    acceptedStatuses,
    timeoutMs = REQUEST_TIMEOUT_MS,
) {
    if (
        !Number.isSafeInteger(timeoutMs)
        || timeoutMs < MIN_REQUEST_TIMEOUT_MS
        || timeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) throw new Error("Hosted verification timeout is invalid");
    const controller = new AbortController();
    const timer = setTimeout(
        () => controller.abort(new DOMException("Verification timed out", "TimeoutError")),
        timeoutMs,
    );
    try {
        const response = await fetchImpl(url, {
            ...init,
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
        });
        if (response.redirected || response.url !== url.toString() || !acceptedStatuses.includes(response.status)) {
            throw new Error("Hosted verification response status is invalid");
        }
        return { status: response.status, body: await boundedJson(response) };
    } catch (error) {
        if (error instanceof Error && error.message.startsWith("Hosted verification")) throw error;
        throw new Error("Hosted verification request failed");
    } finally {
        clearTimeout(timer);
    }
}

async function writeExclusiveJson(path, value) {
    let handle;
    try {
        handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
        await handle.sync();
    } finally {
        await handle?.close().catch(() => undefined);
    }
}

export async function runProductionDeploymentVerification(config, fetchImpl = fetch, now = new Date()) {
    const staticAssetCompression = await probeStaticAssetCompression(config, fetchImpl);
    const healthUrl = new URL("/api/healthz", `${config.baseUrl}/`);
    const health = await requestJson(healthUrl, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": "omr-production-verifier/1" },
    }, fetchImpl, [200]);
    const healthTimestamp = typeof health.body?.timestamp === "string" ? Date.parse(health.body.timestamp) : Number.NaN;
    if (
        health.body?.status !== "alive"
        || health.body?.build !== config.expectedBuild
        || !Number.isFinite(healthTimestamp)
        || Math.abs(now.getTime() - healthTimestamp) > MAX_CLOCK_SKEW_MS
    ) throw new Error("Production health attestation mismatch");

    const assetGcUrl = new URL("/api/internal/asset-gc", `${config.baseUrl}/`);
    const assetGc = await requestJson(assetGcUrl, {
        method: "GET",
        headers: {
            accept: "application/json",
            authorization: `Bearer ${config.gcCronSecret}`,
            "user-agent": "omr-production-verifier/1",
        },
    }, fetchImpl, [200], ASSET_GC_REQUEST_TIMEOUT_MS);
    const boundedCount = (value, maximum) => Number.isSafeInteger(value)
        && value >= 0
        && value <= maximum;
    if (
        assetGc.body?.status !== "ok"
        || !["ready", "degraded"].includes(assetGc.body?.observability)
        || !boundedCount(assetGc.body?.claimed, 100)
        || !boundedCount(assetGc.body?.deleted, 100)
        || !boundedCount(assetGc.body?.failed, 100)
        || assetGc.body.failed !== 0
        || !boundedCount(assetGc.body?.batches, 4)
        || assetGc.body.batches < 1
        || !boundedCount(assetGc.body?.claimAttempts, 4)
        || assetGc.body.claimAttempts < 1
        || assetGc.body.claimAttempts !== assetGc.body.batches
        || !boundedCount(assetGc.body?.nonemptyBatches, 4)
        || assetGc.body.nonemptyBatches > assetGc.body.claimAttempts
        || assetGc.body.claimed !== assetGc.body.deleted + assetGc.body.failed
        || (assetGc.body.claimed === 0 && assetGc.body.nonemptyBatches !== 0)
        || (assetGc.body.claimed > 0 && (
            assetGc.body.nonemptyBatches < 1
            || assetGc.body.claimed > 25 * assetGc.body.nonemptyBatches
        ))
        || !Number.isSafeInteger(assetGc.body?.runSequence)
        || assetGc.body.runSequence <= 0
        || assetGc.body.applied !== true
        || assetGc.body.superseded !== false
        || assetGc.body.duplicate !== false
        || assetGc.body.durableStatus !== "healthy"
        || assetGc.body.deadCount !== 0
    ) throw new Error("Production asset GC bootstrap failed");

    const readinessUrl = new URL("/api/readyz", `${config.baseUrl}/`);
    const readiness = await requestJson(readinessUrl, {
        method: "GET",
        headers: {
            accept: "application/json",
            authorization: `Bearer ${config.readinessToken}`,
            "user-agent": "omr-production-verifier/1",
        },
    }, fetchImpl, [200]);
    if (
        readiness.body?.status !== "ready"
        || readiness.body?.database !== "ready"
        || readiness.body?.observability !== "ready"
        || readiness.body?.configuration !== "ready"
        || readiness.body?.version !== config.expectedReadinessVersion
    ) throw new Error("Production readiness attestation mismatch");

    const rpcUrl = new URL("/rest/v1/rpc/omr_service_readiness_v1", `${config.supabaseUrl}/`);
    const directReadiness = await requestJson(rpcUrl, {
        method: "POST",
        headers: {
            accept: "application/json",
            apikey: config.serviceRoleKey,
            authorization: `Bearer ${config.serviceRoleKey}`,
            "content-type": "application/json",
            "user-agent": "omr-production-verifier/1",
        },
        body: "{}",
    }, fetchImpl, [200]);
    if (directReadiness.body?.ready !== true || directReadiness.body?.version !== config.expectedReadinessVersion) {
        throw new Error("Production database readiness mismatch");
    }

    const canaryUrl = new URL(
        "/rest/v1/rpc/omr_probe_provisioned_teacher_canary_v1",
        `${config.supabaseUrl}/`,
    );
    const canary = await requestJson(canaryUrl, {
        method: "POST",
        headers: {
            accept: "application/json",
            apikey: config.serviceRoleKey,
            authorization: `Bearer ${config.serviceRoleKey}`,
            "content-type": "application/json",
            "user-agent": "omr-production-verifier/1",
        },
        body: JSON.stringify({ p_account_id: config.canaryAccountId }),
    }, fetchImpl, [200]);
    if (canary.body?.ready !== true || Object.keys(canary.body).length !== 1) {
        throw new Error("Production provisioned teacher canary mismatch");
    }

    const tableUrl = new URL("/rest/v1/omr_exams?select=id&limit=1", `${config.supabaseUrl}/`);
    const access = {};
    for (const [actor, bearer] of [["anon", config.anonKey], ["authenticated", config.authenticatedJwt]]) {
        await requestJson(tableUrl, {
            method: "GET",
            headers: {
                accept: "application/json",
                apikey: config.anonKey,
                authorization: `Bearer ${bearer}`,
                "user-agent": "omr-production-verifier/1",
            },
        }, fetchImpl, [401, 403]);
        access[actor] = "denied";
    }

    const evidence = Object.freeze({
        status: "verified",
        verifiedAt: now.toISOString(),
        productionHost: config.productionHost,
        build: config.expectedBuild,
        releaseIdentity: Object.freeze({
            verifierSha: config.verifierSha,
            deployedSha: health.body.build,
            previewDeploymentId: config.previewDeploymentId,
            previewArtifactDigest: config.previewArtifactDigest,
            previewIdentityAttested: config.previewIdentityAttested,
        }),
        readinessVersion: config.expectedReadinessVersion,
        provisionedTeacherCanary: "ready",
        databaseProjectRefHash: config.databaseProjectRefHash,
        schedulerPauseConfirmationHash: config.schedulerPauseConfirmationHash,
        assetGcBootstrap: Object.freeze({
            status: "healthy",
            observability: assetGc.body.observability,
            runSequence: assetGc.body.runSequence,
            claimed: assetGc.body.claimed,
            deleted: assetGc.body.deleted,
            claimAttempts: assetGc.body.claimAttempts,
            nonemptyBatches: assetGc.body.nonemptyBatches,
        }),
        access,
        staticAssetCompression,
    });
    await writeExclusiveJson(config.outputPath, evidence);
    return evidence;
}

async function main() {
    const cwd = resolve(import.meta.dirname, "..");
    try {
        const config = resolveProductionDeploymentConfig({ argv: process.argv.slice(2), env: process.env, cwd });
        const result = await runProductionDeploymentVerification(config);
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch {
        process.stdout.write(`${JSON.stringify({ status: "unverified", code: "production_deployment_not_verified" })}\n`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
