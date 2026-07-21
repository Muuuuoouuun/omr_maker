import { describe, expect, it } from "vitest";
import {
    bootstrapWorkspaceWithAdminClient,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminClientLike,
} from "./supabaseServerAdmin";
import { fetchAttemptRowByOwnerAndId, fetchAttemptRowsByOwner, fetchExamRowById, fetchExamRowsByOrganization } from "./supabaseServerAdmin";
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
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher",
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
            role: "teacher",
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

function mockReadClient(rows: Record<string, unknown[]>) {
    return {
        from(table: string) {
            const data = rows[table] || [];
            const filtered: unknown[] = [...data];
            const builder = {
                _rows: filtered,
                select() { return builder; },
                eq(column: string, value: string) {
                    builder._rows = builder._rows.filter(
                        row => (row as Record<string, unknown>)[column] === value,
                    );
                    return builder;
                },
                async maybeSingle() { return { data: builder._rows[0] ?? null, error: null }; },
                async order() { return { data: builder._rows, error: null }; },
            };
            return builder;
        },
    };
}

describe("Supabase server admin reads", () => {
    it("fetches a single exam row by id", async () => {
        const client = mockReadClient({ omr_exams: [{ id: "e1", title: "T" }, { id: "e2", title: "U" }] });
        expect(await fetchExamRowById(client, "e2")).toEqual({ id: "e2", title: "U" });
        expect(await fetchExamRowById(client, "missing")).toBeNull();
    });

    it("fetches only exams in the signed student's organization", async () => {
        const client = mockReadClient({
            omr_exams: [
                { id: "e1", organization_id: "teacher_a" },
                { id: "e2", organization_id: "teacher_b" },
            ],
        });
        expect(await fetchExamRowsByOrganization(client, "teacher_b"))
            .toEqual([{ id: "e2", organization_id: "teacher_b" }]);
    });

    it("fetches attempt rows scoped to a guest owner", async () => {
        const client = mockReadClient({
            omr_attempts: [
                { id: "a1", student_id: "guest:g1", exam_id: "e1" },
                { id: "a2", student_id: "guest:g2", exam_id: "e1" },
            ],
        });
        const rows = await fetchAttemptRowsByOwner(client, { studentId: "guest:g1" });
        expect(rows.map(r => (r as { id: string }).id)).toEqual(["a1"]);
    });

    it("fetches one retry attempt by both id and owner", async () => {
        const client = mockReadClient({
            omr_attempts: [
                { id: "same", student_id: "student-a", exam_id: "e1" },
                { id: "same", student_id: "student-b", exam_id: "e1" },
            ],
        });
        expect(await fetchAttemptRowByOwnerAndId(client, { studentId: "student-b" }, "same"))
            .toEqual({ id: "same", student_id: "student-b", exam_id: "e1" });
        expect(await fetchAttemptRowByOwnerAndId(client, { studentId: "student-c" }, "same"))
            .toBeNull();
    });
});
