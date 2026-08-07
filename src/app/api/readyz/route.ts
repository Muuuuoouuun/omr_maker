import {
    authorizeReadinessRequest,
    probeOperationalReadiness,
} from "@/lib/operationsHealth";

export const dynamic = "force-dynamic";

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

export async function GET(request: Request): Promise<Response> {
    if (!authorizeReadinessRequest(request.headers)) {
        return Response.json({ status: "unauthorized" }, {
            status: 401,
            headers: NO_STORE_HEADERS,
        });
    }

    const result = await probeOperationalReadiness();
    return Response.json(result, {
        status: result.status === "not_ready" ? 503 : 200,
        headers: NO_STORE_HEADERS,
    });
}
