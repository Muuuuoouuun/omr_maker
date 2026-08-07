import "next/dist/compiled/server-only";
import { after } from "next/server";
import {
    buildOperationalHeartbeatEvent,
    emitOperationalErrorEvent,
} from "./reportError";
import {
    deliverOperationalEvent,
    type OperationalSinkDeliveryStatus,
} from "./operationalEventSink.server";

export async function reportServerError(
    context: string,
    error: unknown,
): Promise<{ status: "scheduled" | "schedule_failed" }> {
    const event = emitOperationalErrorEvent(context, error);
    try {
        after(async () => {
            await deliverOperationalEvent(event, process.env, fetch, 250);
        });
        return { status: "scheduled" };
    } catch {
        const fallback = await deliverOperationalEvent(event, process.env, fetch, 250);
        return { status: fallback.status === "delivered" ? "scheduled" : "schedule_failed" };
    }
}

export async function reportOperationalHeartbeat(
    job: string,
    status: "ok" | "degraded",
    metrics: Record<string, unknown> = {},
): Promise<{ status: OperationalSinkDeliveryStatus }> {
    const event = buildOperationalHeartbeatEvent(job, status, metrics);
    try {
        console.info(JSON.stringify(event));
    } catch {
        // Console output is best-effort; central delivery remains authoritative.
    }
    try {
        return await deliverOperationalEvent(event);
    } catch {
        return { status: "failed" };
    }
}
