import { describe, expect, it } from "vitest";
import {
    DEFAULT_WORKSPACE_ORGANIZATION_ID,
    readActiveWorkspaceContext,
    stableWorkspaceHash,
    workspaceBootstrapRows,
    workspaceContextFromIdentity,
} from "./workspaceContext";
import { createTeacherSession } from "./teacherSession";

function sessionStorageWithSession(rawSession: string) {
    return {
        getItem: (key: string) => key === "omr_teacher_session" ? rawSession : null,
        setItem: () => undefined,
        removeItem: () => undefined,
    };
}

describe("workspace context", () => {
    it("falls back to the default workspace without a teacher identity", () => {
        expect(workspaceContextFromIdentity(null)).toMatchObject({
            organizationId: DEFAULT_WORKSPACE_ORGANIZATION_ID,
        });
    });

    it("derives stable non-email organization and user ids from teacher identity", () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            email: "teacher-a@example.com",
            displayName: "Teacher A",
        });

        expect(context).toMatchObject({
            organizationId: `teacher_${stableWorkspaceHash("teacher-a")}`,
            actorUserId: `teacher_${stableWorkspaceHash("teacher-a")}`,
            actorEmail: "teacher-a@example.com",
            organizationName: "Teacher A Workspace",
            actorLabel: "Teacher A",
        });
        expect(context.organizationId).not.toContain("@");
        expect(context.actorUserId).not.toContain("@");
    });

    it("shares an explicit organization while preserving actor and member identities", () => {
        const admin = workspaceContextFromIdentity({
            teacherId: "admin",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "admin",
        });
        const teacher = workspaceContextFromIdentity({
            teacherId: "teacher1",
            organizationId: "teacher_sharedqa",
            organizationName: "OMR Maker 테스트",
            memberRole: "teacher",
        });

        expect(admin.organizationId).toBe("teacher_sharedqa");
        expect(teacher.organizationId).toBe("teacher_sharedqa");
        expect(admin.organizationName).toBe("OMR Maker 테스트");
        expect(admin.actorUserId).not.toBe(teacher.actorUserId);
        expect(workspaceBootstrapRows(admin).member?.role).toBe("admin");
        expect(workspaceBootstrapRows(teacher).member?.role).toBe("teacher");
    });

    it("reads the active teacher session as the current workspace", () => {
        const session = createTeacherSession("tkn_test_0123456789abcdef0123456789abcdef", 1000, {
            teacherId: "director",
            email: "director@example.com",
            displayName: "Director",
        });
        const storage = sessionStorageWithSession(JSON.stringify(session));

        expect(readActiveWorkspaceContext(storage, 2000)).toMatchObject({
            organizationId: `teacher_${stableWorkspaceHash("director")}`,
            actorUserId: `teacher_${stableWorkspaceHash("director")}`,
            actorLabel: "Director",
        });
    });

    it("builds idempotent organization, member, and profile bootstrap rows", () => {
        const context = workspaceContextFromIdentity({
            teacherId: "teacher-a",
            email: "teacher-a@example.com",
            displayName: "Teacher A",
        });
        const rows = workspaceBootstrapRows(context, "2026-06-18T10:00:00.000Z");

        expect(rows.organization).toEqual({
            id: context.organizationId,
            name: "Teacher A Workspace",
            plan: "free",
            metadata: { source: "omr_maker_workspace", authSource: "teacher_session" },
            updated_at: "2026-06-18T10:00:00.000Z",
        });
        expect(rows.userProfile).toMatchObject({
            user_id: context.actorUserId,
            email: "teacher-a@example.com",
            display_name: "Teacher A",
            status: "active",
        });
        expect(rows.member).toMatchObject({
            organization_id: context.organizationId,
            user_id: context.actorUserId,
            role: "owner",
            status: "active",
        });
        expect(rows.teacherProfile).toMatchObject({
            organization_id: context.organizationId,
            user_id: context.actorUserId,
            display_name: "Teacher A",
            status: "active",
        });
    });

    it("only bootstraps the organization row for anonymous/default workspace access", () => {
        const rows = workspaceBootstrapRows(workspaceContextFromIdentity(null), "2026-06-18T10:00:00.000Z");

        expect(rows.organization).toMatchObject({
            id: DEFAULT_WORKSPACE_ORGANIZATION_ID,
            metadata: { source: "omr_maker_workspace", authSource: "default" },
        });
        expect(rows.userProfile).toBeUndefined();
        expect(rows.member).toBeUndefined();
        expect(rows.teacherProfile).toBeUndefined();
    });
});
