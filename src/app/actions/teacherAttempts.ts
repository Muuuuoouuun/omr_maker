"use server";

import { cookies } from "next/headers";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import {
    workspaceContextFromTeacherSession,
    type WorkspaceContext,
} from "@/lib/workspaceContext";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import { resolveTeacherServerMode, type TeacherDataStatus } from "@/lib/teacherServerAccess";
import {
    fetchAttemptOrganizationId,
    fetchAttemptRowByIdForOrg,
    fetchAttemptRowsForOrg,
    saveAttemptRowWithResults,
    type TeacherAdminClientLike,
} from "@/lib/teacherServerQueries";
import {
    attemptFromSupabaseRow,
    attemptToSupabaseRow,
    questionResultRowsForAttempt,
    sanitizeAttemptPayload,
} from "@/lib/omrPersistence";
import type { Attempt } from "@/types/omr";

interface TeacherCtx {
    context: WorkspaceContext;
    admin: TeacherAdminClientLike;
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
        admin: createSupabaseAdminClient(config) as unknown as TeacherAdminClientLike,
    };
}

function isCtx(value: TeacherCtx | CtxDenied): value is TeacherCtx {
    return "admin" in value;
}

export interface ListTeacherAttemptsResult {
    status: TeacherDataStatus;
    attempts?: Attempt[];
}

export async function listTeacherAttemptsAction(): Promise<ListTeacherAttemptsResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const rows = await fetchAttemptRowsForOrg(ctx.admin, ctx.context.organizationId);
        const attempts = rows
            .map(row => { try { return attemptFromSupabaseRow(row); } catch { return null; } })
            .filter((attempt): attempt is Attempt => !!attempt);
        return { status: "ok", attempts };
    } catch (e) {
        console.error("listTeacherAttemptsAction failed", e);
        return { status: "error" };
    }
}

export interface LoadTeacherAttemptResult {
    status: TeacherDataStatus;
    attempt?: Attempt;
}

export async function loadTeacherAttemptAction(attemptId: string): Promise<LoadTeacherAttemptResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const row = await fetchAttemptRowByIdForOrg(ctx.admin, ctx.context.organizationId, attemptId);
        if (!row) return { status: "not_found" };
        return { status: "ok", attempt: attemptFromSupabaseRow(row) };
    } catch (e) {
        console.error("loadTeacherAttemptAction failed", e);
        return { status: "error" };
    }
}

/**
 * Save (upsert) an attempt the teacher owns — e.g. a Q&A answer merge, a
 * feedback-bearing attempt, or a repaired/synthetic row. The organization is
 * forced to the teacher's trusted scope, and an id that already belongs to a
 * DIFFERENT org is refused (`denied`) so a crafted id can never overwrite
 * another organization's attempt.
 */
export async function saveTeacherAttemptAction(attempt: Attempt): Promise<LoadTeacherAttemptResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const sanitized = sanitizeAttemptPayload(attempt);
        if (!sanitized) return { status: "error" };

        const existingOrg = await fetchAttemptOrganizationId(ctx.admin, sanitized.id);
        if (existingOrg && existingOrg !== ctx.context.organizationId) {
            return { status: "denied" };
        }

        const scoped: Attempt = { ...sanitized, organizationId: ctx.context.organizationId };
        const attemptRow = attemptToSupabaseRow(scoped, ctx.context);
        const resultRows = questionResultRowsForAttempt(scoped, undefined, ctx.context);
        await saveAttemptRowWithResults(ctx.admin, attemptRow, resultRows);
        return { status: "ok", attempt: scoped };
    } catch (e) {
        console.error("saveTeacherAttemptAction failed", e);
        return { status: "error" };
    }
}
