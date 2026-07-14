"use server";

import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import {
    parseSignedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    type StudentServerIdentity,
} from "@/lib/studentServerSession";
import {
    createSupabaseAdminClient,
    fetchAttemptRowsByOwner,
    fetchExamRowById,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminClientLike,
    type SupabaseAdminReadClientLike,
} from "@/lib/supabaseServerAdmin";
import { resolveStudentServerMode } from "@/lib/studentServerAccess";
import {
    attemptFromSupabaseRow,
    attemptToSupabaseRow,
    examFromSupabaseRow,
    questionResultRowsForAttempt,
} from "@/lib/omrPersistence";
import { evaluateExamAccess, examRequiresPin, verifyExamPin } from "@/lib/examAccess";
import {
    buildExamPinRateLimitKey,
    checkExamPinRateLimit,
    recordExamPinFailure,
    recordExamPinSuccess,
} from "@/lib/examPinRateLimit";
import { stripExamForReview, stripExamForSolving, type ReviewableExam, type SolvableExam } from "@/lib/examSolvePayload";
import {
    attemptOwnedBy,
    attemptOwnerScope,
    buildServerAttempt,
    identityAccessSession,
    ownerStudentId,
    resolveAttemptId,
    scopedIdempotencyKey,
    serverStudentProfileId,
    type SubmitAttemptInput,
} from "@/lib/studentExamCore";
import type { Attempt, Exam } from "@/types/omr";

type Status = "ok" | "unauthenticated" | "degraded_local" | "denied" | "not_found" | "error";
type AccessStatus = "pin_required" | "pin_rate_limited" | "login_required" | "group_denied" | "not_started" | "ended" | "archived";

/**
 * Grace window (ms) after endAt during which an in-flight submission is still
 * accepted. Mirrors the +5min clampStartedAt grace so a boundary auto-submit is
 * stored instead of stranded in the device-local draft.
 */
const SUBMIT_ENDAT_GRACE_MS = 2 * 60 * 1000;

type AdminClient = SupabaseAdminClientLike & SupabaseAdminReadClientLike & {
    rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
};

interface ResolvedCtx {
    identity: StudentServerIdentity;
    admin: AdminClient;
    clientIp: string;
}

function clientIpFromHeaders(headerStore: Headers): string {
    return headerStore.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headerStore.get("x-real-ip")?.trim()
        || "";
}

/**
 * Resolve the request context, applying the fail-closed policy. In production with
 * no service role we return `denied` — NOT `degraded_local` — so the client cannot
 * fall back to reading the answer-bearing local exam copy. `degraded_local` is
 * only ever returned outside production.
 */
async function resolveCtx(): Promise<ResolvedCtx | { status: "unauthenticated" | "degraded_local" | "denied" }> {
    const cookieStore = await cookies();
    const identity = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (!identity) return { status: "unauthenticated" };

    const mode = resolveStudentServerMode();
    if (mode === "denied") return { status: "denied" };
    if (mode === "degraded_local") return { status: "degraded_local" };

    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "degraded_local" };
    const headerStore = await headers();
    return {
        identity,
        admin: createSupabaseAdminClient(config) as unknown as AdminClient,
        clientIp: clientIpFromHeaders(headerStore),
    };
}

function isCtx(value: ResolvedCtx | { status: string }): value is ResolvedCtx {
    return "identity" in value;
}

/**
 * PIN gate with brute-force protection over the shared atomic counter store.
 * Failures are counted per (exam, identity) and per (exam, ip); no whole-exam
 * lockout, so one sweeper cannot lock the class out.
 */
async function evaluateGatedAccess(
    exam: Exam,
    identity: StudentServerIdentity,
    pin: string | undefined,
    clientIp: string,
    options: { graceMs?: number } = {},
): Promise<"allowed" | AccessStatus> {
    const pinProvided = typeof pin === "string" && pin.trim().length > 0;
    let pinVerified: boolean;
    if (examRequiresPin(exam) && pinProvided) {
        const rateKeys = buildExamPinRateLimitKey(exam.id, ownerStudentId(identity), clientIp);
        if (!(await checkExamPinRateLimit(rateKeys)).allowed) return "pin_rate_limited";
        pinVerified = verifyExamPin(exam, pin);
        if (pinVerified) await recordExamPinSuccess(rateKeys);
        else await recordExamPinFailure(rateKeys);
    } else {
        pinVerified = verifyExamPin(exam, pin ?? "");
    }
    const accessContext = { session: identityAccessSession(identity), pinVerified };
    const access = evaluateExamAccess(exam, accessContext);
    if (access.status === "allowed") return "allowed";
    if (access.status === "ended" && options.graceMs) {
        const graced = evaluateExamAccess(exam, { ...accessContext, now: Date.now() - options.graceMs });
        if (graced.status === "allowed") return "allowed";
    }
    return access.status;
}

/** Read the exam row scoped to the identity's org (students) or unscoped (guests). */
async function readExam(ctx: ResolvedCtx, examId: string): Promise<Exam | null> {
    const scope = ctx.identity.kind === "student" && ctx.identity.organizationId
        ? { organizationId: ctx.identity.organizationId }
        : {};
    const row = await fetchExamRowById(ctx.admin, examId, scope);
    if (!row) return null;
    return examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
}

async function ownAttempts(ctx: ResolvedCtx): Promise<Attempt[]> {
    const rows = await fetchAttemptRowsByOwner(ctx.admin, attemptOwnerScope(ctx.identity));
    return rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .filter((a): a is Attempt => !!a && attemptOwnedBy(a, ctx.identity));
}

export interface SolveLoadResult {
    status: Status | AccessStatus;
    exam?: SolvableExam;
}

export async function loadExamForSolving(examId: string, pin?: string): Promise<SolveLoadResult> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const exam = await readExam(ctx, examId);
        // Distinct from "ended": lets a dev/degraded client fall back to a local copy.
        if (!exam) return { status: "not_found" };
        const access = await evaluateGatedAccess(exam, ctx.identity, pin, ctx.clientIp);
        if (access !== "allowed") return { status: access };
        return { status: "ok", exam: stripExamForSolving(exam) };
    } catch (e) {
        console.error("loadExamForSolving failed", e);
        return { status: "error" };
    }
}

/**
 * Idempotent, atomic submit. The attempt id is derived from the client idempotency
 * key so a double-submit collapses onto one row, and the attempt + its question
 * results are written in a single transactional RPC so a partial failure cannot
 * leave a half-recorded attempt. student_profile_id is forced to the identity's
 * real profile id (or null for guests/quick-entry) so the FK stays valid.
 */
export async function submitAttempt(input: SubmitAttemptInput, pin?: string): Promise<{ status: Status | AccessStatus; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const exam = await readExam(ctx, input.examId);
        if (!exam) return { status: "not_found" };
        const access = await evaluateGatedAccess(exam, ctx.identity, pin, ctx.clientIp, { graceMs: SUBMIT_ENDAT_GRACE_MS });
        if (access !== "allowed") return { status: access };

        const attemptId = resolveAttemptId(input, ctx.identity, randomUUID());
        const attempt = buildServerAttempt(input, exam, ctx.identity, attemptId, new Date().toISOString());
        const profileId = serverStudentProfileId(ctx.identity);
        const attemptRow = {
            ...attemptToSupabaseRow(attempt),
            student_profile_id: profileId,
            idempotency_key: scopedIdempotencyKey(input, ctx.identity),
        };
        const resultRows = questionResultRowsForAttempt(attempt).map(row => ({ ...row, student_profile_id: profileId }));

        const { error } = await ctx.admin.rpc("omr_submit_attempt", { p_attempt: attemptRow, p_results: resultRows });
        if (error) return { status: "error" };
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
        return { status: "ok", attempts: await ownAttempts(ctx) };
    } catch (e) {
        console.error("listMyAssignments failed", e);
        return { status: "error" };
    }
}

export async function loadMyAttempt(attemptId: string): Promise<{ status: Status | "denied"; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const match = (await ownAttempts(ctx)).find(a => a.id === attemptId);
        return match ? { status: "ok", attempt: match } : { status: "denied" };
    } catch (e) {
        console.error("loadMyAttempt failed", e);
        return { status: "error" };
    }
}

/**
 * Post-submit review payload: the exam WITH answers and explanations (the student
 * already submitted), but the inline PIN and the teacher's answer-key PDF never
 * leave the server. Only returned to the attempt's owner.
 */
export async function loadExamForReview(
    attemptId: string,
): Promise<{ status: Status | "denied"; exam?: ReviewableExam }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const match = (await ownAttempts(ctx)).find(a => a.id === attemptId);
        if (!match) return { status: "denied" };
        const exam = await readExam(ctx, match.examId);
        if (!exam) return { status: "not_found" };
        return { status: "ok", exam: stripExamForReview(exam) };
    } catch (e) {
        console.error("loadExamForReview failed", e);
        return { status: "error" };
    }
}
