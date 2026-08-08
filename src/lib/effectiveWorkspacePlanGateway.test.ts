import { describe, expect, it, vi } from "vitest";
import { readEffectiveWorkspacePlan, type EffectiveWorkspacePlanRpcClient } from "./effectiveWorkspacePlanGateway";

describe("effective workspace plan gateway", () => {
    it("accepts an exact safe RPC envelope and fails closed to unavailable free", async () => {
        const rpc = vi.fn(async () => ({ data: {
            organizationId: "pilot_org_0123456789abcdef01234567",
            plan: "pro",
            grantId: "pilot_grant_0123456789abcdef01234567",
            expiresAt: "2026-08-31T15:00:00.000000Z",
        }, error: null }));
        await expect(readEffectiveWorkspacePlan({ rpc } as EffectiveWorkspacePlanRpcClient,
            "pilot_org_0123456789abcdef01234567")).resolves.toMatchObject({ authoritative: true, plan: "pro" });
        expect(rpc).toHaveBeenCalledWith("omr_read_effective_workspace_plan_v1", {
            p_organization_id: "pilot_org_0123456789abcdef01234567",
        });
        const bad = { rpc: vi.fn(async () => ({ data: { organizationId: "other", plan: "academy" }, error: null })) };
        await expect(readEffectiveWorkspacePlan(bad, "pilot_org_0123456789abcdef01234567"))
            .resolves.toEqual({ authoritative: false, plan: "free" });
        await expect(readEffectiveWorkspacePlan({ rpc: vi.fn(async () => ({ data: [{
            organizationId: "pilot_org_0123456789abcdef01234567",
            plan: "pro",
            grantId: "pilot_grant_0123456789abcdef01234567",
            expiresAt: "2026-08-31T15:00:00.000000Z",
        }], error: null })) }, "pilot_org_0123456789abcdef01234567"))
            .resolves.toEqual({ authoritative: false, plan: "free" });
    });
});
