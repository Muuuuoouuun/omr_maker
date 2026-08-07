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
    try {
        const cleanupConfig = {
            ...config,
            backendTimeoutMs: Math.min(config.backendTimeoutMs, 10_000),
        };
        const result = await drainRemoteAssetCleanupWithGateway(
            createSupabaseAdminClient(cleanupConfig) as unknown as RemoteAssetCleanupGatewayClient,
            {
                workerId: `gc-${randomUUID()}`,
                batchSize: 25,
                maxBatches: 4,
                concurrency: 5,
                deadlineAtMs: Date.now() + 55_000,
                minimumBatchBudgetMs: 30_000,
            },
        );
        const heartbeat = await reportOperationalHeartbeat(
            "asset-gc",
            result.failed > 0 ? "degraded" : "ok",
            result,
        );
        if (result.failed > 0) {
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
    } catch (error) {
        await reportServerError("asset-gc", error);
        return Response.json({ status: "unavailable" }, {
            status: 503,
            headers: NO_STORE_HEADERS,
        });
    }
}
