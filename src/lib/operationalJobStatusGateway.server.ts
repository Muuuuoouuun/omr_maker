import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "./supabaseServerAdmin";

type Env = Record<string, string | undefined>;

export type OperationalJobStatus = {
    status: "healthy" | "failed";
    lastAttemptAt: string;
    lastSuccessAt: string | null;
    deadCount: number;
    buildSha: string;
    failureCategory: string | null;
    latestStartedSequence: number;
    latestCompletedSequence: number | null;
};

export type OperationalJobRunCompletion = OperationalJobStatus & {
    runSequence: number;
    applied: boolean;
    superseded: boolean;
};

export type OperationalJobRunBegin =
    | { admitted: true; busy: false; runSequence: number }
    | { admitted: false; busy: true; runSequence: null };

export interface OperationalJobStatusGatewayClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export type AssetGcReadiness =
    | "ready"
    | "missing"
    | "failed"
    | "stale"
    | "dead_items"
    | "build_mismatch"
    | "incomplete"
    | "malformed";

const BUILD_SHA_PATTERN = /^[a-f0-9]{40}$/;
const FAILURE_CATEGORY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DEAD_COUNT = 1_000_000;
const ASSET_GC_MAX_AGE_MS = 30 * 60 * 60 * 1_000;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizedTimestamp(value: unknown): string | null {
    const candidate = clean(value);
    if (!candidate) return null;
    const parsed = new Date(candidate);
    if (!Number.isFinite(parsed.getTime())) return null;
    return parsed.toISOString();
}

function normalizedBuildSha(value: unknown): string {
    const candidate = clean(value).toLowerCase();
    return BUILD_SHA_PATTERN.test(candidate) ? candidate : "";
}

function normalizedFailureCategory(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const candidate = clean(value);
    return FAILURE_CATEGORY_PATTERN.test(candidate) ? candidate : null;
}

function parseOperationalJobStatus(value: unknown): OperationalJobStatus | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const status = row.status;
    const lastAttemptAt = normalizedTimestamp(row.lastAttemptAt);
    const lastSuccessAt = row.lastSuccessAt === null
        ? null
        : normalizedTimestamp(row.lastSuccessAt);
    const deadCount = row.deadCount;
    const buildSha = normalizedBuildSha(row.buildSha);
    const failureCategory = normalizedFailureCategory(row.failureCategory);
    const latestStartedSequence = row.latestStartedSequence;
    const latestCompletedSequence = row.latestCompletedSequence;
    if (
        (status !== "healthy" && status !== "failed")
        || !lastAttemptAt
        || (row.lastSuccessAt !== null && !lastSuccessAt)
        || !Number.isSafeInteger(deadCount)
        || (deadCount as number) < 0
        || (deadCount as number) > MAX_DEAD_COUNT
        || !buildSha
        || !Number.isSafeInteger(latestStartedSequence)
        || (latestStartedSequence as number) <= 0
        || (latestCompletedSequence !== null && (
            !Number.isSafeInteger(latestCompletedSequence)
            || (latestCompletedSequence as number) <= 0
            || (latestCompletedSequence as number) > (latestStartedSequence as number)
        ))
        || (status === "healthy" && (!lastSuccessAt || failureCategory !== null))
        || (status === "healthy" && latestCompletedSequence !== latestStartedSequence)
        || (status === "failed" && failureCategory === null)
        || (lastSuccessAt !== null && Date.parse(lastSuccessAt) > Date.parse(lastAttemptAt))
    ) return null;
    return {
        status,
        lastAttemptAt,
        lastSuccessAt,
        deadCount: deadCount as number,
        buildSha,
        failureCategory,
        latestStartedSequence: latestStartedSequence as number,
        latestCompletedSequence: latestCompletedSequence as number | null,
    };
}

function validJobKey(value: unknown): value is "asset_gc" {
    return value === "asset_gc";
}

export function operationalRuntimeBuildSha(env: Env = process.env): string {
    return normalizedBuildSha(env.VERCEL_GIT_COMMIT_SHA)
        || normalizedBuildSha(env.GIT_SHA);
}

export async function readOperationalJobStatus(
    client: OperationalJobStatusGatewayClient,
    jobKey: "asset_gc",
): Promise<OperationalJobStatus | null> {
    if (!validJobKey(jobKey)) throw new Error("Operational job status read failed");
    try {
        const result = await client.rpc("omr_read_operational_job_status_v1", {
            p_job_key: jobKey,
        });
        if (result.error) throw new Error("rpc failed");
        if (result.data === null) return null;
        const parsed = parseOperationalJobStatus(result.data);
        if (!parsed) throw new Error("invalid row");
        return parsed;
    } catch {
        throw new Error("Operational job status read failed");
    }
}

export async function readOperationalJobStatusWithServiceRole(
    env: Env = process.env,
): Promise<OperationalJobStatus | null> {
    const config = getSupabaseServerConfigFromEnv(env);
    if (!config) return null;
    return readOperationalJobStatus(
        createSupabaseAdminClient(config) as unknown as OperationalJobStatusGatewayClient,
        "asset_gc",
    );
}

export async function beginOperationalJobRun(
    client: OperationalJobStatusGatewayClient,
    input: {
        jobKey: "asset_gc";
        buildSha: string;
    },
): Promise<OperationalJobRunBegin> {
    const buildSha = normalizedBuildSha(input.buildSha);
    if (!validJobKey(input.jobKey) || !buildSha) throw new Error("Invalid operational job run");

    try {
        const result = await client.rpc("omr_begin_operational_job_run_v1", {
            p_job_key: input.jobKey,
            p_build_sha: buildSha,
        });
        if (result.error) throw new Error("rpc failed");
        if (!result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
            throw new Error("invalid result");
        }
        const row = result.data as Record<string, unknown>;
        if (row.admitted === false && row.busy === true && row.runSequence === null) {
            return { admitted: false, busy: true, runSequence: null };
        }
        const runSequence = row.runSequence;
        if (
            row.admitted !== true
            || row.busy !== false
            || !Number.isSafeInteger(runSequence)
            || (runSequence as number) <= 0
        ) throw new Error("invalid result");
        return { admitted: true, busy: false, runSequence: runSequence as number };
    } catch {
        throw new Error("Operational job run begin failed");
    }
}

export async function completeOperationalJobRun(
    client: OperationalJobStatusGatewayClient,
    input: {
        jobKey: "asset_gc";
        runSequence: number;
        status: "healthy" | "failed";
        buildSha: string;
        failureCategory: string | null;
    },
): Promise<OperationalJobRunCompletion> {
    const buildSha = normalizedBuildSha(input.buildSha);
    const failureCategory = normalizedFailureCategory(input.failureCategory);
    if (
        !validJobKey(input.jobKey)
        || !Number.isSafeInteger(input.runSequence)
        || input.runSequence <= 0
        || (input.status !== "healthy" && input.status !== "failed")
        || !buildSha
        || (input.status === "healthy" && input.failureCategory !== null)
        || (input.status === "failed" && failureCategory === null)
    ) throw new Error("Invalid operational job status");

    try {
        const result = await client.rpc("omr_complete_operational_job_run_v1", {
            p_job_key: input.jobKey,
            p_run_sequence: input.runSequence,
            p_status: input.status,
            p_build_sha: buildSha,
            p_failure_category: failureCategory,
        });
        if (result.error || !result.data || typeof result.data !== "object" || Array.isArray(result.data)) {
            throw new Error("rpc failed");
        }
        const row = result.data as Record<string, unknown>;
        const persisted = parseOperationalJobStatus(row);
        if (
            !persisted
            || row.runSequence !== input.runSequence
            || typeof row.applied !== "boolean"
            || typeof row.superseded !== "boolean"
            || row.applied === row.superseded
        ) throw new Error("invalid row");
        return {
            ...persisted,
            runSequence: input.runSequence,
            applied: row.applied,
            superseded: row.superseded,
        };
    } catch {
        throw new Error("Operational job run completion failed");
    }
}

export function evaluateAssetGcReadiness(
    input: OperationalJobStatus & { now: Date; expectedBuildSha: string },
): AssetGcReadiness {
    const expectedBuildSha = normalizedBuildSha(input.expectedBuildSha);
    const parsed = parseOperationalJobStatus(input);
    if (!parsed || !Number.isFinite(input.now.getTime())) return "malformed";
    if (!expectedBuildSha || parsed.buildSha !== expectedBuildSha) return "build_mismatch";
    if (parsed.latestCompletedSequence !== parsed.latestStartedSequence) return "incomplete";
    if (parsed.status !== "healthy") return "failed";
    if (parsed.deadCount !== 0) return "dead_items";
    if (!parsed.lastSuccessAt) return "missing";
    return input.now.getTime() - Date.parse(parsed.lastSuccessAt) <= ASSET_GC_MAX_AGE_MS
        ? "ready"
        : "stale";
}
