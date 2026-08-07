import { createHmac } from "node:crypto";
import type { TeacherAccountTokenPurpose } from "./teacherAccountLifecycle";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;
const DELIVERY_TIMEOUT_MS = 10_000;
const DELIVERY_RESPONSE_MAX_BYTES = 4_096;

export interface TeacherAccountDeliveryInput {
    purpose: TeacherAccountTokenPurpose;
    email: string;
    token: string;
    expiresAt: number;
}

export interface TeacherAccountDeliveryAdapter {
    deliver(input: TeacherAccountDeliveryInput): Promise<{ accepted: boolean }>;
}

export type TeacherAccountDeliveryReadiness =
    | "ready"
    | "not_configured"
    | "invalid_configuration"
    | "probe_failed"
    | "probe_timeout";

function deliveryWebhookConfiguration(env: Env): { url: string; secret: string } | null {
    const urlRaw = env.OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL?.trim() || "";
    const secret = env.OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET || "";
    if (!urlRaw && !secret) return null;
    let url: URL;
    try {
        url = new URL(urlRaw);
    } catch {
        throw new Error("Teacher account delivery webhook configuration is invalid");
    }
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.hash
        || url.href.length > 2_048
        || Buffer.byteLength(secret, "utf8") < 32
        || Buffer.byteLength(secret, "utf8") > 512
        || /\s/.test(secret)
    ) throw new Error("Teacher account delivery webhook configuration is invalid");
    return { url: url.href, secret };
}

async function readBoundedResponse(response: Response): Promise<Record<string, unknown> | null> {
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > DELIVERY_RESPONSE_MAX_BYTES) return null;
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > DELIVERY_RESPONSE_MAX_BYTES) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
        }
        const parsed = JSON.parse(new TextDecoder().decode(bytes));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

export function resolveTeacherAccountDeliveryAdapter(
    env: Env = process.env,
): TeacherAccountDeliveryAdapter | null {
    const configuration = deliveryWebhookConfiguration(env);
    if (!configuration) return null;
    return {
        async deliver(input) {
            const timestamp = String(Date.now());
            const body = JSON.stringify({ schemaVersion: 1, ...input });
            const signature = createHmac("sha256", configuration.secret)
                .update(`${timestamp}.${body}`, "utf8")
                .digest("hex");
            const response = await fetch(configuration.url, {
                method: "POST",
                redirect: "error",
                cache: "no-store",
                signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
                headers: {
                    "content-type": "application/json",
                    "accept": "application/json",
                    "x-omr-delivery-timestamp": timestamp,
                    "x-omr-signature-version": "v1",
                    "x-omr-signature": `sha256=${signature}`,
                },
                body,
            });
            if (!response.ok || !response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
                return { accepted: false };
            }
            const result = await readBoundedResponse(response);
            return { accepted: result?.accepted === true };
        },
    };
}

export async function probeTeacherAccountDelivery(
    env: Env = process.env,
    fetchImpl: FetchLike = fetch,
    timeoutMs = 1_500,
): Promise<TeacherAccountDeliveryReadiness> {
    let configuration: ReturnType<typeof deliveryWebhookConfiguration>;
    try {
        configuration = deliveryWebhookConfiguration(env);
    } catch {
        return "invalid_configuration";
    }
    if (!configuration) return "not_configured";

    const controller = new AbortController();
    const boundedTimeoutMs = Math.max(100, Math.min(5_000, Math.trunc(timeoutMs)));
    const timer = setTimeout(() => controller.abort(new DOMException("Delivery probe timed out", "TimeoutError")), boundedTimeoutMs);
    try {
        const timestamp = String(Date.now());
        const signature = createHmac("sha256", configuration.secret)
            .update(`${timestamp}.readiness`, "utf8")
            .digest("hex");
        const response = await fetchImpl(configuration.url, {
            method: "HEAD",
            body: undefined,
            redirect: "error",
            cache: "no-store",
            credentials: "omit",
            signal: controller.signal,
            headers: {
                "x-omr-delivery-probe": "readiness",
                "x-omr-delivery-timestamp": timestamp,
                "x-omr-signature-version": "v1",
                "x-omr-signature": `sha256=${signature}`,
            },
        });
        return response.ok ? "ready" : "probe_failed";
    } catch {
        return controller.signal.aborted ? "probe_timeout" : "probe_failed";
    } finally {
        clearTimeout(timer);
    }
}

export async function deliverTeacherAccountToken(
    input: TeacherAccountDeliveryInput,
    adapter: TeacherAccountDeliveryAdapter | null = resolveTeacherAccountDeliveryAdapter(),
): Promise<{ status: "delivered" | "unavailable" | "rejected" }> {
    if (!adapter) return { status: "unavailable" };
    try {
        const result = await adapter.deliver(input);
        return { status: result.accepted ? "delivered" : "rejected" };
    } catch {
        return { status: "rejected" };
    }
}
