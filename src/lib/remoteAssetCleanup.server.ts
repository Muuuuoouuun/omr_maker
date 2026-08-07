import { timingSafeEqual } from "node:crypto";
import { REMOTE_ASSET_BUCKET } from "@/lib/remoteAssetContract.server";

type Env = Record<string, string | undefined>;

interface GatewayResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

export interface RemoteAssetCleanupGatewayClient {
    rpc(name: string, params: Record<string, unknown>): Promise<GatewayResult<unknown>>;
    storage: {
        from(bucket: string): {
            remove(paths: string[]): Promise<GatewayResult<unknown>>;
        };
    };
}

interface CleanupJob {
    id: string;
    attempts: number;
    storageBucket: typeof REMOTE_ASSET_BUCKET;
    objectPath: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function configuredSecret(env: Env): string {
    const secret = clean(env.CRON_SECRET);
    return secret.length >= 32 && secret.length <= 256 ? secret : "";
}

export function isRemoteAssetCleanupScheduled(env: Env = process.env): boolean {
    return clean(env.OMR_ASSET_GC_SCHEDULED) === "1" && !!configuredSecret(env);
}

export function authorizeRemoteAssetCleanupRequest(headers: Headers, env: Env = process.env): boolean {
    if (!isRemoteAssetCleanupScheduled(env)) return false;
    const expected = `Bearer ${configuredSecret(env)}`;
    const actual = clean(headers.get("authorization"));
    const expectedBytes = Buffer.from(expected);
    const actualBytes = Buffer.from(actual);
    return expectedBytes.byteLength === actualBytes.byteLength
        && timingSafeEqual(expectedBytes, actualBytes);
}

function cleanupJob(value: unknown): CleanupJob | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const id = clean(row.id);
    const attempts = Number(row.attempts);
    const storageBucket = clean(row.storage_bucket);
    const objectPath = clean(row.object_path);
    if (
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)
        || !Number.isInteger(attempts)
        || attempts < 1
        || !Number.isSafeInteger(attempts)
        || storageBucket !== REMOTE_ASSET_BUCKET
        || !objectPath.startsWith("organizations/")
        || objectPath.includes("..")
        || objectPath.includes("\\")
    ) return null;
    return { id, attempts, storageBucket: REMOTE_ASSET_BUCKET, objectPath };
}

async function failCleanup(
    client: RemoteAssetCleanupGatewayClient,
    workerId: string,
    cleanupId: string,
    expectedAttempt: number,
    errorCode: "invalid_claim" | "storage_delete_failed" | "ack_failed",
): Promise<boolean> {
    try {
        const failed = await client.rpc("omr_fail_remote_asset_cleanup_v1", {
            p_cleanup_id: cleanupId,
            p_worker_id: workerId,
            p_expected_attempt: expectedAttempt,
            p_error: errorCode,
        });
        return !failed.error && failed.data === true;
    } catch {
        return false;
    }
}

export async function runRemoteAssetCleanupWithGateway(
    client: RemoteAssetCleanupGatewayClient,
    input: { workerId: string; batchSize?: number; concurrency?: number },
): Promise<{ claimed: number; deleted: number; failed: number }> {
    const workerId = clean(input.workerId);
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(workerId)) {
        throw new Error("Invalid cleanup worker id");
    }
    const requested = Number.isFinite(input.batchSize) ? Math.floor(input.batchSize as number) : 20;
    const batchSize = Math.max(1, Math.min(25, requested));
    const requestedConcurrency = Number.isFinite(input.concurrency) ? Math.floor(input.concurrency as number) : 5;
    const concurrency = Math.max(1, Math.min(8, requestedConcurrency));
    const claim = await client.rpc("omr_claim_remote_asset_cleanup_v1", {
        p_worker_id: workerId,
        p_limit: batchSize,
    });
    if (claim.error || !Array.isArray(claim.data)) throw new Error("Remote asset cleanup claim failed");
    const claimedRows = claim.data;

    const processClaim = async (claimed: unknown): Promise<"deleted" | "failed"> => {
        const job = cleanupJob(claimed);
        if (!job) {
            const cleanupId = clean((claimed as { id?: unknown } | null)?.id);
            const expectedAttempt = Number((claimed as { attempts?: unknown } | null)?.attempts);
            if (cleanupId && Number.isInteger(expectedAttempt) && expectedAttempt > 0) {
                await failCleanup(client, workerId, cleanupId, expectedAttempt, "invalid_claim");
            }
            return "failed";
        }
        try {
            const authorization = await client.rpc("omr_authorize_remote_asset_cleanup_delete_v1", {
                p_cleanup_id: job.id,
                p_worker_id: workerId,
                p_expected_attempt: job.attempts,
            });
            if (authorization.error || authorization.data !== true) return "failed";
            const removal = await client.storage.from(job.storageBucket).remove([job.objectPath]);
            if (removal.error) {
                await failCleanup(client, workerId, job.id, job.attempts, "storage_delete_failed");
                return "failed";
            }
            const ack = await client.rpc("omr_ack_remote_asset_cleanup_v1", {
                p_cleanup_id: job.id,
                p_worker_id: workerId,
                p_expected_attempt: job.attempts,
            });
            if (ack.error || ack.data !== true) {
                await failCleanup(client, workerId, job.id, job.attempts, "ack_failed");
                return "failed";
            }
            return "deleted";
        } catch {
            await failCleanup(client, workerId, job.id, job.attempts, "storage_delete_failed");
            return "failed";
        }
    };

    const outcomes: Array<"deleted" | "failed"> = new Array(claimedRows.length);
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < claimedRows.length) {
            const index = nextIndex;
            nextIndex += 1;
            outcomes[index] = await processClaim(claimedRows[index]);
        }
    };
    await Promise.all(Array.from(
        { length: Math.min(concurrency, claimedRows.length) },
        () => worker(),
    ));
    const deleted = outcomes.filter(outcome => outcome === "deleted").length;
    const failed = outcomes.length - deleted;
    return { claimed: claimedRows.length, deleted, failed };
}

export async function drainRemoteAssetCleanupWithGateway(
    client: RemoteAssetCleanupGatewayClient,
    input: {
        workerId: string;
        batchSize?: number;
        maxBatches?: number;
        concurrency?: number;
        deadlineAtMs?: number;
        minimumBatchBudgetMs?: number;
        now?: () => number;
    },
): Promise<{ claimed: number; deleted: number; failed: number; batches: number }> {
    const requestedMaxBatches = Number.isFinite(input.maxBatches) ? Math.floor(input.maxBatches as number) : 1;
    const maxBatches = Math.max(1, Math.min(24, requestedMaxBatches));
    const requestedBatchSize = Number.isFinite(input.batchSize) ? Math.floor(input.batchSize as number) : 20;
    const batchSize = Math.max(1, Math.min(25, requestedBatchSize));
    const deadlineAtMs = Number.isFinite(input.deadlineAtMs) ? Math.floor(input.deadlineAtMs as number) : null;
    const requestedMinimumBudget = Number.isFinite(input.minimumBatchBudgetMs)
        ? Math.floor(input.minimumBatchBudgetMs as number)
        : 0;
    const minimumBatchBudgetMs = Math.max(0, Math.min(60_000, requestedMinimumBudget));
    const now = input.now || Date.now;
    let claimed = 0;
    let deleted = 0;
    let failed = 0;
    let batches = 0;
    for (; batches < maxBatches;) {
        if (deadlineAtMs !== null && now() + minimumBatchBudgetMs > deadlineAtMs) break;
        const result = await runRemoteAssetCleanupWithGateway(client, {
            workerId: input.workerId,
            batchSize,
            concurrency: input.concurrency,
        });
        batches += 1;
        claimed += result.claimed;
        deleted += result.deleted;
        failed += result.failed;
        if (result.claimed < batchSize) break;
    }
    return { claimed, deleted, failed, batches };
}
