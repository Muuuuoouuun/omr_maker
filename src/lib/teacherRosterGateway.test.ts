import { describe, expect, it } from "vitest";
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

function mockClient(options: { loadErrorTable?: string; rpcError?: string } = {}) {
    const filters: Array<{ table: string; column: string; value: string }> = [];
    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const rows: Record<string, unknown[]> = {
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
                    return {
                        async eq(column, value) {
                            filters.push({ table, column, value });
                            return options.loadErrorTable === table
                                ? { data: null, error: { message: "db down" } }
                                : { data: rows[table] || [], error: null };
                        },
                    };
                },
            };
        },
        async rpc(name, params) {
            rpcCalls.push({ name, params });
            return options.rpcError
                ? { data: null, error: { message: options.rpcError } }
                : { data: { saved: true }, error: null };
        },
    };
    return { client, filters, rpcCalls };
}

describe("teacher roster gateway", () => {
    it("loads every roster table through the teacher organization scope", async () => {
        const { client, filters } = mockClient();
        await expect(loadTeacherRosterWithGateway(client, context)).resolves.toEqual({ status: "loaded", snapshot });
        expect(filters).toHaveLength(4);
        expect(filters.every(filter => filter.column === "organization_id" && filter.value === "org-1")).toBe(true);
    });

    it("saves one organization-scoped atomic RPC payload", async () => {
        const { client, rpcCalls } = mockClient();
        await expect(saveTeacherRosterWithGateway(client, snapshot, context)).resolves.toEqual({ status: "saved", snapshot });
        expect(rpcCalls).toHaveLength(1);
        expect(rpcCalls[0]).toMatchObject({
            name: "omr_save_roster_v1",
            params: {
                p_organization_id: "org-1",
                p_classes: [expect.objectContaining({ id: "class-a", organization_id: "org-1" })],
                p_students: [expect.objectContaining({ id: "student-1", organization_id: "org-1" })],
                p_enrollments: [expect.objectContaining({ class_id: "class-a", student_profile_id: "student-1" })],
                p_invites: [expect.objectContaining({ id: "invite-1", organization_id: "org-1" })],
            },
        });
    });

    it("rejects duplicate identifiers before calling the database", async () => {
        const { client, rpcCalls } = mockClient();
        const invalid = { ...snapshot, groups: [...snapshot.groups, { ...snapshot.groups[0] }] };
        await expect(saveTeacherRosterWithGateway(client, invalid, context)).resolves.toEqual({ status: "invalid_roster" });
        expect(rpcCalls).toHaveLength(0);
    });

    it("propagates read and atomic write failures without claiming success", async () => {
        await expect(loadTeacherRosterWithGateway(mockClient({ loadErrorTable: "omr_student_profiles" }).client, context))
            .resolves.toEqual({ status: "service_unavailable", error: "db down" });
        await expect(saveTeacherRosterWithGateway(mockClient({ rpcError: "write failed" }).client, snapshot, context))
            .resolves.toEqual({ status: "service_unavailable", error: "write failed" });
    });
});
