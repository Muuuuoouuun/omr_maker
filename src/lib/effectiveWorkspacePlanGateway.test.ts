import { describe, expect, it, vi } from "vitest";
import { readEffectiveWorkspacePlan, type EffectiveWorkspacePlanRpcClient } from "./effectiveWorkspacePlanGateway";

describe("effective workspace plan gateway", () => {
    const now = Date.parse("2026-08-08T00:00:00Z");
    it("accepts an exact safe RPC envelope and fails closed to unavailable free", async () => {
        const rpc = vi.fn(async () => ({ data: {
            organizationId: "pilot_org_0123456789abcdef01234567",
            plan: "pro",
            grantId: "pilot_grant_0123456789abcdef01234567",
            expiresAt: "2026-08-31T15:00:00.000000Z",
        }, error: null }));
        await expect(readEffectiveWorkspacePlan({ rpc } as EffectiveWorkspacePlanRpcClient,
            "pilot_org_0123456789abcdef01234567", now)).resolves.toMatchObject({ authoritative: true, plan: "pro" });
        expect(rpc).toHaveBeenCalledWith("omr_read_effective_workspace_plan_v1", {
            p_organization_id: "pilot_org_0123456789abcdef01234567",
        });
        expect(rpc).toHaveBeenCalledTimes(1);
        const bad = { rpc: vi.fn(async () => ({ data: { organizationId: "other", plan: "academy" }, error: null })) };
        await expect(readEffectiveWorkspacePlan(bad, "pilot_org_0123456789abcdef01234567", now))
            .resolves.toEqual({ authoritative: false, plan: "free" });
        await expect(readEffectiveWorkspacePlan({ rpc: vi.fn(async () => ({ data: [{
            organizationId: "pilot_org_0123456789abcdef01234567",
            plan: "pro",
            grantId: "pilot_grant_0123456789abcdef01234567",
            expiresAt: "2026-08-31T15:00:00.000000Z",
        }], error: null })) }, "pilot_org_0123456789abcdef01234567", now))
            .resolves.toEqual({ authoritative: false, plan: "free" });
    });

    it("rejects paid grants at and after their expiration", async () => {
        const organizationId = "pilot_org_0123456789abcdef01234567";
        const expiresAt = "2026-08-31T15:00:00.000000Z";
        const client = { rpc: vi.fn(async () => ({ data: {
            organizationId,
            plan: "pro",
            grantId: "pilot_grant_0123456789abcdef01234567",
            expiresAt,
        }, error: null })) };

        for (const instant of [Date.parse(expiresAt), Date.parse(expiresAt) + 1]) {
            await expect(readEffectiveWorkspacePlan(client, organizationId, instant))
                .resolves.toEqual({ authoritative: false, plan: "free" });
        }
    });
});
