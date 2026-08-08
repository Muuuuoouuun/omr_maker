import { describe, expect, it } from "vitest";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
import type { RosterSnapshot } from "./rosterPersistence";
import {
    loadTeacherRosterWithGateway,
    saveTeacherRosterWithGateway,
    type TeacherRosterGatewayClient,
} from "./teacherRosterGateway";

const context = {
    organizationId: "org-1",
    organizationName: "테스트 학원",
    actorUserId: "teacher-1",
};

const mutationContext = {
    organizationId: "pilot_org_0123456789abcdef01234567",
    organizationName: "테스트 학원",
    actorUserId: "teacher_0123456789abcdef",
    accountId: "teacher_0123456789abcdef",
    sessionAuthority: "account" as const,
    accountSessionGeneration: 3,
};

const snapshot: RosterSnapshot = {
    groups: [{ id: "class-a", name: "A반", region: "서울", count: 1, avgScore: 80, color: "#4f46e5" }],
    students: [{
        id: "student-1",
        name: "김학생",
        email: "student@example.com",
        group: "A반",
        region: "서울",
        avatar: "#4f46e5",
        avgScore: 80,
        examsTaken: 2,
        lastActive: "오늘",
        trend: "up",
        status: "active",
    }],
    invites: [{ id: "invite-1", email: "invite@example.com", sentAt: "오늘", status: "pending" }],
};

function mockClient(options: { loadRpcError?: string; rpcError?: string; rows?: Record<string, unknown[]> } = {}) {
    const filters: Array<{ table: string; column: string; value: string }> = [];
    const queryCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const rows: Record<string, unknown[]> = options.rows ?? {
        omr_organizations: [{
            id: "org-1", metadata: { rosterRevision: 7 },
        }],
        omr_classes: [{
            id: "class-a", organization_id: "org-1", name: "A반", campus: "서울", status: "active",
            metadata: { count: 1, avgScore: 80, color: "#4f46e5" },
        }],
        omr_student_profiles: [{
            id: "student-1", organization_id: "org-1", display_name: "김학생", external_id: "student-1",
            email: "student@example.com", status: "active", metadata: {
                group: "A반", region: "서울", avatar: "#4f46e5", avgScore: 80, examsTaken: 2,
                lastActive: "오늘", trend: "up", status: "active",
            },
        }],
        omr_class_students: [{
            class_id: "class-a", organization_id: "org-1", student_profile_id: "student-1", enrollment_status: "active",
        }],
        omr_roster_invites: [{
            id: "invite-1", organization_id: "org-1", email: "invite@example.com", sent_at: "오늘", status: "pending",
        }],
    };
    const client: TeacherRosterGatewayClient = {
        from(table) {
            return {
                select() {
                    const query = {
                        eq(column: string, value: string) {
                            filters.push({ table, column, value });
                            queryCalls.push({ table, method: "eq", args: [column, value] });
                            return query;
                        },
                        order(column: string, orderOptions: { ascending: boolean }) {
                            queryCalls.push({ table, method: "order", args: [column, orderOptions] });
                            return query;
                        },
                        async limit(value: number) {
                            queryCalls.push({ table, method: "limit", args: [value] });
                            return { data: rows[table] || [], error: null };
                        },
                    };
                    return query;
                },
            };
        },
        async rpc(name, params) {
            rpcCalls.push({ name, params });
            if (name === "omr_load_roster_v2") {
                return options.loadRpcError
                    ? { data: null, error: { message: options.loadRpcError } }
                    : {
                        data: {
                            revision: 7,
                            classes: rows.omr_classes,
                            students: rows.omr_student_profiles,
                            enrollments: rows.omr_class_students,
                            invites: rows.omr_roster_invites,
                        },
                        error: null,
                    };
            }
            return options.rpcError
                ? { data: null, error: { message: options.rpcError } }
                : { data: { saved: true, revision: 8 }, error: null };
        },
    };
    return { client, filters, rpcCalls, queryCalls };
}

describe("teacher roster gateway", () => {
    it("loads one atomic organization-scoped roster and revision snapshot RPC", async () => {
        const { client, filters, queryCalls, rpcCalls } = mockClient();
        await expect(loadTeacherRosterWithGateway(client, context)).resolves.toEqual({
            status: "loaded",
            snapshot,
            revision: 7,
        });
        expect(filters).toHaveLength(0);
        expect(queryCalls).toHaveLength(0);
        expect(rpcCalls).toEqual([{
            name: "omr_load_roster_v2",
            params: { p_organization_id: "org-1" },
        }]);
    });

    it.each([
        ["omr_classes", "classes"],
        ["omr_student_profiles", "students"],
        ["omr_class_students", "enrollments"],
        ["omr_roster_invites", "invites"],
    ] as const)("reports overflow for %s instead of returning a partial snapshot", async (table, limitKey) => {
        const count = INITIAL_OPERATIONS_LIMITS[limitKey] + 1;
        const rows = {
            omr_classes: [],
            omr_student_profiles: [],
            omr_class_students: [],
            omr_roster_invites: [],
            [table]: Array.from({ length: count }, (_, index) => ({ id: `${table}-${index}` })),
        };

        await expect(loadTeacherRosterWithGateway(mockClient({ rows }).client, context)).resolves.toEqual({
            status: "service_unavailable",
            error: INITIAL_CAPACITY_EXCEEDED_ERROR,
        });
    });

    it("saves one organization-scoped atomic RPC payload", async () => {
        const { client, rpcCalls } = mockClient();
        await expect(saveTeacherRosterWithGateway(client, snapshot, mutationContext, 7)).resolves.toEqual({
            status: "saved",
            snapshot,
            revision: 8,
        });
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0]).toMatchObject({
            name: "omr_save_roster_v3",
            params: {
                p_session_authority: "account",
                p_account_id: "teacher_0123456789abcdef",
                p_session_generation: 3,
                p_actor_user_id: "teacher_0123456789abcdef",
                p_organization_id: "pilot_org_0123456789abcdef01234567",
                p_expected_revision: 7,
                p_classes: [expect.objectContaining({ id: "class-a", organization_id: mutationContext.organizationId })],
                p_students: [expect.objectContaining({ id: "student-1", organization_id: mutationContext.organizationId })],
                p_enrollments: [expect.objectContaining({ class_id: "class-a", student_profile_id: "student-1" })],
                p_invites: [expect.objectContaining({ id: "invite-1", organization_id: mutationContext.organizationId })],
            },
        });
    });

    it("reports a stale whole-roster snapshot as a conflict", async () => {
        await expect(saveTeacherRosterWithGateway(
            mockClient({ rpcError: "roster revision conflict" }).client,
            snapshot,
            mutationContext,
            6,
        )).resolves.toEqual({
            status: "conflict",
            error: "roster revision conflict",
        });
    });

    it("rejects duplicate identifiers before calling the database", async () => {
        const { client, rpcCalls } = mockClient();
        const invalid = { ...snapshot, groups: [...snapshot.groups, { ...snapshot.groups[0] }] };
        await expect(saveTeacherRosterWithGateway(client, invalid, context)).resolves.toEqual({ status: "invalid_roster" });
        expect(rpcCalls).toHaveLength(0);
    });

    it("propagates read and atomic write failures without claiming success", async () => {
        await expect(loadTeacherRosterWithGateway(mockClient({ loadRpcError: "db down" }).client, context))
            .resolves.toEqual({ status: "service_unavailable", error: "db down" });
        await expect(saveTeacherRosterWithGateway(mockClient({ rpcError: "write failed" }).client, snapshot, mutationContext))
            .resolves.toEqual({ status: "service_unavailable", error: "write failed" });
    });
});
