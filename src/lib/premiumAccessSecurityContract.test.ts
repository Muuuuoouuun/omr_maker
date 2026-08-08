import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { MOCKUP_TEACHER_ID } from "./mockupAccount";
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

import { authorizeExamCreation, getServerPlanSnapshot } from "@/app/actions/premiumAccess";

const TOKEN = "tkn_contract_0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "premium-access-contract-session-secret";

function configureUnhostedRuntime(nodeEnv: "test" | "production") {
    vi.stubEnv("NODE_ENV", nodeEnv);
    if (nodeEnv === "test") vi.stubEnv("OMR_TEACHER_IDENTITY_MODE", "self_service");
    vi.stubEnv("TEACHER_SESSION_SECRET", SESSION_SECRET);
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("OMR_SUPABASE_SERVICE_ROLE_KEY", "");
    vi.stubEnv("OMR_PLAN_DEV_SIMULATION", "");
    vi.stubEnv("OMR_DEV_PLAN", "");
    vi.stubEnv("TEACHER_PLAN", "");
    vi.stubEnv("TEACHER_ACCOUNTS", JSON.stringify([{
        id: "admin",
        password: "test-only-password",
        plan: "free",
    }]));
    vi.stubEnv("OMR_TEACHER_ACCOUNTS", "");

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
        vi.unstubAllGlobals();
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
                authenticated: false,
                authoritative: false,
                source: "unavailable",
                plan: "free",
            },
        });
    });

    it("does not elevate a signed Free teacher from a forged browser showcase identity", async () => {
        configureUnhostedRuntime("test");
        signTeacher("admin");
        vi.stubGlobal("sessionStorage", {
            getItem: vi.fn().mockReturnValue(JSON.stringify({ teacherId: MOCKUP_TEACHER_ID })),
        });

        await expect(getServerPlanSnapshot()).resolves.toMatchObject({
            authenticated: true,
            authoritative: true,
            source: "dev-simulation",
            plan: "free",
        });

        const attemptPage = readFileSync("src/app/teacher/attempt/[attemptId]/page.tsx", "utf8");
        expect(attemptPage).not.toMatch(/isMockupTeacherIdentity|isMockupAccount|reportPlan/);
        expect(attemptPage).toMatch(/hasPlanEntitlement\(currentPlan, "studentGrowthReports"\)/);
    });

    it("shows Academy display entitlements only for the signed mockup teacher", async () => {
        configureUnhostedRuntime("test");
        signTeacher(MOCKUP_TEACHER_ID);

        await expect(getServerPlanSnapshot()).resolves.toMatchObject({
            authenticated: true,
            authoritative: true,
            source: "dev-simulation",
            plan: "academy",
        });
        await expect(authorizeExamCreation("mockup-mutation-stays-free")).resolves.toMatchObject({
            ok: true,
            access: { plan: "free" },
            quota: { limit: 5 },
        });
    });
});
