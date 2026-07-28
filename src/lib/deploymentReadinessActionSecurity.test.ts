import { describe, expect, it } from "vitest";
import {
    buildDeploymentReadinessRateLimitKey,
    consumeDeploymentReadinessRateLimit,
    DEPLOYMENT_READINESS_MAX_REQUESTS,
    DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES,
    DEPLOYMENT_READINESS_WINDOW_MS,
    type DeploymentReadinessRateLimitStore,
} from "./deploymentReadinessActionSecurity";

describe("deployment readiness action rate limiting", () => {
    it("hashes private signed-actor identity data into a fixed PII-free key", () => {
        const privateActor = "Private.Teacher+readiness@example.com";

        const key = buildDeploymentReadinessRateLimitKey(privateActor);

        expect(key).toMatch(/^deployment-readiness:[a-f0-9]{64}$/);
        expect(key).not.toContain("private.teacher");
        expect(key).not.toContain("example.com");
    });

    it("starts a fresh bounded window after the actor window expires", () => {
        const store: DeploymentReadinessRateLimitStore = new Map();
        const key = buildDeploymentReadinessRateLimitKey("teacher-window");

        for (let request = 0; request < DEPLOYMENT_READINESS_MAX_REQUESTS; request += 1) {
            expect(consumeDeploymentReadinessRateLimit(key, store, 1_000)).toBe(true);
        }
        expect(consumeDeploymentReadinessRateLimit(key, store, 1_000)).toBe(false);

        expect(consumeDeploymentReadinessRateLimit(
            key,
            store,
            1_000 + DEPLOYMENT_READINESS_WINDOW_MS,
        )).toBe(true);
        expect(store.get(key)).toEqual({
            count: 1,
            windowStartedAt: 1_000 + DEPLOYMENT_READINESS_WINDOW_MS,
        });
    });

    it("prunes expired actors whenever another actor consumes the limiter", () => {
        const now = DEPLOYMENT_READINESS_WINDOW_MS * 4;
        const store: DeploymentReadinessRateLimitStore = new Map([
            ["expired-a", { count: 1, windowStartedAt: now - DEPLOYMENT_READINESS_WINDOW_MS }],
            ["expired-b", { count: 2, windowStartedAt: 0 }],
            ["active", { count: 3, windowStartedAt: now - DEPLOYMENT_READINESS_WINDOW_MS + 1 }],
        ]);

        expect(consumeDeploymentReadinessRateLimit("new-actor", store, now)).toBe(true);

        expect(store.has("expired-a")).toBe(false);
        expect(store.has("expired-b")).toBe(false);
        expect(store.has("active")).toBe(true);
        expect(store.has("new-actor")).toBe(true);
    });

    it("caps the in-memory actor map and evicts the oldest live window", () => {
        const store: DeploymentReadinessRateLimitStore = new Map();
        consumeDeploymentReadinessRateLimit("oldest-actor", store, 1_000);

        for (let actor = 1; actor < DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES; actor += 1) {
            consumeDeploymentReadinessRateLimit(`actor-${actor}`, store, 1_000 + actor);
        }
        expect(store.size).toBe(DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES);

        expect(consumeDeploymentReadinessRateLimit(
            "newest-actor",
            store,
            1_000 + DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES,
        )).toBe(true);

        expect(store.size).toBe(DEPLOYMENT_READINESS_RATE_LIMIT_MAX_ENTRIES);
        expect(store.has("oldest-actor")).toBe(false);
        expect(store.has("newest-actor")).toBe(true);
    });
});
