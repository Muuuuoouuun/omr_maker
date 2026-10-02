import { randomUUID } from "node:crypto";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    authorizeRemoteAssetCleanupRequest,
    drainRemoteAssetCleanupWithGateway,
    type RemoteAssetCleanupGatewayClient,
} from "@/lib/remoteAssetCleanup.server";
import { reportOperationalHeartbeat, reportServerError } from "@/lib/reportServerError";
import {
    beginOperationalJobRun,
    completeOperationalJobRun,
    operationalRuntimeBuildSha,
    type OperationalJobStatusGatewayClient,
} from "@/lib/operationalJobStatusGateway.server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
    if (!authorizeRemoteAssetCleanupRequest(request.headers)) {
        return Response.json({ status: "unauthorized" }, {
            status: 401,
            headers: NO_STORE_HEADERS,
        });
    }
    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }
    const cleanupConfig = {
        ...config,
        backendTimeoutMs: Math.min(config.backendTimeoutMs, 10_000),
    };
    const client = createSupabaseAdminClient(cleanupConfig) as unknown as
        RemoteAssetCleanupGatewayClient & OperationalJobStatusGatewayClient;
    const buildSha = operationalRuntimeBuildSha();
    let runSequence: number;
    try {
        const begun = await beginOperationalJobRun(client, {
            jobKey: "asset_gc",
            buildSha,
        });
        if (!begun.admitted) {
            return Response.json({ status: "unavailable" }, {
                status: 503,
                headers: NO_STORE_HEADERS,
            });
        }
        runSequence = begun.runSequence;
    } catch (error) {
        await reportServerError("asset-gc", error);
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }
    let result: Awaited<ReturnType<typeof drainRemoteAssetCleanupWithGateway>>;
    try {
        result = await drainRemoteAssetCleanupWithGateway(
            client,
            {
                workerId: `gc-${randomUUID()}`,
                batchSize: 25,
                maxBatches: 4,
                concurrency: 5,
                deadlineAtMs: Date.now() + 55_000,
                minimumBatchBudgetMs: 30_000,
            },
        );
    } catch (error) {
        try {
            await completeOperationalJobRun(client, {
                jobKey: "asset_gc",
                runSequence,
                status: "failed",
                buildSha,
                failureCategory: "cleanup_exception",
            });
        } catch {
            // Readiness remains failed closed when the durable heartbeat cannot be written.
        }
        await reportServerError("asset-gc", error);
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }

    const sweepIncomplete = result.claimAttempts < 1;
    let persistedStatus: Awaited<ReturnType<typeof completeOperationalJobRun>>;
    try {
        persistedStatus = await completeOperationalJobRun(client, {
            jobKey: "asset_gc",
            runSequence,
            status: result.failed > 0 || sweepIncomplete ? "failed" : "healthy",
            buildSha,
            failureCategory: result.failed > 0
                ? "cleanup_failed"
                : sweepIncomplete ? "sweep_not_completed" : null,
        });
    } catch (error) {
        await reportServerError("asset-gc", error);
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }

    const durableFailure = result.failed > 0
        || sweepIncomplete
        || persistedStatus.status !== "healthy"
        || persistedStatus.deadCount !== 0;
    const proof = {
        ...result,
        runSequence,
        applied: persistedStatus.applied,
        superseded: persistedStatus.superseded,
        duplicate: persistedStatus.duplicate,
    };
    const heartbeat = await reportOperationalHeartbeat(
        "asset-gc",
        durableFailure ? "degraded" : "ok",
        proof,
    ).catch(() => ({ status: "rejected" as const }));
    if (durableFailure) {
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }
    return Response.json({
        status: "ok",
        observability: heartbeat.status === "delivered" ? "ready" : "degraded",
        ...proof,
        durableStatus: persistedStatus.status,
        deadCount: persistedStatus.deadCount,
    }, {
        status: 200,
        headers: NO_STORE_HEADERS,
    });
}
