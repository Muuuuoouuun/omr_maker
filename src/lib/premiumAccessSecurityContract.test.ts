import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSignedTeacherSessionCookie } from "./teacherServerSession";
import { TEACHER_SESSION_TTL_MS } from "./teacherSession";

const cookieState = vi.hoisted(() => ({ value: undefined as string | undefined }));

vi.mock("next/headers", () => ({
    cookies: async () => ({
        get: (name: string) => name === "omr_teacher_server_session" && cookieState.value
            ? { value: cookieState.value }
            : undefined,
    }),
}));

import { authorizeExamCreation } from "@/app/actions/premiumAccess";

const TOKEN = "tkn_contract_0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "premium-access-contract-session-secret";

function configureUnhostedRuntime(nodeEnv: "test" | "production") {
    vi.stubEnv("NODE_ENV", nodeEnv);
    vi.stubEnv("TEACHER_SESSION_SECRET", SESSION_SECRET);
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("OMR_SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("OMR_PLAN_DEV_SIMULATION", "");
    vi.stubEnv("OMR_DEV_PLAN", "");
    vi.stubEnv("TEACHER_PLAN", "");

    // Browser-readable values must never configure or elevate the server plan
    // store. These intentionally claim an Academy-like local environment.
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://client-only.invalid");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "client-only-key");
    vi.stubEnv("NEXT_PUBLIC_OMR_PLAN_DEV_SIMULATION", "1");
    vi.stubEnv("NEXT_PUBLIC_OMR_DEV_PLAN", "academy");
    vi.stubEnv("NEXT_PUBLIC_TEACHER_PLAN", "academy");
}

function signTeacher(teacherId: string, issuedAt = Date.now()) {
    cookieState.value = createSignedTeacherSessionCookie(
        TOKEN,
        { teacherId },
        { NODE_ENV: process.env.NODE_ENV, TEACHER_SESSION_SECRET: SESSION_SECRET },
        issuedAt,
    ) || undefined;
}

describe("premium access local fallback security contract", () => {
    beforeEach(() => {
        cookieState.value = undefined;
    });

    afterEach(() => {
        cookieState.value = undefined;
        vi.unstubAllEnvs();
    });

    it("uses the quota-limited free dev store only for an active signed teacher outside production", async () => {
        configureUnhostedRuntime("test");
        signTeacher(`teacher-local-${Date.now()}`);

        for (let index = 0; index < 5; index += 1) {
            await expect(authorizeExamCreation(`local-exam-${index}`)).resolves.toMatchObject({
                ok: true,
                access: {
                    authenticated: true,
                    authoritative: true,
                    source: "dev-simulation",
                    plan: "free",
                },
                quota: { allowed: true, limit: 5 },
            });
        }

        // NEXT_PUBLIC_* plan claims above cannot elevate the server decision.
        await expect(authorizeExamCreation("local-exam-over-limit")).resolves.toMatchObject({
            ok: false,
            access: { source: "dev-simulation", plan: "free" },
            quota: { allowed: false, limit: 5 },
        });
    });

    it("rejects missing and expired signed teacher sessions in a local runtime", async () => {
        configureUnhostedRuntime("test");
        await expect(authorizeExamCreation("anonymous-local-exam")).resolves.toMatchObject({
            ok: false,
            access: { authenticated: false, authoritative: false, source: "unavailable" },
        });

        signTeacher("teacher-expired", Date.now() - TEACHER_SESSION_TTL_MS - 1_000);
        await expect(authorizeExamCreation("expired-local-exam")).resolves.toMatchObject({
            ok: false,
            access: { authenticated: false, authoritative: false, source: "unavailable" },
        });
    });

    it("fails closed in production when server Supabase credentials are absent", async () => {
        configureUnhostedRuntime("production");
        signTeacher("teacher-production");

        await expect(authorizeExamCreation("production-exam")).resolves.toMatchObject({
            ok: false,
            access: {
                authenticated: true,
                authoritative: false,
                source: "unavailable",
                plan: "free",
            },
        });
    });
});
