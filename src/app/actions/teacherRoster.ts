"use server";

import { cookies } from "next/headers";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import {
    DEFAULT_WORKSPACE_ORGANIZATION_NAME,
    workspaceContextFromTeacherSession,
    type WorkspaceContext,
} from "@/lib/workspaceContext";
import {
    bootstrapWorkspaceWithAdminClient,
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminClientLike,
} from "@/lib/supabaseServerAdmin";
import { resolveTeacherServerMode, type TeacherDataStatus } from "@/lib/teacherServerAccess";
import {
    fetchRosterRowsForOrg,
    saveRosterRows,
    type RosterReadClientLike,
    type TeacherAdminClientLike,
} from "@/lib/teacherServerQueries";
import {
    rosterSnapshotFromRemoteRows,
    rosterSnapshotToSupabaseRows,
    staleRosterRowsForSnapshot,
    type RosterSnapshot,
} from "@/lib/rosterPersistence";

type RosterAdmin = TeacherAdminClientLike & RosterReadClientLike & SupabaseAdminClientLike;

interface TeacherCtx {
    context: WorkspaceContext;
    admin: RosterAdmin;
}

type CtxDenied = { status: "unauthenticated" | "degraded_local" | "denied" };

async function resolveTeacherCtx(): Promise<TeacherCtx | CtxDenied> {
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthenticated" };

    const mode = resolveTeacherServerMode();
    if (mode === "denied") return { status: "denied" };
    if (mode === "degraded_local") return { status: "degraded_local" };

    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "degraded_local" };

    return {
        context: workspaceContextFromTeacherSession(session),
        admin: createSupabaseAdminClient(config) as unknown as RosterAdmin,
    };
}

function isCtx(value: TeacherCtx | CtxDenied): value is TeacherCtx {
    return "admin" in value;
}

export interface LoadTeacherRosterResult {
    status: TeacherDataStatus;
    snapshot?: RosterSnapshot;
}

export async function loadTeacherRosterAction(): Promise<LoadTeacherRosterResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const rows = await fetchRosterRowsForOrg(ctx.admin, ctx.context.organizationId);
        return { status: "ok", snapshot: rosterSnapshotFromRemoteRows(rows) };
    } catch (e) {
        console.error("loadTeacherRosterAction failed", e);
        return { status: "error" };
    }
}

/**
 * Persist the roster snapshot into the teacher's org. Organization scope is
 * forced from the trusted session on every class/student/enrollment row, so the
 * (PII-bearing) student profiles can only ever land in this teacher's org. Rows
 * dropped from the snapshot are archived/withdrawn within the same org scope.
 */
export async function saveTeacherRosterAction(snapshot: RosterSnapshot): Promise<{ status: TeacherDataStatus }> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const organizationId = ctx.context.organizationId;
        const organizationName = ctx.context.organizationName || DEFAULT_WORKSPACE_ORGANIZATION_NAME;

        const bootstrap = await bootstrapWorkspaceWithAdminClient(ctx.admin, ctx.context);
        if (!bootstrap.ok) return { status: "error" };

        const remoteRows = await fetchRosterRowsForOrg(ctx.admin, organizationId);
        const rows = rosterSnapshotToSupabaseRows(snapshot, organizationId, undefined, organizationName);
        const staleRows = staleRosterRowsForSnapshot(snapshot, remoteRows, organizationId);

        await saveRosterRows(ctx.admin, {
            classes: [...rows.classes, ...staleRows.classes],
            students: [...rows.students, ...staleRows.students],
            enrollments: [...rows.enrollments, ...staleRows.enrollments],
        });
        return { status: "ok" };
    } catch (e) {
        console.error("saveTeacherRosterAction failed", e);
        return { status: "error" };
    }
}
