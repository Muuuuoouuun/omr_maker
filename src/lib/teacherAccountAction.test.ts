import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const controls = vi.hoisted(() => ({
    sameOrigin: true,
    adminClientCalls: 0,
    durableCalls: 0,
    deliveryCalls: 0,
    lifecycleCalls: 0,
    deliveryAvailable: false,
    deliveryStatuses: [] as Array<"delivered" | "rejected">,
    deliveredTokens: [] as Array<{ email: string; token: string }>,
    signupRpcResults: [] as boolean[],
    rpcResults: {} as Record<string, unknown>,
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
                    : (controls.rpcResults[name] ?? false),
                error: null,
            })),
        };
    },
}));

vi.mock("@/lib/teacherAccountDelivery", () => ({
    resolveTeacherAccountDeliveryAdapter: () => {
        controls.deliveryCalls += 1;
        return controls.deliveryAvailable ? {} : null;
    },
    deliverTeacherAccountToken: async (message: { email: string; token: string }) => {
        controls.deliveryCalls += 1;
        controls.deliveredTokens.push(message);
        return { status: controls.deliveryStatuses.shift() || "delivered" };
    },
}));

vi.mock("@/lib/teacherAccountLifecycle", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@/lib/teacherAccountLifecycle")>();
    return {
        ...actual,
        createTeacherAccountToken: (...args: Parameters<typeof actual.createTeacherAccountToken>) => {
            controls.lifecycleCalls += 1;
            return actual.createTeacherAccountToken(...args);
        },
        hashTeacherAccountPasswordAsync: (...args: Parameters<typeof actual.hashTeacherAccountPasswordAsync>) => {
            controls.lifecycleCalls += 1;
            return actual.hashTeacherAccountPasswordAsync(...args);
        },
        hashTeacherAccountToken: (...args: Parameters<typeof actual.hashTeacherAccountToken>) => {
            controls.lifecycleCalls += 1;
            return actual.hashTeacherAccountToken(...args);
        },
        isValidTeacherAccountEmail: (...args: Parameters<typeof actual.isValidTeacherAccountEmail>) => {
            controls.lifecycleCalls += 1;
            return actual.isValidTeacherAccountEmail(...args);
        },
        normalizeTeacherAccountEmail: (...args: Parameters<typeof actual.normalizeTeacherAccountEmail>) => {
            controls.lifecycleCalls += 1;
            return actual.normalizeTeacherAccountEmail(...args);
        },
        validateTeacherSignupInput: (...args: Parameters<typeof actual.validateTeacherSignupInput>) => {
            controls.lifecycleCalls += 1;
            return actual.validateTeacherSignupInput(...args);
        },
    };
});

vi.mock("@/lib/durableRateLimit", () => ({
    applyDurableRateLimit: async () => {
        controls.durableCalls += 1;
        return { allowed: true, retryAfterMs: 0 };
    },
}));

import {
    confirmTeacherSignupEmail,
    finishTeacherPasswordReset,
    requestTeacherPasswordReset,
    requestTeacherSignup,
} from "@/app/actions/teacherAccount";

describe("teacher account public action boundary", () => {
    beforeEach(() => {
        vi.stubEnv("NODE_ENV", "test");
        vi.stubEnv("OMR_TEACHER_IDENTITY_MODE", "self_service");
        controls.sameOrigin = true;
        controls.adminClientCalls = 0;
        controls.durableCalls = 0;
        controls.deliveryCalls = 0;
        controls.lifecycleCalls = 0;
        controls.deliveryAvailable = false;
        controls.deliveryStatuses = [];
        controls.deliveredTokens = [];
        controls.signupRpcResults = [];
        controls.rpcResults = {};
    });

    afterEach(() => vi.unstubAllEnvs());

    it("fails every self-service action closed before dependencies in provisioned-only mode", async () => {
        vi.stubEnv("OMR_TEACHER_IDENTITY_MODE", "provisioned_only");
        controls.deliveryAvailable = true;
        const email = "private.teacher@example.com";
        const token = "private-legacy-token";

        const results = [
            await requestTeacherSignup({
                email,
                displayName: "개인 이름",
                password: "safe-password-123",
            }),
            await requestTeacherPasswordReset(email),
            await finishTeacherPasswordReset({ token, password: "safe-password-123" }),
            await confirmTeacherSignupEmail(token),
        ];

        expect(results).toEqual([
            { status: "dependency_unavailable" },
            { status: "dependency_unavailable" },
            { status: "dependency_unavailable" },
            { status: "dependency_unavailable" },
        ]);
        expect(controls.lifecycleCalls).toBe(0);
        expect(controls.deliveryCalls).toBe(0);
        expect(controls.durableCalls).toBe(0);
        expect(controls.adminClientCalls).toBe(0);
        expect(JSON.stringify(results)).not.toContain(email);
        expect(JSON.stringify(results)).not.toContain(token);
        expect(JSON.stringify(results)).not.toContain("개인 이름");
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

    it("preserves completion and verification flows in explicitly enabled nonproduction self-service mode", async () => {
        controls.rpcResults = {
            omr_complete_teacher_password_reset_v1: true,
            omr_verify_teacher_email_v1: true,
        };

        await expect(finishTeacherPasswordReset({
            token: "legacy-reset-token",
            password: "safe-password-123",
        })).resolves.toEqual({ status: "completed" });
        await expect(confirmTeacherSignupEmail("legacy-verification-token"))
            .resolves.toEqual({ status: "verified" });
        expect(controls.durableCalls).toBe(2);
        expect(controls.adminClientCalls).toBe(2);
    });
});
