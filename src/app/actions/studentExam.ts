"use server";

import { cookies } from "next/headers";
import { randomUUID } from "node:crypto";
import { parseSignedStudentSessionCookie, STUDENT_SERVER_SESSION_COOKIE, type StudentServerIdentity } from "@/lib/studentServerSession";
import { getSupabaseServerConfigFromEnv, createSupabaseAdminClient, fetchAttemptRowsByOwner, fetchExamRowById, type SupabaseAdminClientLike, type SupabaseAdminReadClientLike } from "@/lib/supabaseServerAdmin";
import { attemptFromSupabaseRow, examFromSupabaseRow, attemptToSupabaseRow, questionResultRowsForAttempt } from "@/lib/omrPersistence";
import { evaluateExamAccess, verifyExamPin } from "@/lib/examAccess";
import { stripExamForSolving, type SolvableExam } from "@/lib/examSolvePayload";
import { attemptOwnedBy, buildServerAttempt, identityAccessSession, ownerStudentId, type SubmitAttemptInput } from "@/lib/studentExamCore";
import type { Attempt } from "@/types/omr";

type Status = "ok" | "unauthenticated" | "degraded_local" | "denied" | "error";
type AccessStatus = "pin_required" | "login_required" | "group_denied" | "not_started" | "ended" | "archived";

type AdminClient = SupabaseAdminClientLike & SupabaseAdminReadClientLike;

interface ResolvedCtx {
    identity: StudentServerIdentity;
    admin: AdminClient;
}

async function resolveCtx(): Promise<ResolvedCtx | { status: "unauthenticated" | "degraded_local" }> {
    const cookieStore = await cookies();
    const identity = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (!identity) return { status: "unauthenticated" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "degraded_local" };
    return { identity, admin: createSupabaseAdminClient(config) as unknown as AdminClient };
}

function isCtx(value: ResolvedCtx | { status: "unauthenticated" | "degraded_local" }): value is ResolvedCtx {
    return "identity" in value;
}

async function ownAttempts(admin: AdminClient, identity: StudentServerIdentity): Promise<Attempt[]> {
    const rows = await fetchAttemptRowsByOwner(admin, { studentId: ownerStudentId(identity) });
    return rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .filter((a): a is Attempt => !!a && attemptOwnedBy(a, identity));
}

export interface SolveLoadResult {
    status: Status | AccessStatus;
    exam?: SolvableExam;
}

export async function loadExamForSolving(examId: string, pin?: string): Promise<SolveLoadResult> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const row = await fetchExamRowById(ctx.admin, examId);
        if (!row) return { status: "ended" };
        const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
        const access = evaluateExamAccess(exam, { session: identityAccessSession(ctx.identity), pinVerified: verifyExamPin(exam, pin ?? "") });
        if (access.status !== "allowed") return { status: access.status };
        return { status: "ok", exam: stripExamForSolving(exam) };
    } catch (e) {
        console.error("loadExamForSolving failed", e);
        return { status: "error" };
    }
}

export async function submitAttempt(input: SubmitAttemptInput, pin?: string): Promise<{ status: Status | AccessStatus; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const row = await fetchExamRowById(ctx.admin, input.examId);
        if (!row) return { status: "error" };
        const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
        const access = evaluateExamAccess(exam, { session: identityAccessSession(ctx.identity), pinVerified: verifyExamPin(exam, pin ?? "") });
        if (access.status !== "allowed") return { status: access.status };
        const attempt = buildServerAttempt(input, exam, ctx.identity, randomUUID(), new Date().toISOString());
        const attemptResult = await ctx.admin.from("omr_attempts").upsert(attemptToSupabaseRow(attempt));
        if (attemptResult.error) return { status: "error" };
        // question-results upsert is idempotent (keyed by attempt id); a client retry reconciles a partial write.
        const resultRows = questionResultRowsForAttempt(attempt);
        if (resultRows.length > 0) {
            const qrResult = await ctx.admin.from("omr_question_results").upsert(resultRows);
            if (qrResult.error) return { status: "error" };
        }
        return { status: "ok", attempt };
    } catch (e) {
        console.error("submitAttempt failed", e);
        return { status: "error" };
    }
}

export async function listMyAssignments(): Promise<{ status: Status; attempts?: Attempt[] }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        return { status: "ok", attempts: await ownAttempts(ctx.admin, ctx.identity) };
    } catch (e) {
        console.error("listMyAssignments failed", e);
        return { status: "error" };
    }
}

export async function loadMyAttempt(attemptId: string): Promise<{ status: Status; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const match = (await ownAttempts(ctx.admin, ctx.identity)).find(a => a.id === attemptId);
        return match ? { status: "ok", attempt: match } : { status: "denied" };
    } catch (e) {
        console.error("loadMyAttempt failed", e);
        return { status: "error" };
    }
}
