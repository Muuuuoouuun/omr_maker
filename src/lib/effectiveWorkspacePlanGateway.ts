import "next/dist/compiled/server-only";

import type { PlanKey } from "@/types/omr";

export interface EffectiveWorkspacePlanRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export interface EffectiveWorkspacePlanRead {
    authoritative: boolean;
    plan: PlanKey;
    grantId?: string;
    expiresAt?: string;
}

const ORGANIZATION_ID_PATTERN = /^(?:default|teacher_[a-z0-9]{7,16}|pilot_org_[a-f0-9]{24})$/;
const GRANT_ID_PATTERN = /^pilot_grant_[a-f0-9]{24}$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function exactOwnDataRecord(value: unknown): Record<string, unknown> | null {
    const candidate = Array.isArray(value) ? null : value;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    try {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null
            || Object.getOwnPropertySymbols(candidate).length > 0) return null;
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const expected = ["expiresAt", "grantId", "organizationId", "plan"];
        const actual = Object.keys(descriptors).sort();
        if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) return null;
        for (const key of expected) {
            const descriptor = descriptors[key];
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        }
        return Object.fromEntries(expected.map(key => [key, descriptors[key]!.value]));
    } catch {
        return null;
    }
}

export async function readEffectiveWorkspacePlan(
    client: EffectiveWorkspacePlanRpcClient,
    organizationId: string,
    now = Date.now(),
): Promise<EffectiveWorkspacePlanRead> {
    if (!ORGANIZATION_ID_PATTERN.test(organizationId)) return { authoritative: false, plan: "free" };
    try {
        const result = await client.rpc("omr_read_effective_workspace_plan_v1", {
            p_organization_id: organizationId,
        });
        if (result.error) return { authoritative: false, plan: "free" };
        const row = exactOwnDataRecord(result.data);
        if (!row || row.organizationId !== organizationId) return { authoritative: false, plan: "free" };
        if (row.plan === "free" && row.grantId === null && row.expiresAt === null) {
            return { authoritative: true, plan: "free" };
        }
        if ((row.plan !== "pro" && row.plan !== "academy")
            || typeof row.grantId !== "string" || !GRANT_ID_PATTERN.test(row.grantId)
            || typeof row.expiresAt !== "string" || !UTC_INSTANT_PATTERN.test(row.expiresAt)) {
            return { authoritative: false, plan: "free" };
        }
        const expiresAtMs = Date.parse(row.expiresAt);
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now) return { authoritative: false, plan: "free" };
        return {
            authoritative: true,
            plan: row.plan,
            grantId: row.grantId,
            expiresAt: row.expiresAt,
        };
    } catch {
        return { authoritative: false, plan: "free" };
    }
}
