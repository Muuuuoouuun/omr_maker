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
    fetchExamRowById,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminReadClientLike,
} from "@/lib/supabaseServerAdmin";
import { resolveTeacherServerMode, type TeacherDataStatus } from "@/lib/teacherServerAccess";
import {
    deleteExamCascadeForOrg,
    fetchExamRowsForOrg,
    saveExamRowWithQuestions,
    type TeacherAdminClientLike,
} from "@/lib/teacherServerQueries";
import {
    examFromSupabaseRow,
    examQuestionRowsForExam,
    examToSupabaseRow,
    sanitizeExamPayload,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import type { Exam } from "@/types/omr";

type TeacherAdmin = TeacherAdminClientLike & SupabaseAdminReadClientLike;

interface TeacherCtx {
    context: WorkspaceContext;
    admin: TeacherAdmin;
}

type CtxDenied = { status: "unauthenticated" | "degraded_local" | "denied" };

/**
 * Resolve the trusted teacher request context. Identity comes ONLY from the
 * signed server-session cookie — never from the client payload — so the
 * organization scope cannot be forged. Applies the fail-closed policy: in
 * production without a service role the request is denied (the client must fall
 * back to its own on-device cache, never the publishable key).
 */
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
        admin: createSupabaseAdminClient(config) as unknown as TeacherAdmin,
    };
}

function isCtx(value: TeacherCtx | CtxDenied): value is TeacherCtx {
    return "admin" in value;
}

/**
 * Force the exam onto the teacher's trusted organization. The client-supplied
 * organizationId / createdByUserId are ignored so a crafted payload can never
 * write into (or read back from) another org's scope.
 */
function scopeExamToContext(exam: Exam, context: WorkspaceContext): Exam {
    return {
        ...exam,
        organizationId: context.organizationId,
        createdByUserId: context.actorUserId || context.organizationId,
    };
}

export interface ListTeacherExamsResult {
    status: TeacherDataStatus;
    exams?: Exam[];
}

export async function listTeacherExamsAction(): Promise<ListTeacherExamsResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const rows = await fetchExamRowsForOrg(ctx.admin, ctx.context.organizationId);
        const exams = rows
            .map(row => { try { return examFromSupabaseRow(row); } catch { return null; } })
            .filter((exam): exam is Exam => !!exam);
        return { status: "ok", exams };
    } catch (e) {
        console.error("listTeacherExamsAction failed", e);
        return { status: "error" };
    }
}

export interface LoadTeacherExamResult {
    status: TeacherDataStatus;
    exam?: Exam;
}

export async function loadTeacherExamAction(examId: string): Promise<LoadTeacherExamResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const row = await fetchExamRowById(ctx.admin, examId, { organizationId: ctx.context.organizationId });
        if (!row) return { status: "not_found" };
        return { status: "ok", exam: examFromSupabaseRow(row as SupabaseExamRow) };
    } catch (e) {
        console.error("loadTeacherExamAction failed", e);
        return { status: "error" };
    }
}

export async function saveTeacherExamAction(exam: Exam): Promise<LoadTeacherExamResult> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const sanitized = sanitizeExamPayload(exam);
        if (!sanitized) return { status: "error" };
        const scoped = scopeExamToContext(sanitized, ctx.context);
        const examRow = examToSupabaseRow(scoped, ctx.context);
        const questionRows = examQuestionRowsForExam(scoped, undefined, ctx.context);
        await saveExamRowWithQuestions(ctx.admin, ctx.context.organizationId, examRow, questionRows);
        return { status: "ok", exam: scoped };
    } catch (e) {
        console.error("saveTeacherExamAction failed", e);
        return { status: "error" };
    }
}

export async function deleteTeacherExamAction(examId: string): Promise<{ status: TeacherDataStatus }> {
    const ctx = await resolveTeacherCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        await deleteExamCascadeForOrg(ctx.admin, ctx.context.organizationId, examId);
        return { status: "ok" };
    } catch (e) {
        console.error("deleteTeacherExamAction failed", e);
        return { status: "error" };
    }
}
