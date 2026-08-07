import { beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    sameOrigin: true,
    adminClientCalls: 0,
    durableCalls: 0,
    deliveryAvailable: false,
    deliveryStatuses: [] as Array<"delivered" | "rejected">,
    deliveredTokens: [] as Array<{ email: string; token: string }>,
    signupRpcResults: [] as boolean[],
}));

vi.mock("next/headers", () => ({
    headers: async () => new Headers({ origin: "http://localhost:3003", host: "localhost:3003" }),
}));

vi.mock("@/lib/serverActionSecurity", () => ({
    isSameOriginServerActionRequest: () => controls.sameOrigin,
}));

vi.mock("@/lib/supabaseServerAdmin", () => ({
    getSupabaseServerConfigFromEnv: () => ({
        url: "https://example.supabase.co",
        serviceRoleKey: "service-role",
        backendTimeoutMs: 5_000,
    }),
    createSupabaseAdminClient: () => {
        controls.adminClientCalls += 1;
        return {
            rpc: vi.fn(async (name: string) => ({
                data: name === "omr_begin_teacher_signup_v1"
                    ? (controls.signupRpcResults.shift() ?? false)
                    : false,
                error: null,
            })),
        };
    },
}));

vi.mock("@/lib/teacherAccountDelivery", () => ({
    resolveTeacherAccountDeliveryAdapter: () => controls.deliveryAvailable ? {} : null,
    deliverTeacherAccountToken: async (message: { email: string; token: string }) => {
        controls.deliveredTokens.push(message);
        return { status: controls.deliveryStatuses.shift() || "delivered" };
    },
}));

vi.mock("@/lib/durableRateLimit", () => ({
    applyDurableRateLimit: async () => {
        controls.durableCalls += 1;
        return { allowed: true, retryAfterMs: 0 };
    },
}));

import {
    requestTeacherPasswordReset,
    requestTeacherSignup,
} from "@/app/actions/teacherAccount";

describe("teacher account public action boundary", () => {
    beforeEach(() => {
        controls.sameOrigin = true;
        controls.adminClientCalls = 0;
        controls.durableCalls = 0;
        controls.deliveryAvailable = false;
        controls.deliveryStatuses = [];
        controls.deliveredTokens = [];
        controls.signupRpcResults = [];
    });

    it("rejects cross-origin signup before rate-limit or database work", async () => {
        controls.sameOrigin = false;
        await expect(requestTeacherSignup({
            email: "teacher@example.com",
            displayName: "김선생",
            password: "safe-password-123",
        })).resolves.toEqual({ status: "unauthenticated" });
        expect(controls.durableCalls).toBe(0);
        expect(controls.adminClientCalls).toBe(0);
    });

    it("fails closed without a delivery adapter before database mutation", async () => {
        await expect(requestTeacherSignup({
            email: "teacher@example.com",
            displayName: "김선생",
            password: "safe-password-123",
        })).resolves.toEqual({ status: "delivery_unavailable" });
        await expect(requestTeacherPasswordReset("teacher@example.com"))
            .resolves.toEqual({ status: "delivery_unavailable" });
        expect(controls.adminClientCalls).toBe(0);
    });

    it("bounds invalid input before delivery, rate-limit, or database work", async () => {
        await expect(requestTeacherSignup({
            email: "not-email",
            displayName: "",
            password: "short",
        })).resolves.toEqual({ status: "invalid_input" });
        await expect(requestTeacherPasswordReset("x".repeat(500)))
            .resolves.toEqual({ status: "invalid_input" });
        expect(controls.durableCalls).toBe(0);
        expect(controls.adminClientCalls).toBe(0);
    });

    it("retries delivery with a newly persisted token for pending signup but keeps active signup generic", async () => {
        controls.deliveryAvailable = true;
        controls.signupRpcResults = [true, true, false];
        controls.deliveryStatuses = ["rejected", "delivered"];
        const signup = {
            email: "teacher@example.com",
            displayName: "김선생",
            password: "safe-password-123",
        };

        await expect(requestTeacherSignup(signup)).resolves.toEqual({ status: "service_unavailable" });
        await expect(requestTeacherSignup(signup)).resolves.toEqual({ status: "accepted" });
        await expect(requestTeacherSignup(signup)).resolves.toEqual({ status: "accepted" });

        expect(controls.deliveredTokens).toHaveLength(2);
        expect(controls.deliveredTokens[0]?.token).not.toBe(controls.deliveredTokens[1]?.token);
        expect(controls.adminClientCalls).toBe(3);
    });
});
