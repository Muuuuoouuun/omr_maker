import { createHash, timingSafeEqual } from "node:crypto";
import {
    probeSupabaseDeploymentWithServiceRole,
    type SupabaseDeploymentProbe,
} from "./supabaseReadinessProbe";
import { getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";
import {
    probeOperationalEventSink,
    type OperationalSinkReadiness,
} from "./operationalEventSink.server";
import {
    buildDeploymentReadiness,
    databaseProbeFailuresForIdentityMode,
    type DeploymentReadinessSummary,
} from "./deploymentReadiness";
import {
    probeTeacherAccountDelivery,
    type TeacherAccountDeliveryReadiness,
} from "./teacherAccountDelivery";
import { isRemoteAssetCleanupScheduled } from "./remoteAssetCleanup.server";
import { resolveTeacherIdentityMode } from "./teacherIdentityMode.server";
import {
    probeConfiguredProvisionedTeacherCanary,
    type ProvisionedTeacherCanaryReadiness,
} from "./provisionedTeacherCanary.server";
import {
    evaluateAssetGcReadiness,
    operationalRuntimeBuildSha,
    readOperationalJobStatusWithServiceRole,
    type OperationalJobStatus,
} from "./operationalJobStatusGateway.server";

type Env = Record<string, string | undefined>;

type StagingDeploymentAttestation = {
    environment: "staging";
    build: string;
    databaseProjectRefHash: string;
};

type OptionalStagingDeploymentAttestation = Partial<StagingDeploymentAttestation>;

export type OperationalReadinessPayload =
    | ({ status: "ready"; database: "ready"; observability: "ready"; configuration: "ready"; version?: string }
        & OptionalStagingDeploymentAttestation)
    | {
        status: "degraded";
        database: "ready";
        observability: Exclude<OperationalSinkReadiness, "ready">;
        configuration: "ready";
        version?: string;
    } & OptionalStagingDeploymentAttestation
    | {
        status: "not_ready";
        database: "ready" | "not_configured" | "probe_failed" | "probe_timeout" | "not_ready";
        observability: OperationalSinkReadiness;
        configuration?: "ready" | "not_ready";
        version?: string;
        failedChecks?: string[];
    } & OptionalStagingDeploymentAttestation;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function safeBuildId(env: Env): string {
    const candidate = clean(env.VERCEL_GIT_COMMIT_SHA)
        || clean(env.GIT_SHA)
        || clean(env.VERCEL_DEPLOYMENT_ID)
        || "unknown";
    const normalized = candidate.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 64);
    return normalized || "unknown";
}

export function buildLivenessPayload(env: Env = process.env, now = new Date()) {
    return {
        status: "alive" as const,
        build: safeBuildId(env),
        timestamp: now.toISOString(),
    };
}

export function authorizeReadinessRequest(headers: Headers, env: Env = process.env): boolean {
    const expected = clean(env.OMR_READINESS_TOKEN);
    const authorization = clean(headers.get("authorization"));
    if (!expected || !authorization.startsWith("Bearer ")) return false;
    const supplied = authorization.slice("Bearer ".length);
    if (!supplied || supplied.includes(" ")) return false;

    const suppliedBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (suppliedBytes.length !== expectedBytes.length) {
        // Keep an equal-length comparison on the mismatch path as well. The
        // endpoint never reveals whether configuration or syntax failed.
        const padded = Buffer.alloc(expectedBytes.length);
        suppliedBytes.copy(padded, 0, 0, Math.min(suppliedBytes.length, padded.length));
        timingSafeEqual(padded, expectedBytes);
        return false;
    }
    return timingSafeEqual(suppliedBytes, expectedBytes);
}

function readinessTimeoutMs(env: Env): number {
    const parsed = Number(env.OMR_READINESS_TIMEOUT_MS);
    if (!Number.isFinite(parsed)) return 5_000;
    return Math.min(10_000, Math.max(100, Math.trunc(parsed)));
}

function stagingDeploymentAttestation(env: Env): OptionalStagingDeploymentAttestation {
    if (clean(env.OMR_DEPLOYMENT_TIER) !== "staging") return {};

    const build = clean(env.VERCEL_GIT_COMMIT_SHA) || clean(env.GIT_SHA);
    if (!/^[0-9a-f]{40}$/i.test(build)) return {};

    const rawUrl = clean(env.SUPABASE_URL) || clean(env.NEXT_PUBLIC_SUPABASE_URL);
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        return {};
    }
    const hostnameMatch = /^([a-z0-9-]+)\.supabase\.co$/i.exec(url.hostname);
    if (
        url.protocol !== "https:"
        || url.port
        || url.username
        || url.password
        || url.pathname !== "/"
        || url.search
        || url.hash
        || !hostnameMatch
    ) return {};

    const projectRef = hostnameMatch[1].toLowerCase();
    return {
        environment: "staging",
        build,
        databaseProjectRefHash: createHash("sha256").update(projectRef).digest("hex"),
    };
}

export async function probeOperationalReadiness(
    env: Env = process.env,
    probe: (env: Env, signal?: AbortSignal) => Promise<SupabaseDeploymentProbe | null> = probeSupabaseDeploymentWithServiceRole,
    timeoutMs = readinessTimeoutMs(env),
    sinkProbe: (env: Env) => Promise<OperationalSinkReadiness> = probeOperationalEventSink,
    configurationProbe: (
        env: Env,
        databaseProbe?: SupabaseDeploymentProbe | null,
    ) => DeploymentReadinessSummary = buildDeploymentReadiness,
    deliveryProbe: (env: Env) => Promise<TeacherAccountDeliveryReadiness> = probeTeacherAccountDelivery,
    jobStatusProbe: (env: Env) => Promise<OperationalJobStatus | null> = readOperationalJobStatusWithServiceRole,
    canaryProbe: (env: Env, signal?: AbortSignal) => Promise<ProvisionedTeacherCanaryReadiness> = probeConfiguredProvisionedTeacherCanary,
): Promise<OperationalReadinessPayload> {
    const sinkPromise = sinkProbe(env).catch(() => "probe_failed" as const);
    const attestation = stagingDeploymentAttestation(env);
    if (!getSupabaseServerConfigFromEnv(env)) return {
        status: "not_ready",
        database: "not_configured",
        observability: await sinkPromise,
        ...attestation,
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
        const result = await Promise.race([
            probe(env, controller.signal),
            new Promise<"timeout">(resolve => {
                timer = setTimeout(() => {
                    controller.abort(new DOMException("Readiness probe timed out", "TimeoutError"));
                    resolve("timeout");
                }, Math.max(1, timeoutMs));
            }),
        ]);
        if (result === "timeout") {
            return { status: "not_ready", database: "probe_timeout", observability: await sinkPromise, ...attestation };
        }
        const observability = await sinkPromise;
        if (!result) return { status: "not_ready", database: "probe_failed", observability, ...attestation };
        const identityMode = resolveTeacherIdentityMode(env);
        const identityRelevantDatabaseFailures = databaseProbeFailuresForIdentityMode(
            result,
            identityMode,
        );
        if (identityRelevantDatabaseFailures.length > 0) {
            return {
                status: "not_ready",
                database: "not_ready",
                observability,
                ...attestation,
                ...(result.version ? { version: result.version } : {}),
                ...(identityRelevantDatabaseFailures.length
                    ? { failedChecks: identityRelevantDatabaseFailures }
                    : {}),
            };
        }
        const configuration = configurationProbe(env, result);
        const fatalConfigurationChecks = configuration.checks
            .filter(check => check.tone === "error")
            .map(check => `configuration:${check.key}`);
        if (fatalConfigurationChecks.length > 0) {
            return {
                status: "not_ready",
                database: "ready",
                observability,
                configuration: "not_ready",
                ...attestation,
                ...(result.version ? { version: result.version } : {}),
                failedChecks: fatalConfigurationChecks,
            };
        }
        if (identityMode === "provisioned_only") {
            let canaryTimer: ReturnType<typeof setTimeout> | undefined;
            const canaryController = new AbortController();
            const canaryReadiness = await Promise.race([
                canaryProbe(env, canaryController.signal).catch(() => "not_ready" as const),
                new Promise<"not_ready">(resolve => {
                    canaryTimer = setTimeout(() => {
                        canaryController.abort(new DOMException("Canary probe timed out", "TimeoutError"));
                        resolve("not_ready");
                    }, Math.max(1, timeoutMs));
                }),
            ]);
            if (canaryTimer) clearTimeout(canaryTimer);
            if (canaryReadiness !== "ready") {
                return {
                    status: "not_ready",
                    database: "ready",
                    observability,
                    configuration: "not_ready",
                    ...attestation,
                    ...(result.version ? { version: result.version } : {}),
                    failedChecks: ["configuration:provisioned_teacher_canary"],
                };
            }
        }
        const deliveryReadiness = identityMode === "self_service"
            ? await deliveryProbe(env).catch(() => "probe_failed" as const)
            : "ready" as const;
        if (deliveryReadiness !== "ready") {
            return {
                status: "not_ready",
                database: "ready",
                observability,
                configuration: "not_ready",
                ...attestation,
                ...(result.version ? { version: result.version } : {}),
                failedChecks: ["configuration:teacher_account_delivery_probe"],
            };
        }
        const assetGcScheduled = isRemoteAssetCleanupScheduled(env);
        const assetGcRequired = clean(env.NODE_ENV).toLowerCase() === "production" || assetGcScheduled;
        if (assetGcRequired && !assetGcScheduled) {
            return {
                status: "not_ready",
                database: "ready",
                observability,
                configuration: "not_ready",
                ...attestation,
                ...(result.version ? { version: result.version } : {}),
                failedChecks: ["configuration:remote_asset_cleanup_schedule"],
            };
        }
        if (assetGcRequired) {
            const jobStatus = await jobStatusProbe(env).catch(() => null);
            const assetGcReadiness = jobStatus
                ? evaluateAssetGcReadiness({
                    ...jobStatus,
                    now: new Date(),
                    expectedBuildSha: operationalRuntimeBuildSha(env),
                })
                : "missing";
            if (assetGcReadiness !== "ready") {
                return {
                    status: "not_ready",
                    database: "ready",
                    observability,
                    configuration: "not_ready",
                    ...attestation,
                    ...(result.version ? { version: result.version } : {}),
                    failedChecks: ["configuration:remote_asset_cleanup_heartbeat"],
                };
            }
        }
        if (observability !== "ready") return {
            status: "degraded",
            database: "ready",
            observability,
            configuration: "ready",
            ...attestation,
            ...(result.version ? { version: result.version } : {}),
        };
        return {
            status: "ready",
            database: "ready",
            observability: "ready",
            configuration: "ready",
            ...attestation,
            ...(result.version ? { version: result.version } : {}),
        };
    } catch {
        return { status: "not_ready", database: "probe_failed", observability: await sinkPromise, ...attestation };
    } finally {
        if (timer) clearTimeout(timer);
    }
}
