import "next/dist/compiled/server-only";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export interface InitialOperationsServerConfig {
    build: string;
    stagingHost: string;
    stagingSupabaseUrl: string;
    databaseProjectRefHash: string;
    serverInstanceId: string;
    loadToken: string;
}

export interface InitialOperationsRequestContext {
    runId: string;
    runChallenge: string;
    requestId: string;
    actorId: string;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const CHALLENGE = /^[a-f0-9]{32,128}$/;
const BUILD = /^[a-f0-9]{40}$/;
const REQUEST_ID = /^[a-z0-9][a-z0-9:._-]{7,255}$/;
const ACTOR_ID = /^(?:student_[a-f0-9]{16}_\d{3}|poller_[a-f0-9]{16}_\d{2}|uploader_[a-f0-9]{16}_\d{2}|control_[a-f0-9]{16}|collector_[a-f0-9]{16})$/;
const PROCESS_BOOT_ID = randomUUID().replaceAll("-", "").slice(0, 16);

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function strongSecret(value: unknown): string {
    const normalized = clean(value);
    const bytes = Buffer.byteLength(normalized, "utf8");
    return bytes >= 32 && bytes <= 256 && !/\s/.test(normalized) ? normalized : "";
}

function strictOrigin(value: unknown, suffix = ""): URL | null {
    try {
        const url = new URL(clean(value));
        if (url.protocol !== "https:" || url.username || url.password || url.port
            || url.pathname !== "/" || url.search || url.hash
            || (suffix && !url.hostname.endsWith(suffix))) return null;
        return url;
    } catch {
        return null;
    }
}

function projectRef(url: URL): string {
    return /^([a-z0-9-]+)\.supabase\.co$/.exec(url.hostname)?.[1] ?? "";
}

export function resolveInitialOperationsServerConfig(env: Env = process.env): InitialOperationsServerConfig | null {
    if (clean(env.NODE_ENV) !== "production" || clean(env.OMR_DEPLOYMENT_TIER) !== "staging"
        || clean(env.OMR_INITIAL_OPS_LOAD_ENABLED) !== "1") return null;
    const loadToken = strongSecret(env.OMR_INITIAL_OPS_TOKEN);
    const readinessToken = strongSecret(env.OMR_READINESS_TOKEN);
    const build = clean(env.VERCEL_GIT_COMMIT_SHA || env.GIT_SHA).toLowerCase();
    const stagingHost = clean(env.OMR_INITIAL_OPS_STAGING_HOST).toLowerCase();
    const productionBase = strictOrigin(env.OMR_PRODUCTION_BASE_URL);
    const stagingDatabase = strictOrigin(env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL, ".supabase.co");
    const productionDatabase = strictOrigin(env.OMR_PRODUCTION_SUPABASE_URL, ".supabase.co");
    const serviceRole = strongSecret(env.SUPABASE_SERVICE_ROLE_KEY || env.OMR_SUPABASE_SERVICE_ROLE_KEY);
    if (!loadToken || !readinessToken || loadToken === readinessToken || !BUILD.test(build)
        || !/^[a-z0-9](?:[a-z0-9.-]{1,251}[a-z0-9])$/.test(stagingHost)
        || !productionBase || stagingHost === productionBase.hostname
        || !stagingDatabase || !productionDatabase || !serviceRole
        || stagingDatabase.hostname === productionDatabase.hostname) return null;
    const stagingProjectRef = projectRef(stagingDatabase);
    const productionProjectRef = projectRef(productionDatabase);
    if (!stagingProjectRef || !productionProjectRef || stagingProjectRef === productionProjectRef) return null;
    const deploymentId = clean(env.VERCEL_DEPLOYMENT_ID);
    const deploymentScope = /^[a-zA-Z0-9._-]{3,128}$/.test(deploymentId)
        ? deploymentId
        : `${stagingHost}:${build}`;
    const serverInstanceId = `instance_${createHash("sha256").update(deploymentScope).digest("hex").slice(0, 16)}_${PROCESS_BOOT_ID}`;
    return Object.freeze({
        build,
        stagingHost,
        stagingSupabaseUrl: stagingDatabase.origin,
        databaseProjectRefHash: createHash("sha256").update(stagingProjectRef).digest("hex"),
        serverInstanceId,
        loadToken,
    });
}

function constantTimeBearer(headers: Headers, expected: string): boolean {
    const authorization = clean(headers.get("authorization"));
    const supplied = authorization.startsWith("Bearer ") && !authorization.slice(7).includes(" ")
        ? authorization.slice(7)
        : "";
    const expectedBytes = Buffer.from(expected, "utf8");
    const suppliedBytes = Buffer.from(supplied, "utf8");
    const comparable = Buffer.alloc(expectedBytes.length);
    suppliedBytes.copy(comparable, 0, 0, Math.min(suppliedBytes.length, comparable.length));
    const equal = timingSafeEqual(comparable, expectedBytes);
    return suppliedBytes.length === expectedBytes.length && equal;
}

export function parseInitialOperationsRequestContext(
    headers: Headers,
    config: InitialOperationsServerConfig,
): InitialOperationsRequestContext | null {
    const host = clean(headers.get("host")).toLowerCase();
    const runId = clean(headers.get("x-omr-run-id")).toLowerCase();
    const runChallenge = clean(headers.get("x-omr-run-challenge")).toLowerCase();
    const expectedBuild = clean(headers.get("x-omr-expected-build")).toLowerCase();
    const requestId = clean(headers.get("x-omr-request-id"));
    const actorId = clean(headers.get("x-omr-actor-id"));
    if (host !== config.stagingHost || !RUN_ID.test(runId) || !CHALLENGE.test(runChallenge)
        || expectedBuild !== config.build || !REQUEST_ID.test(requestId)
        || !requestId.startsWith(`${runId}:`) || !ACTOR_ID.test(actorId)) return null;
    return { runId, runChallenge, requestId, actorId };
}

export function authorizeInitialOperationsRequest(headers: Headers, config: InitialOperationsServerConfig): boolean {
    const secretAccepted = constantTimeBearer(headers, config.loadToken);
    const contextAccepted = parseInitialOperationsRequestContext(headers, config) !== null;
    return secretAccepted && contextAccepted;
}

export function initialOperationsResponseHeaders(
    config: InitialOperationsServerConfig,
    serverDurationMs: number,
    memory?: { rssBytes: number; capturedAtMs: number },
): Headers {
    const duration = Number.isFinite(serverDurationMs) && serverDurationMs >= 0
        ? serverDurationMs.toFixed(3)
        : "0.000";
    const headers = new Headers({
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        "x-content-type-options": "nosniff",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-omr-build": config.build,
        "x-omr-instance-id": config.serverInstanceId,
        "x-omr-server-duration-ms": duration,
    });
    if (memory && Number.isSafeInteger(memory.rssBytes) && memory.rssBytes > 0
        && Number.isSafeInteger(memory.capturedAtMs) && memory.capturedAtMs > 0) {
        headers.set("x-omr-rss-bytes", String(memory.rssBytes));
        headers.set("x-omr-rss-captured-at-ms", String(memory.capturedAtMs));
    }
    return headers;
}
