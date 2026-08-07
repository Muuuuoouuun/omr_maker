import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import { parseStrictJson } from "./strict-json.mjs";
import { probeStaticAssetCompression } from "./verify-initial-operations.mjs";

const GIT_SHA = /^[a-f0-9]{40}$/;
const READINESS_VERSION = /^\d{12}$/;
const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,62}$/;
const MAX_RESPONSE_BYTES = 32 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
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

export function resolveProductionDeploymentConfig(input) {
    const args = parseArgs(input?.argv ?? []);
    const env = input?.env ?? {};
    const app = strictOrigin(env.OMR_PRODUCTION_BASE_URL, "Production base URL");
    if (clean(args.confirmedHost).toLowerCase() !== app.hostname) {
        throw new Error("Confirmed production host is missing or invalid");
    }
    const database = strictOrigin(env.OMR_PRODUCTION_SUPABASE_URL, "Production Supabase URL", ".supabase.co");
    const projectRef = database.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1] ?? "";
    if (!PROJECT_REF.test(projectRef)) throw new Error("Production Supabase project ref is invalid");
    const expectedBuild = clean(env.OMR_PRODUCTION_EXPECTED_BUILD).toLowerCase();
    const expectedReadinessVersion = clean(env.OMR_PRODUCTION_EXPECTED_READINESS_VERSION);
    if (!GIT_SHA.test(expectedBuild)) throw new Error("Expected production build is missing or invalid");
    if (!READINESS_VERSION.test(expectedReadinessVersion)) {
        throw new Error("Expected readiness version is missing or invalid");
    }
    const readinessToken = strongSecret(env.OMR_READINESS_TOKEN, "Readiness token");
    const anonKey = strongSecret(env.OMR_PRODUCTION_SUPABASE_ANON_KEY, "Production anon key");
    const authenticatedJwt = strongSecret(env.OMR_PRODUCTION_AUTHENTICATED_JWT, "Production authenticated JWT");
    const serviceRoleKey = strongSecret(env.OMR_PRODUCTION_SUPABASE_SERVICE_ROLE_KEY, "Production service role key");
    if (new Set([readinessToken, anonKey, authenticatedJwt, serviceRoleKey]).size !== 4) {
        throw new Error("Production verification credentials must be distinct");
    }
    const config = {
        baseUrl: app.origin,
        productionHost: app.hostname,
        supabaseUrl: database.origin,
        databaseProjectRefHash: createHash("sha256").update(projectRef).digest("hex"),
        expectedBuild,
        expectedReadinessVersion,
        outputPath: safeOutputPath(args.outputPath, input.cwd),
    };
    Object.defineProperties(config, {
        readinessToken: { value: readinessToken, enumerable: false },
        anonKey: { value: anonKey, enumerable: false },
        authenticatedJwt: { value: authenticatedJwt, enumerable: false },
        serviceRoleKey: { value: serviceRoleKey, enumerable: false },
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

async function requestJson(url, init, fetchImpl, acceptedStatuses) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Verification timed out", "TimeoutError")), REQUEST_TIMEOUT_MS);
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
        readinessVersion: config.expectedReadinessVersion,
        databaseProjectRefHash: config.databaseProjectRefHash,
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
