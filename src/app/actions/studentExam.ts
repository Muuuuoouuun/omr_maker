"use server";

import { cookies } from "next/headers";
import { parseSignedStudentSessionCookie, resolveStudentSessionSecret, STUDENT_SERVER_SESSION_COOKIE, type StudentServerIdentity } from "@/lib/studentServerSession";
import { getSupabaseServerConfigFromEnv, createSupabaseAdminClient, fetchAttemptRowByOwnerAndId, fetchAttemptRowsByOwner, fetchExamRowById, fetchExamRowsByOrganization, type SupabaseAdminClientLike, type SupabaseAdminReadClientLike } from "@/lib/supabaseServerAdmin";
import { attemptFromSupabaseRow, examFromSupabaseRow, attemptToSupabaseRow, questionResultRowsForAttempt } from "@/lib/omrPersistence";
import { evaluateExamAccess, examRequiresPin, verifyExamPin } from "@/lib/examAccess";
import {
    buildExamPinRateLimitKey,
    checkExamPinRateLimit,
    recordExamPinFailure,
    recordExamPinSuccess,
} from "@/lib/examPinRateLimit";
import { stripExamForReview, stripExamForSolving, type ReviewableExam, type SolvableExam } from "@/lib/examSolvePayload";
import { attemptOwnedBy, buildServerAttempt, identityAccessSession, ownerStudentId, type SubmitAttemptInput } from "@/lib/studentExamCore";
import { upsertStudentQuestion, type StudentQuestionInput } from "@/lib/studentQuestions";
import { attemptIdForStudentSubmission } from "@/lib/studentSubmissionId";
import type { Attempt, Exam } from "@/types/omr";
import type { PlanKey } from "@/types/omr";
import { hasPlanEntitlement, normalizePlan } from "@/utils/plans";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import {
    createStudentProblemPdfSignedUrlWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "@/lib/remoteAssetGateway.server";

type Status = "ok" | "unauthenticated" | "degraded_local" | "denied" | "not_found" | "error";
type AccessStatus = "pin_required" | "pin_rate_limited" | "login_required" | "group_denied" | "not_started" | "ended" | "archived";

/**
 * Grace window (ms) after endAt during which an in-flight submission is still
 * accepted. A student who started before the window closed and whose auto-submit
 * fires right at the boundary would otherwise have the attempt dropped and their
 * answers stranded in the device-local draft. Mirrors the +5min clampStartedAt
 * grace already applied when persisting startedAt.
 */
const SUBMIT_ENDAT_GRACE_MS = 2 * 60 * 1000;

/**
 * PIN gate with brute-force protection. The PIN itself stays stateless (sent
 * per request); failures are counted per (exam, identity) so a wrong-PIN sweep
 * locks only the sweeping identity, not the class.
 *
 * `graceMs` (submit path only) relaxes the endAt boundary so a boundary
 * auto-submit is stored instead of rejected. It never relaxes archived,
 * not_started, group, or PIN gating — those statuses are returned as-is.
 */
function evaluateGatedAccess(
    exam: Exam,
    identity: StudentServerIdentity,
    pin: string | undefined,
    options: { graceMs?: number } = {},
): "allowed" | AccessStatus {
    const pinProvided = typeof pin === "string" && pin.trim().length > 0;
    let pinVerified: boolean;
    if (examRequiresPin(exam) && pinProvided) {
        const rateKeys = buildExamPinRateLimitKey(exam.id, ownerStudentId(identity));
        if (!checkExamPinRateLimit(rateKeys).allowed) return "pin_rate_limited";
        pinVerified = verifyExamPin(exam, pin);
        if (pinVerified) recordExamPinSuccess(rateKeys);
        else recordExamPinFailure(rateKeys);
    } else {
        pinVerified = verifyExamPin(exam, pin ?? "");
    }
    const accessContext = { session: identityAccessSession(identity), pinVerified };
    const access = evaluateExamAccess(exam, accessContext);
    if (access.status === "allowed") return "allowed";
    // Only the endAt boundary is relaxed, and only within the grace window:
    // re-evaluate with a rewound clock so the other gates still apply.
    if (access.status === "ended" && options.graceMs) {
        const graced = evaluateExamAccess(exam, { ...accessContext, now: Date.now() - options.graceMs });
        if (graced.status === "allowed") return "allowed";
    }
    return access.status;
}

type AdminClient = SupabaseAdminClientLike & SupabaseAdminReadClientLike & {
    rpc(name: "omr_submit_session_attempt_v1", params: {
        p_attempt: unknown;
        p_question_results: unknown;
    }): Promise<{ data: unknown; error: { message?: string } | null }>;
};

interface ResolvedCtx {
    identity: StudentServerIdentity;
    admin: AdminClient;
}

async function examOwnerPremium(
    admin: AdminClient,
    exam: Exam,
    cache?: Map<string, Promise<{ plan: PlanKey; handwritingArchive: boolean }>>,
): Promise<{ plan: PlanKey; handwritingArchive: boolean }> {
    if (!exam.organizationId) return { plan: "free", handwritingArchive: false };
    const read = async () => {
        const { data, error } = await (admin as SupabaseAdminReadClientLike).from("omr_organizations")
            .select("plan")
            .eq("id", exam.organizationId!)
            .maybeSingle();
        if (error || !data) return { plan: "free" as const, handwritingArchive: false };
        const plan = normalizePlan((data as { plan?: unknown }).plan) || "free";
        return { plan, handwritingArchive: hasPlanEntitlement(plan, "handwritingArchive") };
    };
    if (!cache) return read();
    const existing = cache.get(exam.organizationId);
    if (existing) return existing;
    const pending = read();
    cache.set(exam.organizationId, pending);
    return pending;
}

async function resolveCtx(): Promise<ResolvedCtx | { status: "unauthenticated" | "degraded_local" | "error" }> {
    const config = getSupabaseServerConfigFromEnv();
    // Development/offline builds may legitimately run from device-local data
    // without a server cookie. Production must never silently downgrade the
    // canonical grading boundary when its database gateway is missing.
    if (!config) {
        return { status: process.env.NODE_ENV === "production" ? "error" : "degraded_local" };
    }
    const cookieStore = await cookies();
    const identity = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (!identity) return { status: "unauthenticated" };
    return { identity, admin: createSupabaseAdminClient(config) as unknown as AdminClient };
}

function isCtx(value: ResolvedCtx | { status: "unauthenticated" | "degraded_local" | "error" }): value is ResolvedCtx {
    return "identity" in value;
}

async function ownAttempts(admin: AdminClient, identity: StudentServerIdentity): Promise<Attempt[]> {
    const rows = await fetchAttemptRowsByOwner(admin, { studentId: ownerStudentId(identity) });
    return rows
        .map(r => { try { return attemptFromSupabaseRow(r as Parameters<typeof attemptFromSupabaseRow>[0]); } catch { return null; } })
        .filter((a): a is Attempt => !!a && attemptOwnedBy(a, identity));
}

async function ownAttempt(
    admin: AdminClient,
    identity: StudentServerIdentity,
    attemptId: string,
): Promise<Attempt | null> {
    const row = await fetchAttemptRowByOwnerAndId(
        admin,
        { studentId: ownerStudentId(identity) },
        attemptId,
    );
    if (!row) return null;
    try {
        const attempt = attemptFromSupabaseRow(row as Parameters<typeof attemptFromSupabaseRow>[0]);
        return attemptOwnedBy(attempt, identity) ? attempt : null;
    } catch {
        return null;
    }
}

function attemptFromRpcPayload(data: unknown): Attempt | null {
    const candidate = Array.isArray(data) ? data[0] : data;
    if (!candidate || typeof candidate !== "object") return null;
    const payload = (candidate as { payload?: unknown }).payload;
    return payload && typeof payload === "object" ? payload as Attempt : null;
}

async function saveSessionAttemptAtomically(
    admin: AdminClient,
    identity: StudentServerIdentity,
    attempt: Attempt,
): Promise<Attempt | null> {
    const result = await admin.rpc("omr_submit_session_attempt_v1", {
        p_attempt: attemptToSupabaseRow(attempt),
        p_question_results: questionResultRowsForAttempt(attempt),
    });
    if (result.error) return null;
    const stored = attemptFromRpcPayload(result.data);
    return stored && attemptOwnedBy(stored, identity) ? stored : null;
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
        // Distinct from "ended": lets the client fall back to a locally-synced copy
        // (offline-created exams, dev without sync). Exam ids are non-enumerable UUIDs.
        if (!row) return { status: "not_found" };
        const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
        const access = evaluateGatedAccess(exam, ctx.identity, pin);
        if (access !== "allowed") return { status: access };
        const premium = await examOwnerPremium(ctx.admin, exam);
        const solvableExam = stripExamForSolving(exam, { handwritingArchive: premium.handwritingArchive });
        const problemRef = solvableExam.pdfDataRef;
        if (!isRemoteAssetStoredDataRef(problemRef)) {
            return { status: "ok", exam: solvableExam };
        }
        if (problemRef.kind !== "problem_pdf" || problemRef.examId !== exam.id) {
            return { status: "error" };
        }
        const signed = await createStudentProblemPdfSignedUrlWithGateway(
            ctx.admin as unknown as RemoteAssetSupabaseGatewayClient,
            {
                assetId: problemRef.key,
                organizationId: problemRef.organizationId,
                examId: exam.id,
            },
        );
        if (signed.status !== "signed") return { status: "error" };
        return {
            status: "ok",
            exam: {
                ...solvableExam,
                pdfData: signed.signedUrl,
                pdfDataRef: undefined,
            },
        };
    } catch (e) {
        console.error("loadExamForSolving failed", e);
        return { status: "error" };
    }
}

export async function submitAttempt(input: SubmitAttemptInput, pin?: string): Promise<{ status: Status | AccessStatus; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const attemptId = attemptIdForStudentSubmission({
            submissionId: input.submissionId,
            examId: input.examId,
            ownerStudentId: ownerStudentId(ctx.identity),
            secret: resolveStudentSessionSecret(),
        });
        if (!attemptId) return { status: "error" };
        const existingAttempt = await ownAttempt(ctx.admin, ctx.identity, attemptId);
        if (existingAttempt) {
            // This also repairs analytical rows if an older app version wrote
            // only the canonical attempt before its second query failed.
            const repaired = await saveSessionAttemptAtomically(ctx.admin, ctx.identity, existingAttempt);
            return repaired ? { status: "ok", attempt: repaired } : { status: "error" };
        }

        const row = await fetchExamRowById(ctx.admin, input.examId);
        if (!row) return { status: "not_found" };
        const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
        const access = evaluateGatedAccess(exam, ctx.identity, pin, { graceMs: SUBMIT_ENDAT_GRACE_MS });
        if (access !== "allowed") return { status: access };
        const premium = await examOwnerPremium(ctx.admin, exam);
        const attempt = buildServerAttempt(input, exam, ctx.identity, attemptId, new Date().toISOString(), {
            handwritingArchive: premium.handwritingArchive,
            handwritingPlan: premium.plan,
        });
        const stored = await saveSessionAttemptAtomically(ctx.admin, ctx.identity, attempt);
        return stored ? { status: "ok", attempt: stored } : { status: "error" };
    } catch (e) {
        console.error("submitAttempt failed", e);
        return { status: "error" };
    }
}

export async function listMyAssignments(): Promise<{ status: Status; attempts?: Attempt[]; exams?: SolvableExam[] }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const [attempts, examRows] = await Promise.all([
            ownAttempts(ctx.admin, ctx.identity),
            ctx.identity.organizationId
                ? fetchExamRowsByOrganization(ctx.admin, ctx.identity.organizationId)
                : Promise.resolve([]),
        ]);
        const premiumByOrganization = new Map<string, Promise<{ plan: PlanKey; handwritingArchive: boolean }>>();
        const exams = (await Promise.all(examRows.map(async row => {
            try {
                const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
                const access = evaluateGatedAccess(exam, ctx.identity, undefined);
                if (access !== "allowed" && access !== "pin_required") return [];
                const premium = await examOwnerPremium(ctx.admin, exam, premiumByOrganization);
                return [stripExamForSolving(exam, { handwritingArchive: premium.handwritingArchive })];
            } catch {
                return [];
            }
        }))).flat();
        return { status: "ok", attempts, exams };
    } catch (e) {
        console.error("listMyAssignments failed", e);
        return { status: "error" };
    }
}

export async function loadMyAttempt(attemptId: string): Promise<{ status: Status; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const match = await ownAttempt(ctx.admin, ctx.identity, attemptId);
        return match ? { status: "ok", attempt: match } : { status: "denied" };
    } catch (e) {
        console.error("loadMyAttempt failed", e);
        return { status: "error" };
    }
}

/**
 * Post-submit review payload: the exam WITH answers and explanations (the
 * student already submitted), but the inline PIN and the teacher's answer-key
 * PDF never leave the server. Only returned to the attempt's owner.
 */
export async function loadExamForReview(
    attemptId: string,
): Promise<{ status: Status | "denied"; exam?: ReviewableExam }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const match = await ownAttempt(ctx.admin, ctx.identity, attemptId);
        if (!match) return { status: "denied" };
        const row = await fetchExamRowById(ctx.admin, match.examId);
        if (!row) return { status: "not_found" };
        const exam = examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
        const reviewExam = stripExamForReview(exam);
        const problemRef = exam.pdfDataRef;
        if (!isRemoteAssetStoredDataRef(problemRef)) {
            return { status: "ok", exam: reviewExam };
        }
        if (problemRef.kind !== "problem_pdf" || problemRef.examId !== exam.id) {
            return { status: "error" };
        }
        const signed = await createStudentProblemPdfSignedUrlWithGateway(
            ctx.admin as unknown as RemoteAssetSupabaseGatewayClient,
            {
                assetId: problemRef.key,
                organizationId: problemRef.organizationId,
                examId: exam.id,
            },
        );
        if (signed.status !== "signed") return { status: "error" };
        return {
            status: "ok",
            exam: {
                ...reviewExam,
                pdfData: signed.signedUrl,
                pdfDataRef: undefined,
            },
        };
    } catch (e) {
        console.error("loadExamForReview failed", e);
        return { status: "error" };
    }
}

/**
 * Leave (or replace) a per-question free-text question on the student's OWN
 * attempt. Ownership comes from the signed session cookie; the note is merged
 * server-side so a crafted client cannot touch anyone else's attempt.
 */
export async function askAttemptQuestion(
    attemptId: string,
    question: StudentQuestionInput,
): Promise<{ status: Status | "denied"; attempt?: Attempt }> {
    const ctx = await resolveCtx();
    if (!isCtx(ctx)) return ctx;
    try {
        const match = await ownAttempt(ctx.admin, ctx.identity, attemptId);
        if (!match) return { status: "denied" };
        const updated = upsertStudentQuestion(match, question, new Date().toISOString());
        if (!updated) return { status: "error" };
        const result = await ctx.admin.from("omr_attempts").upsert(attemptToSupabaseRow(updated));
        if (result.error) return { status: "error" };
        return { status: "ok", attempt: updated };
    } catch (e) {
        console.error("askAttemptQuestion failed", e);
        return { status: "error" };
    }
}
