import { describe, expect, it } from "vitest";
import {
    bootstrapWorkspaceWithAdminClient,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminClientLike,
} from "./supabaseServerAdmin";
import { workspaceContextFromIdentity } from "./workspaceContext";

function mockAdminClient(failTable?: string): { client: SupabaseAdminClientLike; writes: { table: string; op: string; row: unknown }[] } {
    const writes: { table: string; op: string; row: unknown }[] = [];
    return {
        writes,
        client: {
            from(table: string) {
                return {
                    async upsert(row: unknown) {
                        writes.push({ table, op: "upsert", row });
                        return { error: table === failTable ? { message: `${table} failed` } : null };
                    },
                    async insert(row: unknown) {
                        writes.push({ table, op: "insert", row });
                        return { error: table === failTable ? { message: `${table} failed` } : null };
                    },
                };
            },
        },
    };
}

describe("Supabase server admin workspace bootstrap", () => {
    it("requires a server-only service role key and URL", () => {
        expect(getSupabaseServerConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_public",
        })).toBeNull();
        expect(getSupabaseServerConfigFromEnv({
            NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: " service-role ",
        })).toEqual({
            url: "https://example.supabase.co",
            serviceRoleKey: "service-role",
        });
        expect(getSupabaseServerConfigFromEnv({
            SUPABASE_URL: "https://private.supabase.co",
            OMR_SUPABASE_SERVICE_ROLE_KEY: "omr-service-role",
        })).toEqual({
            url: "https://private.supabase.co",
            serviceRoleKey: "omr-service-role",
        });
    });

    it("upserts workspace rows before writing an audit log", async () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            email: "teacher-a@example.com",
            displayName: "Teacher A",
        });
        const { client, writes } = mockAdminClient();

        await expect(bootstrapWorkspaceWithAdminClient(client, context, "2026-06-18T10:00:00.000Z")).resolves.toEqual({ ok: true });

        expect(writes.map(write => [write.table, write.op])).toEqual([
            ["omr_organizations", "upsert"],
            ["omr_user_profiles", "upsert"],
            ["omr_organization_members", "upsert"],
            ["omr_teacher_profiles", "upsert"],
            ["omr_audit_logs", "insert"],
        ]);
        expect(writes[2].row).toMatchObject({
            organization_id: context.organizationId,
            user_id: context.actorUserId,
            role: "owner",
            status: "active",
        });
        expect(writes[4].row).toMatchObject({
            organization_id: context.organizationId,
            actor_user_id: context.actorUserId,
            action: "workspace.bootstrap",
            entity_type: "organization",
            entity_id: context.organizationId,
        });
    });

    it("returns the first bootstrap write error without continuing", async () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            displayName: "Teacher A",
        });
        const { client, writes } = mockAdminClient("omr_organization_members");

        await expect(bootstrapWorkspaceWithAdminClient(client, context, "2026-06-18T10:00:00.000Z")).resolves.toEqual({
            ok: false,
            error: "omr_organization_members failed",
        });

        expect(writes.map(write => write.table)).toEqual([
            "omr_organizations",
            "omr_user_profiles",
            "omr_organization_members",
        ]);
    });
});
