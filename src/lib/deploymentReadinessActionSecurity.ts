import { createHash } from "node:crypto";
import { isSameOriginServerActionRequest } from "./serverActionSecurity";
import { parseSignedTeacherSessionCookie } from "./teacherServerSession";

export const DEPLOYMENT_READINESS_MAX_REQUESTS = 12;
export const DEPLOYMENT_READINESS_WINDOW_MS = 60 * 1000;

export interface DeploymentReadinessRateLimitState {
    count: number;
    windowStartedAt: number;
}

export type DeploymentReadinessRateLimitStore = Map<string, DeploymentReadinessRateLimitState>;

const defaultDeploymentReadinessRateLimitStore: DeploymentReadinessRateLimitStore = new Map();

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function hash(value: string): string {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function clientFingerprintFromHeaders(headerStore: Headers): string {
    return headerStore.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headerStore.get("x-real-ip")?.trim()
        || headerStore.get("user-agent")?.trim()
        || "unknown-client";
}

export function buildDeploymentReadinessRateLimitKey(
    actor: unknown,
    clientFingerprint: unknown,
): string {
    const normalizedActor = clean(actor) || "unknown-teacher";
    const normalizedClient = clean(clientFingerprint) || "unknown-client";
    return `deployment-readiness:${hash(`${normalizedActor}:${normalizedClient}`)}`;
}

export function consumeDeploymentReadinessRateLimit(
    key: string,
    store: DeploymentReadinessRateLimitStore = defaultDeploymentReadinessRateLimitStore,
    now = Date.now(),
): boolean {
    const current = store.get(key);
    if (!current || now - current.windowStartedAt >= DEPLOYMENT_READINESS_WINDOW_MS) {
        store.set(key, { count: 1, windowStartedAt: now });
        return true;
    }
    if (current.count >= DEPLOYMENT_READINESS_MAX_REQUESTS) return false;

    store.set(key, { ...current, count: current.count + 1 });
    return true;
}

export function authorizeTeacherDeploymentReadinessRequest(
    headerStore: Headers,
    rawSessionCookie: string | null | undefined,
    env: Record<string, string | undefined> = process.env,
    store: DeploymentReadinessRateLimitStore = defaultDeploymentReadinessRateLimitStore,
    now = Date.now(),
): boolean {
    if (!isSameOriginServerActionRequest(headerStore)) return false;

    const session = parseSignedTeacherSessionCookie(rawSessionCookie, env, now);
    if (!session) return false;

    const key = buildDeploymentReadinessRateLimitKey(
        session.teacherId || session.email || session.displayName || session.token,
        clientFingerprintFromHeaders(headerStore),
    );
    return consumeDeploymentReadinessRateLimit(key, store, now);
}
