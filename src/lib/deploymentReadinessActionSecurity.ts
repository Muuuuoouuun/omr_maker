import { createHash } from "node:crypto";
import type { TeacherSession } from "./teacherSession";

export const DEPLOYMENT_READINESS_MAX_REQUESTS = 12;
export const DEPLOYMENT_READINESS_WINDOW_MS = 60 * 1000;
export const DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES = 1024;

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

export function buildDeploymentReadinessRateLimitKey(actor: unknown): string {
    const normalizedActor = clean(actor) || "unknown-teacher";
    return `deployment-readiness:${hash(normalizedActor)}`;
}

function pruneExpiredDeploymentReadinessRateLimits(
    store: DeploymentReadinessRateLimitStore,
    now: number,
): void {
    for (const [key, state] of store) {
        if (now - state.windowStartedAt >= DEPLOYMENT_READINESS_WINDOW_MS) {
            store.delete(key);
        }
    }
}

function evictOldestDeploymentReadinessRateLimit(
    store: DeploymentReadinessRateLimitStore,
): void {
    let oldestKey: string | undefined;
    let oldestWindowStartedAt = Number.POSITIVE_INFINITY;
    for (const [key, state] of store) {
        if (state.windowStartedAt < oldestWindowStartedAt) {
            oldestKey = key;
            oldestWindowStartedAt = state.windowStartedAt;
        }
    }
    if (oldestKey) store.delete(oldestKey);
}

export function consumeDeploymentReadinessRateLimit(
    key: string,
    store: DeploymentReadinessRateLimitStore = defaultDeploymentReadinessRateLimitStore,
    now = Date.now(),
): boolean {
    pruneExpiredDeploymentReadinessRateLimits(store, now);

    const current = store.get(key);
    if (!current) {
        if (store.size >= DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES) {
            evictOldestDeploymentReadinessRateLimit(store);
        }
        store.set(key, { count: 1, windowStartedAt: now });
        return true;
    }
    if (current.count >= DEPLOYMENT_READINESS_MAX_REQUESTS) return false;

    store.set(key, { ...current, count: current.count + 1 });
    return true;
}

export function consumeTeacherDeploymentReadinessRateLimit(
    session: TeacherSession,
    store: DeploymentReadinessRateLimitStore = defaultDeploymentReadinessRateLimitStore,
    now = Date.now(),
): boolean {
    const key = buildDeploymentReadinessRateLimitKey(
        session.teacherId || session.email || session.displayName || session.token,
    );
    return consumeDeploymentReadinessRateLimit(key, store, now);
}
