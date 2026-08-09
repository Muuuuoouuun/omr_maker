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
    invites: [{
        id: "invite-1",
        email: "invite@example.com",
        sentAt: "방금 전",
        status: "pending",
    }],
};

function remoteRows(): Record<string, unknown[]> {
    return {
        omr_organizations: [{
            id: "org-1", metadata: { rosterRevision: 7 },
        }],
        omr_classes: [{
            id: "class-a", organization_id: "org-1", name: "A반", campus: "서울", status: "active",
            metadata: { count: 1, avgScore: 80, color: "#4f46e5" }, updated_at: "2026-08-09T01:02:03+00:00",
        }],
        omr_student_profiles: [{
            id: "student-1", organization_id: "org-1", display_name: "김학생", external_id: "student-1",
            email: "student@example.com", status: "active", metadata: {
                group: "A반", region: "서울", avatar: "#4f46e5", avgScore: 80, examsTaken: 2,
                lastActive: "오늘", trend: "up", status: "active",
            }, updated_at: "2026-08-09T01:02:03.000Z",
        }],
        omr_class_students: [{
            class_id: "class-a", organization_id: "org-1", student_profile_id: "student-1", enrollment_status: "active",
        }],
        omr_roster_invites: [{
            id: "invite-1", organization_id: "org-1", email: "invite@example.com",
            sent_at: "방금 전", status: "pending",
        }],
    };
}

function mockClient(options: { loadRpcError?: string; rpcError?: string; rows?: Record<string, unknown[]> } = {}) {
    const filters: Array<{ table: string; column: string; value: string }> = [];
    const queryCalls: Array<{ table: string; method: string; args: unknown[] }> = [];
    const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
    const rows: Record<string, unknown[]> = options.rows ?? remoteRows();
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
            meta: {
                organizationId: "org-1",
                loadedAt: expect.any(String),
                rawCount: 4,
                parsedCount: 4,
            },
        });
        expect(filters).toHaveLength(0);
        expect(queryCalls).toHaveLength(0);
        expect(rpcCalls).toEqual([{
            name: "omr_load_roster_v2",
            params: { p_organization_id: "org-1" },
        }]);
    });

    it.each([
        ["a mixed-organization class", "omr_classes", { organization_id: "org-other" }],
        ["a mixed-organization enrollment", "omr_class_students", { organization_id: "org-other" }],
        ["a malformed student", "omr_student_profiles", { display_name: "" }],
        ["an orphaned enrollment class", "omr_class_students", { class_id: "missing-class" }],
        ["an orphaned enrollment student", "omr_class_students", { student_profile_id: "missing-student" }],
        ["a blank class id", "omr_classes", { id: "" }],
        ["a blank student id", "omr_student_profiles", { id: "" }],
        ["a blank enrollment class id", "omr_class_students", { class_id: "" }],
        ["a blank invite id", "omr_roster_invites", { id: "" }],
        ["a blank class name", "omr_classes", { name: "" }],
        ["a blank invite email", "omr_roster_invites", { email: "" }],
        ["an invalid class status", "omr_classes", { status: "unknown" }],
        ["an invalid student status", "omr_student_profiles", { status: "unknown" }],
        ["an invalid enrollment status", "omr_class_students", { enrollment_status: "unknown" }],
        ["an invalid invite status", "omr_roster_invites", { status: "unknown" }],
        ["a whitespace-padded class timestamp", "omr_classes", { updated_at: " 2026-08-09T01:02:03.000Z " }],
        ["a noncanonical student timestamp", "omr_student_profiles", { updated_at: "2026-08-09T10:02:03+09:00" }],
        ["a calendar-impossible class timestamp", "omr_classes", { updated_at: "2026-02-30T01:02:03.123456+00:00" }],
        ["an empty invite sent label", "omr_roster_invites", { sent_at: "" }],
        ["a control-bearing invite sent label", "omr_roster_invites", { sent_at: "방금\u0000전" }],
        ["an oversized invite sent label", "omr_roster_invites", { sent_at: "x".repeat(121) }],
    ] as const)("rejects the entire roster snapshot when it contains %s", async (_label, table, replacement) => {
        const rows = remoteRows();
        rows[table] = rows[table].map(row => ({ ...(row as Record<string, unknown>), ...replacement }));

        await expect(loadTeacherRosterWithGateway(mockClient({ rows }).client, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "Canonical roster snapshot is invalid",
        });
    });

    it("preserves a bounded relative invite label through the roster adapter", async () => {
        const rows = remoteRows();
        rows.omr_roster_invites = rows.omr_roster_invites.map(row => ({
            ...(row as Record<string, unknown>),
            sent_at: "  방금 전  ",
        }));

        await expect(loadTeacherRosterWithGateway(mockClient({ rows }).client, context)).resolves.toMatchObject({
            status: "loaded",
            snapshot: { invites: [{ sentAt: "방금 전" }] },
        });
    });

    it("validates and counts historical rows while excluding them from the active snapshot", async () => {
        const rows = remoteRows();
        rows.omr_classes.push({
            id: "class-archived", organization_id: "org-1", name: "옛 반", campus: null,
            status: "archived", metadata: {}, updated_at: "2026-08-09T01:03:04+00:00",
        });
        rows.omr_student_profiles.push({
            id: "student-withdrawn", organization_id: "org-1", display_name: "졸업생",
            external_id: null, email: null, status: "withdrawn", metadata: {},
            updated_at: "2026-08-09T01:03:04.123456+00:00",
        });
        rows.omr_class_students.push(
            {
                class_id: "class-archived", organization_id: "org-1",
                student_profile_id: "student-withdrawn", enrollment_status: "inactive",
            },
            {
                class_id: "class-archived", organization_id: "org-1",
                student_profile_id: "student-1", enrollment_status: "completed",
            },
        );

        await expect(loadTeacherRosterWithGateway(mockClient({ rows }).client, context)).resolves.toMatchObject({
            status: "loaded",
            snapshot,
            meta: { rawCount: 8, parsedCount: 8 },
        });
    });

    it.each([
        ["an archived class with a malformed id", "omr_classes", {
            id: "", organization_id: "org-1", name: "옛 반", campus: null,
            status: "archived", metadata: {}, updated_at: "2026-08-09T01:03:04+00:00",
        }],
        ["a withdrawn student with a malformed timestamp", "omr_student_profiles", {
            id: "student-withdrawn", organization_id: "org-1", display_name: "졸업생",
            external_id: null, email: null, status: "withdrawn", metadata: {}, updated_at: "invalid",
        }],
        ["an inactive enrollment with a missing class", "omr_class_students", {
            class_id: "class-missing", organization_id: "org-1",
            student_profile_id: "student-1", enrollment_status: "inactive",
        }],
    ] as const)("rejects %s instead of silently excluding it", async (_label, table, malformedHistoryRow) => {
        const rows = remoteRows();
        rows[table].push(malformedHistoryRow);

        await expect(loadTeacherRosterWithGateway(mockClient({ rows }).client, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "Canonical roster snapshot is invalid",
        });
    });

    it.each([
        "omr_classes",
        "omr_student_profiles",
        "omr_class_students",
        "omr_roster_invites",
    ])("rejects a %s row with no organization_id field", async table => {
        const rows = remoteRows();
        rows[table] = rows[table].map(value => {
            const row = { ...(value as Record<string, unknown>) };
            Reflect.deleteProperty(row, "organization_id");
            return row;
        });

        await expect(loadTeacherRosterWithGateway(mockClient({ rows }).client, context)).resolves.toEqual({
            status: "service_unavailable",
            error: "Canonical roster snapshot is invalid",
        });
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
