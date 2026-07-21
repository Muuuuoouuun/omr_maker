import {
    isTeacherSessionActive,
    readTeacherSession,
    type TeacherSession,
    type TeacherSessionStorage,
} from "@/lib/teacherSession";
import type { TeacherMemberRole } from "@/lib/teacherSession";

export const DEFAULT_WORKSPACE_ORGANIZATION_ID = "default";
export const DEFAULT_WORKSPACE_ORGANIZATION_NAME = "OMR Maker";

export interface WorkspaceContext {
    organizationId: string;
    organizationName: string;
    actorUserId?: string;
    actorEmail?: string;
    actorLabel?: string;
    memberRole?: TeacherMemberRole;
}

export interface WorkspaceIdentity {
    teacherId?: string;
    email?: string;
    displayName?: string;
    organizationId?: string;
    organizationName?: string;
    memberRole?: TeacherMemberRole;
}

const DEFAULT_CONTEXT: WorkspaceContext = {
    organizationId: DEFAULT_WORKSPACE_ORGANIZATION_ID,
    organizationName: DEFAULT_WORKSPACE_ORGANIZATION_NAME,
};

export interface WorkspaceBootstrapRows {
    organization: {
        id: string;
        name: string;
        plan: "free" | "pro" | "academy";
        metadata: Record<string, unknown>;
        updated_at: string;
    };
    userProfile?: {
        user_id: string;
        email: string | null;
        display_name: string;
        locale: string;
        timezone: string;
        status: "active";
        metadata: Record<string, unknown>;
        updated_at: string;
    };
    member?: {
        organization_id: string;
        user_id: string;
        email: string | null;
        display_name: string;
        role: TeacherMemberRole;
        status: "active";
        updated_at: string;
    };
    teacherProfile?: {
        organization_id: string;
        user_id: string;
        display_name: string;
        status: "active";
        metadata: Record<string, unknown>;
        updated_at: string;
    };
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function identityKey(identity: WorkspaceIdentity | null | undefined): string {
    return clean(identity?.teacherId).toLowerCase()
        || clean(identity?.email).toLowerCase()
        || clean(identity?.displayName).toLowerCase();
}

export function stableWorkspaceHash(value: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36).padStart(7, "0");
}

export function workspaceContextFromIdentity(identity: WorkspaceIdentity | null | undefined): WorkspaceContext {
    const key = identityKey(identity);
    if (!key) return DEFAULT_CONTEXT;

    const hash = stableWorkspaceHash(key);
    const actorLabel = clean(identity?.displayName) || clean(identity?.email) || clean(identity?.teacherId) || "교사";
    const explicitOrganizationId = clean(identity?.organizationId).toLowerCase();
    const organizationId = /^(?:default|teacher_[a-z0-9]{7,16})$/.test(explicitOrganizationId)
        ? explicitOrganizationId
        : `teacher_${hash}`;
    return {
        organizationId,
        organizationName: clean(identity?.organizationName) || `${actorLabel} Workspace`,
        actorUserId: `teacher_${hash}`,
        actorEmail: clean(identity?.email).toLowerCase() || undefined,
        actorLabel,
        memberRole: identity?.memberRole,
    };
}

export function workspaceBootstrapRows(
    context: WorkspaceContext,
    updatedAt = new Date().toISOString(),
): WorkspaceBootstrapRows {
    const actorUserId = clean(context.actorUserId);
    const actorEmail = clean(context.actorEmail).toLowerCase() || null;
    const actorLabel = clean(context.actorLabel) || actorEmail || actorUserId || "교사";
    const organizationName = clean(context.organizationName) || DEFAULT_WORKSPACE_ORGANIZATION_NAME;

    const rows: WorkspaceBootstrapRows = {
        organization: {
            id: context.organizationId,
            name: organizationName,
            plan: "free",
            metadata: {
                source: "omr_maker_workspace",
                authSource: actorUserId ? "teacher_session" : "default",
            },
            updated_at: updatedAt,
        },
    };

    if (!actorUserId) return rows;

    rows.userProfile = {
        user_id: actorUserId,
        email: actorEmail,
        display_name: actorLabel,
        locale: "ko-KR",
        timezone: "Asia/Seoul",
        status: "active",
        metadata: {
            source: "omr_maker_workspace",
            authSource: "teacher_session",
        },
        updated_at: updatedAt,
    };
    rows.member = {
        organization_id: context.organizationId,
        user_id: actorUserId,
        email: actorEmail,
        display_name: actorLabel,
        role: context.memberRole || "owner",
        status: "active",
        updated_at: updatedAt,
    };
    rows.teacherProfile = {
        organization_id: context.organizationId,
        user_id: actorUserId,
        display_name: actorLabel,
        status: "active",
        metadata: {
            source: "omr_maker_workspace",
            authSource: "teacher_session",
        },
        updated_at: updatedAt,
    };

    return rows;
}

export function workspaceContextFromTeacherSession(
    session: TeacherSession | null | undefined,
    now = Date.now(),
): WorkspaceContext {
    if (!isTeacherSessionActive(session, now)) return DEFAULT_CONTEXT;
    return workspaceContextFromIdentity(session);
}

export function readActiveWorkspaceContext(
    storage?: TeacherSessionStorage | null,
    now = Date.now(),
): WorkspaceContext {
    return workspaceContextFromTeacherSession(readTeacherSession(storage, now), now);
}
