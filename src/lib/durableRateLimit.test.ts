import { describe, expect, it } from "vitest";
import {
    applyDurableRateLimit,
    createInMemoryDurableRateLimitStore,
    hashRateLimitBucket,
    type DurableRateLimitRpcClient,
} from "./durableRateLimit";

const policy = { limit: 2, windowMs: 60_000, lockoutMs: 30_000 };

describe("durableRateLimit", () => {
    it("uses a keyed hash and never returns the source subject", () => {
        const bucket = hashRateLimitBucket("test-rate-limit-secret", "teacher-login", "teacher@example.test:203.0.113.8");

        expect(bucket).toMatch(/^[a-f0-9]{64}$/);
        expect(bucket).not.toContain("teacher@example.test");
        expect(bucket).not.toContain("203.0.113.8");
        expect(bucket).not.toBe(hashRateLimitBucket("other-secret", "teacher-login", "teacher@example.test:203.0.113.8"));
    });

    it("uses the RPC atomically when a service-role client is available", async () => {
        const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
        const client: DurableRateLimitRpcClient = {
            rpc: async (name, params) => {
                calls.push({ name, params });
                return { data: { allowed: true, retry_after_ms: 0 }, error: null };
            },
        };

        await expect(applyDurableRateLimit({
            namespace: "ai-answer",
            subject: "already-safe-subject",
            operation: "consume",
            policy,
        }, {
            env: { NODE_ENV: "production", OMR_RATE_LIMIT_HASH_SECRET: "test-rate-limit-secret-at-least-32-bytes" },
            client,
        })).resolves.toEqual({ allowed: true, retryAfterMs: 0 });

        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ name: "omr_consume_rate_limit_v1" });
        expect(calls[0]?.params.p_bucket_hash).toMatch(/^[a-f0-9]{64}$/);
        expect(JSON.stringify(calls[0])).not.toContain("already-safe-subject");
    });

    it("fails closed in production when the hash secret or RPC is unavailable", async () => {
        await expect(applyDurableRateLimit({ namespace: "ai-answer", subject: "safe", operation: "consume", policy }, {
            env: { NODE_ENV: "production" },
            client: null,
        })).resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });

        await expect(applyDurableRateLimit({ namespace: "ai-answer", subject: "safe", operation: "consume", policy }, {
            env: { NODE_ENV: "production", OMR_RATE_LIMIT_HASH_SECRET: "too-short" },
            client: { rpc: async () => ({ data: { allowed: true, retry_after_ms: 0 }, error: null }) },
        })).resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });

        await expect(applyDurableRateLimit({ namespace: "ai-answer", subject: "safe", operation: "consume", policy }, {
            env: { NODE_ENV: "production", OMR_RATE_LIMIT_HASH_SECRET: "test-rate-limit-secret-at-least-32-bytes" },
            client: { rpc: async () => ({ data: null, error: { message: "missing rpc" } }) },
        })).resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });
    });

    it("permits a bounded local fallback and preserves consume, failure, and success semantics", async () => {
        const store = createInMemoryDurableRateLimitStore(2);
        const options = { env: { NODE_ENV: "development" }, store, now: 1_000 };

        await expect(applyDurableRateLimit({ namespace: "local", subject: "one", operation: "consume", policy }, options)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
        await expect(applyDurableRateLimit({ namespace: "local", subject: "one", operation: "consume", policy }, options)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
        await expect(applyDurableRateLimit({ namespace: "local", subject: "one", operation: "consume", policy }, options)).resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });

        await applyDurableRateLimit({ namespace: "login", subject: "one", operation: "failure", policy }, options);
        await applyDurableRateLimit({ namespace: "login", subject: "one", operation: "failure", policy }, options);
        await expect(applyDurableRateLimit({ namespace: "login", subject: "one", operation: "check", policy }, options)).resolves.toEqual({ allowed: false, retryAfterMs: 30_000 });
        await expect(applyDurableRateLimit({ namespace: "login", subject: "one", operation: "success", policy }, options)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
        await expect(applyDurableRateLimit({ namespace: "login", subject: "one", operation: "check", policy }, options)).resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    });

    it("refunds exactly one reservation without clearing another active reservation", async () => {
        const store = createInMemoryDurableRateLimitStore();
        const options = { env: { NODE_ENV: "development" }, store, now: 1_000 };

        await applyDurableRateLimit({ namespace: "pin", subject: "exam", operation: "consume", policy }, options);
        await applyDurableRateLimit({ namespace: "pin", subject: "exam", operation: "consume", policy }, options);
        await expect(applyDurableRateLimit({ namespace: "pin", subject: "exam", operation: "refund", policy }, options))
            .resolves.toEqual({ allowed: true, retryAfterMs: 0 });

        await expect(applyDurableRateLimit({ namespace: "pin", subject: "exam", operation: "consume", policy }, options))
            .resolves.toEqual({ allowed: true, retryAfterMs: 0 });
        await expect(applyDurableRateLimit({ namespace: "pin", subject: "exam", operation: "consume", policy }, options))
            .resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });
    });

    it("preserves an active lock while refunding one count and deletes the bucket at zero", async () => {
        const store = createInMemoryDurableRateLimitStore();
        const options = { env: { NODE_ENV: "development" }, store, now: 1_000 };

        await applyDurableRateLimit({ namespace: "locked", subject: "actor", operation: "failure", policy }, options);
        await applyDurableRateLimit({ namespace: "locked", subject: "actor", operation: "failure", policy }, options);
        await expect(applyDurableRateLimit({ namespace: "locked", subject: "actor", operation: "refund", policy }, options))
            .resolves.toEqual({ allowed: true, retryAfterMs: 0 });
        await expect(applyDurableRateLimit({ namespace: "locked", subject: "actor", operation: "check", policy }, options))
            .resolves.toEqual({ allowed: false, retryAfterMs: 30_000 });

        await applyDurableRateLimit({ namespace: "locked", subject: "actor", operation: "refund", policy }, options);
        await expect(applyDurableRateLimit({ namespace: "locked", subject: "actor", operation: "check", policy }, options))
            .resolves.toEqual({ allowed: true, retryAfterMs: 0 });
    });

    it("does not evict a bucket while updating that same local bucket", async () => {
        const store = createInMemoryDurableRateLimitStore(1);
        const options = { env: { NODE_ENV: "development" }, store, now: 1_000 };

        await applyDurableRateLimit({ namespace: "local", subject: "one", operation: "consume", policy }, options);
        await applyDurableRateLimit({ namespace: "local", subject: "one", operation: "consume", policy }, options);
        await expect(applyDurableRateLimit({ namespace: "local", subject: "one", operation: "consume", policy }, options))
            .resolves.toEqual({ allowed: false, retryAfterMs: 60_000 });
    });

    it("atomically reserves only the configured number of concurrent attempts", async () => {
        const store = createInMemoryDurableRateLimitStore();
        const decisions = await Promise.all(Array.from({ length: 8 }, () => applyDurableRateLimit({
            namespace: "teacher-login",
            subject: "already-safe-subject",
            operation: "consume",
            policy: { limit: 3, windowMs: 60_000 },
        }, { env: { NODE_ENV: "development" }, store, now: 1_000 })));

        expect(decisions.filter(decision => decision.allowed)).toHaveLength(3);
        expect(decisions.filter(decision => !decision.allowed)).toEqual(
            Array.from({ length: 5 }, () => ({ allowed: false, retryAfterMs: 60_000 })),
        );
    });
});
