import { describe, expect, it, vi } from "vitest";
import {
    checkSharedLoginRateLimitWithClient,
    clearSharedLoginRateLimitWithClient,
    recordSharedLoginFailureWithClient,
} from "./sharedLoginRateLimit";

const options = { keys: ["one", "one", "two"], maxFailures: 5, windowMs: 600_000, lockoutMs: 600_000 };

describe("shared login rate limit gateway", () => {
    it("normalizes keys and parses a shared lock", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: { allowed: false, retry_after_ms: 1234.2 }, error: null });
        await expect(checkSharedLoginRateLimitWithClient({ rpc }, options)).resolves.toEqual({ allowed: false, retryAfterMs: 1235 });
        expect(rpc).toHaveBeenCalledWith("omr_check_login_rate_limit_v1", {
            p_keys: ["one", "two"],
            p_window_seconds: 600,
        });
    });

    it("records failures and clears successful identities", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: {}, error: null });
        await expect(recordSharedLoginFailureWithClient({ rpc }, options)).resolves.toBe(true);
        await expect(clearSharedLoginRateLimitWithClient({ rpc }, options.keys)).resolves.toBe(true);
        expect(rpc).toHaveBeenNthCalledWith(1, "omr_record_login_failure_v1", {
            p_keys: ["one", "two"],
            p_max_failures: 5,
            p_window_seconds: 600,
            p_lockout_seconds: 600,
        });
        expect(rpc).toHaveBeenNthCalledWith(2, "omr_clear_login_rate_limit_v1", { p_keys: ["one", "two"] });
    });

    it("returns a fallback signal when the shared store is unavailable", async () => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "missing function" } });
        await expect(checkSharedLoginRateLimitWithClient({ rpc }, options)).resolves.toBeNull();
        await expect(recordSharedLoginFailureWithClient({ rpc }, options)).resolves.toBe(false);
    });
});
