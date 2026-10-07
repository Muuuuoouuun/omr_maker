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

    it("accepts only a marked permanent demo envelope in its exact organization", async () => {
        const organizationId="demo_org_0123456789abcdef01234567";
        const row={organizationId,plan:"academy",grantId:null,expiresAt:null,entitlementMode:"permanent_demo"};
        const client=(data:unknown) => ({rpc:vi.fn(async () => ({data,error:null}))});
        await expect(readEffectiveWorkspacePlan(client(row),organizationId,now)).resolves.toEqual({authoritative:true,plan:"academy",entitlementMode:"permanent_demo"});
        for (const data of [{...row,entitlementMode:undefined},{...row,plan:"enterprise"},{...row,expiresAt:"9999-01-01T00:00:00Z"},
            {...row,organizationId:"demo_org_000000000000000000000000"}]) {
            await expect(readEffectiveWorkspacePlan(client(data),organizationId,now)).resolves.toEqual({authoritative:false,plan:"free"});
        }
        const ordinary="pilot_org_0123456789abcdef01234567";
        await expect(readEffectiveWorkspacePlan(client({...row,organizationId:ordinary}),ordinary,now)).resolves.toEqual({authoritative:false,plan:"free"});
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
