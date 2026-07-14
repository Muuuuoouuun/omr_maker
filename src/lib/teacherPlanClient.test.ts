import { describe, expect, it, vi } from "vitest";
import { loadTeacherPlanWithDeps } from "./teacherPlanClient";

describe("loadTeacherPlanWithDeps", () => {
    it("uses the server-source plan and caches it locally on ok", async () => {
        const cachePlan = vi.fn();
        const result = await loadTeacherPlanWithDeps({
            server: async () => ({ status: "ok", plan: "pro" }),
            readLocalPlan: () => "free",
            cachePlan,
        });
        expect(result).toEqual({ plan: "pro", source: "server" });
        expect(cachePlan).toHaveBeenCalledWith("pro");
    });

    it("keeps the login-bound local plan on denied without caching a guess", async () => {
        const cachePlan = vi.fn();
        const result = await loadTeacherPlanWithDeps({
            server: async () => ({ status: "denied" }),
            readLocalPlan: () => "academy",
            cachePlan,
        });
        expect(result).toEqual({ plan: "academy", source: "local" });
        expect(cachePlan).not.toHaveBeenCalled();
    });

    it("falls back to the local plan when the org row is absent (not_found)", async () => {
        const cachePlan = vi.fn();
        const result = await loadTeacherPlanWithDeps({
            server: async () => ({ status: "not_found" }),
            readLocalPlan: () => "free",
            cachePlan,
        });
        expect(result).toEqual({ plan: "free", source: "local" });
        expect(cachePlan).not.toHaveBeenCalled();
    });

    it("keeps the local plan on degraded_local and when the server throws", async () => {
        for (const server of [
            async () => ({ status: "degraded_local" }),
            async () => { throw new Error("offline"); },
        ]) {
            const result = await loadTeacherPlanWithDeps({
                server,
                readLocalPlan: () => "pro",
                cachePlan: vi.fn(),
            });
            expect(result).toEqual({ plan: "pro", source: "local" });
        }
    });
});
