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
    operationalRuntimeBuildSha,
    recordOperationalJobStatus,
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
            await recordOperationalJobStatus(client, {
                jobKey: "asset_gc",
                status: "failed",
                buildSha: operationalRuntimeBuildSha(),
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

    let persistedStatus: Awaited<ReturnType<typeof recordOperationalJobStatus>>;
    try {
        persistedStatus = await recordOperationalJobStatus(client, {
            jobKey: "asset_gc",
            status: result.failed > 0 ? "failed" : "healthy",
            buildSha: operationalRuntimeBuildSha(),
            failureCategory: result.failed > 0 ? "cleanup_failed" : null,
        });
    } catch (error) {
        await reportServerError("asset-gc", error);
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }

    const durableFailure = result.failed > 0
        || persistedStatus.status !== "healthy"
        || persistedStatus.deadCount !== 0;
    const heartbeat = await reportOperationalHeartbeat(
        "asset-gc",
        durableFailure ? "degraded" : "ok",
        result,
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
        ...result,
    }, {
        status: 200,
        headers: NO_STORE_HEADERS,
    });
}
