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
import type { CanonicalCollectionMeta } from "@/lib/canonicalCollectionContract";
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
import { reportServerError } from "@/lib/reportServerError";
import {
    buildTeacherCanonicalAnalyticsSnapshotMap,
    buildTeacherUnavailableAnalyticsSnapshotMap,
    TEACHER_CANONICAL_ANALYTICS_RICH_RESULT_LIMIT,
} from "@/lib/teacherCanonicalAnalyticsSnapshot.server";
import {
    TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES,
    type TeacherCanonicalAnalyticsSnapshotMap,
} from "@/lib/teacherCanonicalAnalyticsSnapshotContract";
import { INITIAL_OPERATIONS_LIMITS } from "@/lib/initialOperationsPolicy";
import {
    listTeacherExamsWithGateway,
    type TeacherExamGatewayClient,
} from "@/lib/teacherExamGateway";

type TeacherAttemptActionContext = {
    client: TeacherAttemptGatewayClient & TeacherExamGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable" };

type AnalyticsSummaryPreflight = {
    attempts: TeacherAttemptSummary[];
    eligibleAttempts: TeacherAttemptSummary[];
    canonicalQuestionResultCount: number;
};

const TEACHER_CANONICAL_ANALYTICS_RICH_ATTEMPT_LIMIT = 100;

function preflightAnalyticsSummaries(value: unknown): AnalyticsSummaryPreflight | null {
    if (!Array.isArray(value) || value.length > INITIAL_OPERATIONS_LIMITS.teacherAttempts) return null;
    const attempts: TeacherAttemptSummary[] = [];
    const eligibleAttempts: TeacherAttemptSummary[] = [];
    const attemptIds = new Set<string>();
    let canonicalQuestionResultCount = 0;
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return null;
        const candidate = value[index];
        if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
        const prototype = Object.getPrototypeOf(candidate);
        if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(candidate).length > 0) return null;
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        if (Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable)) return null;
        const record = Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
        if (typeof record.id !== "string" || !record.id.trim()
            || typeof record.examId !== "string" || !record.examId.trim()
            || attemptIds.has(record.id)
            || (record.status !== "completed" && record.status !== "in_progress")) return null;
        attemptIds.add(record.id);
        if (record.status === "completed" && !record.retake) {
            const count = Number(record.questionResultsQuestionCount);
            if (!Number.isSafeInteger(count) || count <= 0 || count > 500) return null;
            canonicalQuestionResultCount += count;
            if (!Number.isSafeInteger(canonicalQuestionResultCount)
                || canonicalQuestionResultCount > INITIAL_OPERATIONS_LIMITS.teacherAttempts * 500) return null;
            eligibleAttempts.push(record as unknown as TeacherAttemptSummary);
        }
        attempts.push(record as unknown as TeacherAttemptSummary);
    }
    return { attempts, eligibleAttempts, canonicalQuestionResultCount };
}

async function mapWithConcurrency<T, R>(
    values: readonly T[],
    concurrency: number,
    load: (value: T) => Promise<R>,
): Promise<R[]> {
    const results = new Array<R>(values.length);
    let cursor = 0;
    async function worker() {
        while (cursor < values.length) {
            const index = cursor;
            cursor += 1;
            results[index] = await load(values[index]);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
    return results;
}

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
        client: createSupabaseAdminClient(config) as unknown as TeacherAttemptGatewayClient & TeacherExamGatewayClient,
        context,
    };
}

export async function listTeacherCanonicalAttempts(examId?: string): Promise<
    { status: "loaded"; attempts: Attempt[]; page: TeacherAttemptPage; meta: CanonicalCollectionMeta }
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        const result = await listTeacherAttemptsWithGateway(gateway.client, gateway.context, examId);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-attempt-read", {
                status: result.status,
                code: "service_unavailable",
                diagnostic: result.error,
            });
            return { status: result.status, error: "응시 목록을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-attempt-read", error);
        return { status: "service_unavailable", error: "응시 목록을 불러올 수 없습니다." };
    }
}

/**
 * Bounded analytics-only Flight boundary. It may verify rich rows on the server,
 * but no raw attempt/question-result collection is returned alongside the DTO.
 */
export async function loadTeacherCanonicalAnalyticsSnapshots(examId?: string): Promise<
    { status: "loaded"; analyticsSnapshots: TeacherCanonicalAnalyticsSnapshotMap; meta: CanonicalCollectionMeta }
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        const summaryResult = await listTeacherAttemptSummariesWithGateway(gateway.client, gateway.context, examId);
        if (summaryResult.status !== "loaded"
            || summaryResult.page.partial
            || summaryResult.page.hasMore
            || summaryResult.page.itemCount !== summaryResult.attempts.length
            || summaryResult.meta.organizationId !== gateway.context.organizationId) {
            return { status: "service_unavailable", error: "공식 분석 데이터 범위를 확인할 수 없습니다." };
        }
        const preflight = preflightAnalyticsSummaries(summaryResult.attempts);
        if (!preflight) {
            return { status: "service_unavailable", error: "공식 분석 데이터 범위를 확인할 수 없습니다." };
        }
        if (preflight.eligibleAttempts.length > TEACHER_CANONICAL_ANALYTICS_RICH_ATTEMPT_LIMIT
            || preflight.canonicalQuestionResultCount > TEACHER_CANONICAL_ANALYTICS_RICH_RESULT_LIMIT) {
            const analyticsSnapshots = buildTeacherUnavailableAnalyticsSnapshotMap(preflight.attempts);
            const serialized = JSON.stringify(analyticsSnapshots);
            if (new TextEncoder().encode(serialized).byteLength > TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES) {
                return { status: "service_unavailable", error: "공식 분석 데이터가 전송 한도를 초과했습니다." };
            }
            return {
                status: "loaded",
                analyticsSnapshots: JSON.parse(serialized) as TeacherCanonicalAnalyticsSnapshotMap,
                meta: summaryResult.meta,
            };
        }
        if (preflight.eligibleAttempts.length === 0) {
            return { status: "loaded", analyticsSnapshots: {}, meta: summaryResult.meta };
        }
        const [detailResults, examResult] = await Promise.all([
            mapWithConcurrency(preflight.eligibleAttempts, 6, summary => (
                loadTeacherAttemptWithGateway(gateway.client, summary.id, gateway.context)
            )),
            listTeacherExamsWithGateway(gateway.client, gateway.context),
        ]);
        if (examResult.status !== "loaded"
            || examResult.meta.organizationId !== gateway.context.organizationId
            || examResult.meta.rawCount !== examResult.meta.parsedCount
            || examResult.meta.parsedCount !== examResult.exams.length
            || examResult.exams.some(exam => exam.organizationId !== gateway.context.organizationId)) {
            return { status: "service_unavailable", error: "공식 시험 정의를 불러올 수 없습니다." };
        }
        const richAttempts: Attempt[] = [];
        for (let index = 0; index < detailResults.length; index += 1) {
            const detail = detailResults[index];
            const summary = preflight.eligibleAttempts[index];
            if (detail.status !== "loaded"
                || detail.attempt.id !== summary.id
                || detail.attempt.examId !== summary.examId
                || detail.attempt.organizationId !== gateway.context.organizationId
                || detail.attempt.status !== "completed"
                || !!detail.attempt.retake
                || !Array.isArray(detail.attempt.questionResults)
                || detail.attempt.questionResults.length !== summary.questionResultsQuestionCount) {
                return { status: "service_unavailable", error: "공식 분석 데이터가 요약 범위와 일치하지 않습니다." };
            }
            richAttempts.push(detail.attempt);
        }
        if (richAttempts.length !== preflight.eligibleAttempts.length) {
            return { status: "service_unavailable", error: "공식 분석 데이터가 요약 범위와 일치하지 않습니다." };
        }
        const requiredExamIds = new Set(preflight.eligibleAttempts.map(attempt => attempt.examId));
        const availableExamIds = new Set(examResult.exams.map(exam => exam.id));
        if ([...requiredExamIds].some(requiredExamId => !availableExamIds.has(requiredExamId))) {
            return { status: "service_unavailable", error: "공식 시험 정의가 분석 범위와 일치하지 않습니다." };
        }
        const analyticsSnapshots = buildTeacherCanonicalAnalyticsSnapshotMap(examResult.exams, richAttempts);
        const serialized = JSON.stringify(analyticsSnapshots);
        if (new TextEncoder().encode(serialized).byteLength > TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES) {
            return { status: "service_unavailable", error: "공식 분석 데이터가 전송 한도를 초과했습니다." };
        }
        return {
            status: "loaded",
            analyticsSnapshots: JSON.parse(serialized) as TeacherCanonicalAnalyticsSnapshotMap,
            meta: summaryResult.meta,
        };
    } catch (error) {
        await reportServerError("teacher-canonical-analytics-read", error);
        return { status: "service_unavailable", error: "공식 분석 데이터를 불러올 수 없습니다." };
    }
}

export async function listTeacherCanonicalAttemptSummaries(examId?: string): Promise<
    { status: "loaded"; attempts: TeacherAttemptSummary[]; page: TeacherAttemptPage; meta: CanonicalCollectionMeta }
    | { status: "forbidden" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        const result = await listTeacherAttemptSummariesWithGateway(gateway.client, gateway.context, examId);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-attempt-read", {
                status: result.status,
                code: "service_unavailable",
                diagnostic: result.error,
            });
            return { status: result.status, error: "응시 목록을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-attempt-read", error);
        return { status: "service_unavailable", error: "응시 목록을 불러올 수 없습니다." };
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
        const result = await loadTeacherAttemptWithGateway(gateway.client, attemptId, gateway.context);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-attempt-read", {
                status: result.status,
                code: "service_unavailable",
                diagnostic: result.error,
            });
            return { status: result.status, error: "응시 결과를 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-attempt-read", error);
        return { status: "service_unavailable", error: "응시 결과를 불러올 수 없습니다." };
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
