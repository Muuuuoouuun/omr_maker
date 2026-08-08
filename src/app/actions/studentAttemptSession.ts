"use server";

import { randomUUID } from "node:crypto";
import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    fetchAttemptRowByOwnerAndId,
    fetchExamRowById,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminReadClientLike,
} from "@/lib/supabaseServerAdmin";
import { attemptFromSupabaseRow, examFromSupabaseRow } from "@/lib/omrPersistence";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    parseSignedStudentSessionCookie,
    resolveStudentSessionSecret,
    STUDENT_SERVER_SESSION_COOKIE,
    type StudentServerIdentity,
} from "@/lib/studentServerSession";
import { ownerStudentId } from "@/lib/studentExamCore";
import { parseStudentAttemptTicket } from "@/lib/studentAttemptTicket";
import { authorizeStudentAttemptSessionScope } from "@/lib/studentAttemptSessionAuthorization.server";
import { leaseTokenHash } from "@/lib/studentAttemptSessionCrypto.server";
import {
    checkpointStudentAttemptSessionWithGateway,
    commitStudentAttemptSessionSubmitWithGateway,
    heartbeatStudentAttemptSessionWithGateway,
    openStudentAttemptSessionWithGateway,
    prepareStudentAttemptSessionSubmitWithGateway,
    takeoverStudentAttemptSessionWithGateway,
    type StudentAttemptSessionRpcClient,
} from "@/lib/studentAttemptSessionGateway.server";
import {
    openStudentAttemptSessionService,
    submitStudentAttemptSessionService,
} from "@/lib/studentAttemptSessionService.server";
import { serverGradedAttemptReceiptFromAttempt } from "@/lib/serverAttemptGrading";
import { stripExamForSolving } from "@/lib/examSolvePayload";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import {
    createStudentProblemPdfSignedUrlWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "@/lib/remoteAssetGateway.server";
import type {
    FocusLossEvent,
    QuestionTiming,
    RetakeMetadata,
    SubQuestionAnswers,
} from "@/types/omr";
import { hasPlanEntitlement } from "@/utils/plans";
import { readEffectiveWorkspacePlan } from "@/lib/effectiveWorkspacePlanGateway";

type DurableActionStatus = "unauthenticated" | "invalid" | "service_unavailable";
type AttemptSessionAdmin = StudentAttemptSessionRpcClient & SupabaseAdminReadClientLike;

interface AttemptSessionContext {
    identity: StudentServerIdentity;
    admin: AttemptSessionAdmin;
    secret: string;
}

async function parseStudentAttemptSessionContext(): Promise<AttemptSessionContext | null> {
    const config = getSupabaseServerConfigFromEnv();
    const secret = resolveStudentSessionSecret();
    if (!config || !secret) return null;
    const cookieStore = await cookies();
    const identity = parseSignedStudentSessionCookie(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
    );
    if (!identity?.organizationId) return null;
    return {
        identity,
        admin: createSupabaseAdminClient(config) as unknown as AttemptSessionAdmin,
        secret,
    };
}

async function sameOriginMutation(): Promise<boolean> {
    const headerStore = await headers();
    return !!headerStore.get("origin") && isSameOriginServerActionRequest(headerStore);
}

async function canonicalExam(context: AttemptSessionContext, examId: string) {
    const row = await fetchExamRowById(
        context.admin,
        context.identity.organizationId || "",
        examId.trim(),
    );
    if (!row) return null;
    try {
        return examFromSupabaseRow(row as Parameters<typeof examFromSupabaseRow>[0]);
    } catch {
        return null;
    }
}

async function ownStoredAttempt(context: AttemptSessionContext, attemptId: string) {
    const row = await fetchAttemptRowByOwnerAndId(context.admin, {
        organizationId: context.identity.organizationId,
        studentId: ownerStudentId(context.identity),
    }, attemptId);
    if (!row) return null;
    try {
        return attemptFromSupabaseRow(row as Parameters<typeof attemptFromSupabaseRow>[0]);
    } catch {
        return null;
    }
}

async function safeSolveSnapshot(context: AttemptSessionContext, snapshot: Parameters<typeof stripExamForSolving>[0]) {
    const organizationRead = await readEffectiveWorkspacePlan(
        context.admin,
        snapshot.organizationId || context.identity.organizationId || "",
    );
    const plan = organizationRead.authoritative ? organizationRead.plan : "free";
    const safe = stripExamForSolving(snapshot, {
        handwritingArchive: hasPlanEntitlement(plan, "handwritingArchive"),
    });
    const problemRef = safe.pdfDataRef;
    if (!isRemoteAssetStoredDataRef(problemRef)) return safe;
    if (problemRef.kind !== "problem_pdf" || problemRef.examId !== safe.id) return null;
    const signed = await createStudentProblemPdfSignedUrlWithGateway(
        context.admin as unknown as RemoteAssetSupabaseGatewayClient,
        { assetId: problemRef.key, organizationId: problemRef.organizationId, examId: safe.id },
    );
    if (signed.status !== "signed") return null;
    return { ...safe, pdfData: signed.signedUrl, pdfDataRef: undefined };
}

export interface OpenDurableStudentAttemptSessionInput {
    examId: string;
    attemptTicket: string;
    pin?: string;
    currentLeaseToken?: string;
    /** Confirmation only. The signed capability remains authoritative. */
    requestedAssignmentId?: string;
    /** Confirmation only. The signed capability remains authoritative. */
    requestedRetake?: Pick<RetakeMetadata, "sourceAttemptId" | "mode" | "questionIds">;
}

export async function openDurableStudentAttemptSession(
    input: OpenDurableStudentAttemptSessionInput,
) {
    if (!await sameOriginMutation()) return { status: "unauthenticated" as const };
    const context = await parseStudentAttemptSessionContext();
    if (!context) return { status: "service_unavailable" as const };
    const claims = parseStudentAttemptTicket(input.attemptTicket);
    if (!claims) return { status: "invalid" as const };
    const studentId = ownerStudentId(context.identity);
    const authorization = authorizeStudentAttemptSessionScope({
        claims,
        organizationId: context.identity.organizationId || "",
        examId: input.examId,
        ownerStudentId: studentId,
        identityType: context.identity.identityType,
        requestedAssignmentId: input.requestedAssignmentId,
        requestedRetake: input.requestedRetake,
    });
    if (authorization.status !== "authorized") return { status: "invalid" as const };
    const exam = await canonicalExam(context, claims.examId);
    if (!exam) return { status: "service_unavailable" as const };
    const leaseToken = randomUUID();
    const result = await openStudentAttemptSessionService({
        exam,
        identity: context.identity,
        input: {
            pin: input.pin,
            submissionId: claims.ticketId,
            leaseToken,
            currentLeaseToken: input.currentLeaseToken,
        },
        authorization,
        secret: context.secret,
        ids: {
            sessionId: `session_${randomUUID()}`,
            attemptId: `attempt_${claims.ticketId}`,
        },
        openGateway: gatewayInput => openStudentAttemptSessionWithGateway(context.admin, gatewayInput),
    });
    if ((result.status === "active" || result.status === "lease_conflict") && "gradingSnapshot" in result) {
        const exam = await safeSolveSnapshot(context, result.gradingSnapshot);
        if (!exam) return { status: "service_unavailable" as const };
        const { gradingSnapshot: _gradingSnapshot, ...clientResult } = result;
        void _gradingSnapshot;
        return { ...clientResult, exam };
    }
    return result;
}

export interface DurableStudentAttemptMutationInput {
    sessionId: string;
    expectedRevision: number;
    expectedLeaseEpoch: number;
    leaseToken: string;
}

export async function checkpointDurableStudentAttemptSession(
    input: DurableStudentAttemptMutationInput & {
        answers: Record<number, number>;
        subQuestionAnswers: SubQuestionAnswers;
        progressPayload?: Record<string, unknown>;
        finalCheckpoint?: boolean;
    },
) {
    if (!await sameOriginMutation()) return { status: "unauthenticated" as const };
    const context = await parseStudentAttemptSessionContext();
    if (!context) return { status: "service_unavailable" as const };
    return checkpointStudentAttemptSessionWithGateway(context.admin, {
        sessionId: input.sessionId,
        organizationId: context.identity.organizationId || "",
        ownerStudentId: ownerStudentId(context.identity),
        expectedRevision: input.expectedRevision,
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        leaseTokenHash: leaseTokenHash(input.leaseToken, context.secret),
        answers: input.answers,
        subQuestionAnswers: input.subQuestionAnswers,
        progressPayload: input.progressPayload || {},
        finalCheckpoint: input.finalCheckpoint,
    });
}

export async function heartbeatDurableStudentAttemptSession(
    input: Omit<DurableStudentAttemptMutationInput, "expectedRevision">,
) {
    if (!await sameOriginMutation()) return { status: "unauthenticated" as const };
    const context = await parseStudentAttemptSessionContext();
    if (!context) return { status: "service_unavailable" as const };
    return heartbeatStudentAttemptSessionWithGateway(context.admin, {
        sessionId: input.sessionId,
        organizationId: context.identity.organizationId || "",
        ownerStudentId: ownerStudentId(context.identity),
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        leaseTokenHash: leaseTokenHash(input.leaseToken, context.secret),
    });
}

export async function takeoverDurableStudentAttemptSession(
    input: Omit<DurableStudentAttemptMutationInput, "leaseToken">,
) {
    if (!await sameOriginMutation()) return { status: "unauthenticated" as const };
    const context = await parseStudentAttemptSessionContext();
    if (!context) return { status: "service_unavailable" as const };
    const leaseToken = randomUUID();
    const result = await takeoverStudentAttemptSessionWithGateway(context.admin, {
        sessionId: input.sessionId,
        organizationId: context.identity.organizationId || "",
        ownerStudentId: ownerStudentId(context.identity),
        expectedRevision: input.expectedRevision,
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        newLeaseTokenHash: leaseTokenHash(leaseToken, context.secret),
    });
    return result.status === "active" ? { ...result, leaseToken } : result;
}

export async function submitDurableStudentAttemptSession(
    input: DurableStudentAttemptMutationInput & {
        autoSubmitted?: boolean;
        questionTimings?: QuestionTiming[];
        focusLossEvents?: FocusLossEvent[];
        tabFociLostCount?: number;
        finishedAt?: string;
    },
) {
    if (!await sameOriginMutation()) return { status: "unauthenticated" as const };
    const context = await parseStudentAttemptSessionContext();
    if (!context) return { status: "service_unavailable" as const };
    const result = await submitStudentAttemptSessionService({
        identity: context.identity,
        sessionId: input.sessionId,
        expectedRevision: input.expectedRevision,
        expectedLeaseEpoch: input.expectedLeaseEpoch,
        leaseToken: input.leaseToken,
        secret: context.secret,
        autoSubmitted: input.autoSubmitted,
        questionTimings: input.questionTimings,
        focusLossEvents: input.focusLossEvents,
        tabFociLostCount: input.tabFociLostCount,
        finishedAt: input.finishedAt,
        prepareGateway: gatewayInput => prepareStudentAttemptSessionSubmitWithGateway(context.admin, gatewayInput),
        commitGateway: gatewayInput => commitStudentAttemptSessionSubmitWithGateway(context.admin, gatewayInput),
        loadSubmittedAttempt: attemptId => ownStoredAttempt(context, attemptId),
    });
    return result.status === "submitted"
        ? { status: "submitted" as const, receipt: serverGradedAttemptReceiptFromAttempt(result.attempt) }
        : result;
}

export type DurableStudentAttemptSessionFailure = { status: DurableActionStatus };
