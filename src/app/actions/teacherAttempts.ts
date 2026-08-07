"use server";

import { cookies, headers } from "next/headers";
import { canTeacherRoleWrite } from "@/lib/teacherSession";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    answerTeacherAttemptQuestionWithGateway,
    forceFinishTeacherAttemptSessionsWithGateway,
    forceFinishTeacherAttemptsWithGateway,
    listTeacherActiveAttemptSessionsWithGateway,
    listTeacherAttemptSummariesWithGateway,
    listTeacherAttemptsWithGateway,
    loadTeacherAttemptWithGateway,
    setTeacherAttemptSubquestionReviewWithGateway,
    type TeacherAttemptGatewayClient,
    type TeacherAttemptBatchMutationResult,
    type TeacherActiveAttemptSession,
    type TeacherAttemptMutationResult,
    type TeacherAttemptPage,
} from "@/lib/teacherAttemptGateway";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import type { Attempt } from "@/types/omr";
import type { TeacherAttemptSummary } from "@/lib/teacherAttemptSummary";
import {
    aggregateTeacherAttemptsWithGateway,
    exportTeacherAttemptDatasetWithGateway,
    exportTeacherAttemptPageWithGateway,
    type TeacherAttemptAggregateInput,
    type TeacherAttemptAggregateResult,
    type TeacherAttemptExportPageInput,
    type TeacherAttemptExportPageResult,
    type TeacherAttemptReportingClient,
} from "@/lib/teacherAttemptReportingGateway";

type TeacherAttemptActionContext = {
    client: TeacherAttemptGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable" };

async function actionContext(requireWrite = false): Promise<TeacherAttemptActionContext> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = await resolveAuthorizedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    if (requireWrite && !canTeacherRoleWrite(session.memberRole)) return { status: "forbidden" };
    const context = workspaceContextFromTeacherSession(session);
    if (
        requireWrite
        && (
            !context.actorUserId?.trim()
            || !context.actorLabel?.trim()
            || !context.memberRole
        )
    ) {
        return { status: "forbidden" };
    }
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    return {
        client: createSupabaseAdminClient(config) as unknown as TeacherAttemptGatewayClient,
        context,
    };
}

export async function listTeacherCanonicalAttempts(examId?: string): Promise<
    { status: "loaded"; attempts: Attempt[]; page: TeacherAttemptPage }
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return listTeacherAttemptsWithGateway(gateway.client, gateway.context, examId);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt list failed" };
    }
}

export async function listTeacherCanonicalAttemptSummaries(examId?: string): Promise<
    { status: "loaded"; attempts: TeacherAttemptSummary[]; page: TeacherAttemptPage }
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return listTeacherAttemptSummariesWithGateway(gateway.client, gateway.context, examId);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt summary list failed" };
    }
}

type TeacherAttemptReportingActionResult<T> = T
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string };

export async function getTeacherCanonicalAttemptAggregate(
    input: TeacherAttemptAggregateInput = {},
): Promise<TeacherAttemptReportingActionResult<TeacherAttemptAggregateResult>> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return aggregateTeacherAttemptsWithGateway(
            gateway.client as unknown as TeacherAttemptReportingClient,
            gateway.context,
            input,
        );
    } catch {
        return { status: "service_unavailable", error: "Canonical attempt reporting unavailable" };
    }
}

export async function getTeacherCanonicalAttemptExportPage(
    input: TeacherAttemptExportPageInput,
): Promise<TeacherAttemptReportingActionResult<TeacherAttemptExportPageResult>> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return exportTeacherAttemptPageWithGateway(
            gateway.client as unknown as TeacherAttemptReportingClient,
            gateway.context,
            input,
        );
    } catch {
        return { status: "service_unavailable", error: "Canonical attempt reporting unavailable" };
    }
}

export async function getTeacherCanonicalAttemptExportDataset(
    input: { examId?: string; limit: number },
): Promise<TeacherAttemptReportingActionResult<ReturnType<typeof exportTeacherAttemptDatasetWithGateway> extends Promise<infer R> ? R : never>> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return exportTeacherAttemptDatasetWithGateway(
            gateway.client as unknown as TeacherAttemptReportingClient,
            gateway.context,
            input,
        );
    } catch {
        return { status: "service_unavailable", error: "Canonical attempt export unavailable" };
    }
}

export async function listTeacherCanonicalActiveAttemptSessions(examId: string): Promise<
    { status: "loaded"; sessions: TeacherActiveAttemptSession[] }
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return listTeacherActiveAttemptSessionsWithGateway(gateway.client, gateway.context, examId);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Active attempt session list failed" };
    }
}

export async function loadTeacherCanonicalAttempt(attemptId: string): Promise<
    { status: "loaded"; attempt: Attempt }
    | { status: "forbidden" | "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return loadTeacherAttemptWithGateway(gateway.client, attemptId, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt load failed" };
    }
}

type TeacherMutationActionResult =
    | TeacherAttemptMutationResult
    | { status: "local_only" | "unauthorized"; error?: string };

type TeacherBatchMutationActionResult =
    | TeacherAttemptBatchMutationResult
    | { status: "local_only" | "unauthorized"; error?: string };

export async function answerTeacherCanonicalAttemptQuestion(
    attemptId: string,
    questionId: string | number,
    answer: string,
): Promise<TeacherMutationActionResult> {
    try {
        const gateway = await actionContext(true);
        if ("status" in gateway) return gateway;
        return answerTeacherAttemptQuestionWithGateway(gateway.client, {
            attemptId,
            questionId,
            answer,
        }, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt answer failed" };
    }
}

export async function setTeacherCanonicalSubquestionReview(
    attemptId: string,
    questionId: string | number,
    subquestionId: string,
    status: "needs_review" | "reviewed",
): Promise<TeacherMutationActionResult> {
    try {
        const gateway = await actionContext(true);
        if ("status" in gateway) return gateway;
        return setTeacherAttemptSubquestionReviewWithGateway(gateway.client, {
            attemptId,
            questionId,
            subquestionId,
            status,
        }, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Subquestion review failed" };
    }
}

export async function forceFinishTeacherCanonicalAttempts(
    attemptIds: string[],
    finishedAt: string,
): Promise<TeacherBatchMutationActionResult> {
    try {
        const gateway = await actionContext(true);
        if ("status" in gateway) return gateway;
        return forceFinishTeacherAttemptsWithGateway(gateway.client, {
            attemptIds,
            finishedAt,
        }, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Force finish failed" };
    }
}

export async function forceFinishTeacherCanonicalAttemptSessions(
    sessionIds: string[],
    finishedAt: string,
): Promise<TeacherBatchMutationActionResult> {
    try {
        const gateway = await actionContext(true);
        if ("status" in gateway) return gateway;
        return forceFinishTeacherAttemptSessionsWithGateway(gateway.client, {
            sessionIds,
            finishedAt,
        }, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Attempt session force finish failed" };
    }
}
