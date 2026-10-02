import { buildLivenessPayload } from "@/lib/operationsHealth";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    return Response.json(buildLivenessPayload(), {
        status: 200,
        headers: { "Cache-Control": "no-store" },
    });
}
