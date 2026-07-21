import { describe, expect, it } from "vitest";
import { createTeacherSession } from "./teacherSession";
import { workspaceContextFromIdentity } from "./workspaceContext";
import {
    createDevServerPlanStore,
    createServerPlanStoreFromEnv,
    evaluateServerPlanQuota,
    resolveServerPlanAccess,
    seoulBillingPeriod,
} from "./serverPlan";

const TOKEN = "tkn_abc123_0123456789abcdef0123456789abcdef";

describe("server-authoritative plan access", () => {
    it("uses Asia/Seoul month boundaries for quota periods", () => {
        expect(seoulBillingPeriod(new Date("2026-07-31T15:30:00.000Z"))).toEqual({
            key: "2026-08-01",
            startsAt: "2026-07-31T15:00:00.000Z",
            endsAt: "2026-08-31T15:00:00.000Z",
        });
    });

    it("evaluates finite and unlimited plan limits without trusting browser state", () => {
        expect(evaluateServerPlanQuota("free", "exams", 4, 1)).toMatchObject({ allowed: true, limit: 5 });
        expect(evaluateServerPlanQuota("free", "exams", 5, 1)).toMatchObject({ allowed: false, remaining: 0 });
        expect(evaluateServerPlanQuota("pro", "exams", 50_000, 1)).toMatchObject({ allowed: true, limit: Infinity });
    });

    it("fails closed without a signed session or configured server store", async () => {
        await expect(resolveServerPlanAccess(null, { store: null })).resolves.toMatchObject({
            authenticated: false,
            authoritative: false,
            plan: "free",
            source: "unavailable",
        });

        const session = createTeacherSession(TOKEN, Date.now(), { teacherId: "teacher-a" });
        await expect(resolveServerPlanAccess(session, { store: null })).resolves.toMatchObject({
            authenticated: true,
            authoritative: false,
            plan: "free",
            source: "unavailable",
        });
    });

    it("allows explicit simulation only outside production", () => {
        expect(createServerPlanStoreFromEnv({
            NODE_ENV: "production",
            OMR_PLAN_DEV_SIMULATION: "1",
            OMR_DEV_PLAN: "pro",
        })).toBeNull();
        expect(createServerPlanStoreFromEnv({
            NODE_ENV: "development",
            OMR_PLAN_DEV_SIMULATION: "1",
            OMR_DEV_PLAN: "pro",
        })?.source).toBe("dev-simulation");
    });

    it("uses the signed-in teacher account plan in local server simulation", async () => {
        const env = {
            NODE_ENV: "development",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "admin", password: "admin-pass", plan: "academy" },
                { id: "teacher1", password: "teacher-pass", plan: "free" },
                { id: "teacher2", password: "teacher-pass", plan: "pro" },
            ]),
        };
        const store = createDevServerPlanStore(env);
        const organizationId = (teacherId: string) => workspaceContextFromIdentity({ teacherId }).organizationId;

        await expect(store.readPlan(organizationId("admin"))).resolves.toBe("academy");
        await expect(store.readPlan(organizationId("teacher1"))).resolves.toBe("free");
        await expect(store.readPlan(organizationId("teacher2"))).resolves.toBe("pro");
        await expect(store.readPlan("unknown-organization")).resolves.toBe("free");
    });

    it("caps a shared Academy organization by the signed account plan", async () => {
        const store = {
            source: "supabase" as const,
            readPlan: async () => "academy" as const,
            readUsage: async () => 0,
            reserveUsage: async () => ({ allowed: true, used: 0 }),
            releaseUsage: async () => ({ released: false, used: 0 }),
            syncStudentUsage: async () => ({ allowed: true, used: 0 }),
        };
        const session = (teacherId: string, plan: "free" | "pro" | "academy") => createTeacherSession(TOKEN, Date.now(), {
            teacherId,
            organizationId: "teacher_sharedqa",
            plan,
        });

        await expect(resolveServerPlanAccess(session("admin", "academy"), { store })).resolves.toMatchObject({ plan: "academy" });
        await expect(resolveServerPlanAccess(session("teacher1", "free"), { store })).resolves.toMatchObject({ plan: "free" });
        await expect(resolveServerPlanAccess(session("teacher2", "pro"), { store })).resolves.toMatchObject({ plan: "pro" });
        await expect(resolveServerPlanAccess(session("teacher3", "academy"), { store })).resolves.toMatchObject({ plan: "academy" });
    });

    it("never lets an account ceiling elevate the organization plan", async () => {
        const store = {
            source: "supabase" as const,
            readPlan: async () => "free" as const,
            readUsage: async () => 0,
            reserveUsage: async () => ({ allowed: true, used: 0 }),
            releaseUsage: async () => ({ released: false, used: 0 }),
            syncStudentUsage: async () => ({ allowed: true, used: 0 }),
        };
        const session = createTeacherSession(TOKEN, Date.now(), {
            teacherId: "teacher3",
            organizationId: "teacher_sharedqa",
            plan: "academy",
        });

        await expect(resolveServerPlanAccess(session, { store })).resolves.toMatchObject({ plan: "free" });
    });

    it("keeps the explicit global development plan override authoritative", async () => {
        const store = createDevServerPlanStore({
            OMR_DEV_PLAN: "pro",
            TEACHER_ACCOUNTS: JSON.stringify([
                { id: "admin", password: "admin-pass", plan: "academy" },
            ]),
        });
        const adminOrganizationId = workspaceContextFromIdentity({ teacherId: "admin" }).organizationId;

        await expect(store.readPlan(adminOrganizationId)).resolves.toBe("pro");
    });

    it("reserves atomically, retries idempotently, and compensates failures in dev simulation", async () => {
        const store = createDevServerPlanStore({ OMR_DEV_PLAN: "free" });
        const period = seoulBillingPeriod(new Date("2026-07-14T00:00:00.000Z"));
        const input = {
            organizationId: "org-reservation-test",
            metric: "exams" as const,
            period,
            resourceKey: "exam:a",
            attempted: 1,
            observedUsed: 4,
            limit: 5,
        };

        await expect(store.reserveUsage(input)).resolves.toMatchObject({ allowed: true, used: 5 });
        await expect(store.reserveUsage(input)).resolves.toMatchObject({ allowed: true, used: 5, idempotent: true });
        await expect(store.reserveUsage({ ...input, resourceKey: "exam:b" })).resolves.toMatchObject({ allowed: false, used: 5 });
        await expect(store.releaseUsage({
            organizationId: input.organizationId,
            metric: input.metric,
            period,
            resourceKey: input.resourceKey,
        })).resolves.toEqual({ released: true, used: 4 });
        await expect(store.reserveUsage({ ...input, resourceKey: "exam:b" })).resolves.toMatchObject({ allowed: true, used: 5 });
    });

    it("deduplicates stable roster ids and rejects an over-limit roster", async () => {
        const store = createDevServerPlanStore({ OMR_DEV_PLAN: "free" });
        await expect(store.syncStudentUsage({
            organizationId: "org-roster-test",
            resourceKeys: ["student-a", "student-a", "student-b"],
            observedUsed: 0,
            limit: 30,
        })).resolves.toEqual({ allowed: true, used: 2 });
        await expect(store.syncStudentUsage({
            organizationId: "org-roster-test",
            resourceKeys: Array.from({ length: 31 }, (_, index) => `student-${index}`),
            observedUsed: 2,
            limit: 30,
        })).resolves.toMatchObject({ allowed: false });
    });
});
