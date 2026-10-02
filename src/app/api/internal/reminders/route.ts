import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { authorizeReminderCron, solapiConfig } from "@/lib/solapiProvider.server";
import { runReminderWorker, type ReminderRpcClient } from "@/lib/solapiReminderWorker.server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
    const respond = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    if (!authorizeReminderCron(request.headers)) return respond({ status: "unauthorized" }, 401);
    const config = solapiConfig();
    if (config.mode === "disabled") return respond({ status: "disabled" });
    const database = getSupabaseServerConfigFromEnv();
    if (!database) return respond({ status: "service_unavailable" }, 503);
    try {
        const result = await runReminderWorker(createSupabaseAdminClient({ ...database, backendTimeoutMs: 5000 }) as unknown as ReminderRpcClient, config);
        return respond(result, result.status === "configuration_required" || result.status === "degraded" ? 503 : 200);
    } catch {
        // Provider response bodies and contacts must never be returned to the scheduler or logs.
        return respond({ status: "service_unavailable" }, 503);
    }
}
