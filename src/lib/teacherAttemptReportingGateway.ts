import type { WorkspaceContext } from "@/lib/workspaceContext";

export const TEACHER_ATTEMPT_EXPORT_DEFAULT_PAGE_SIZE = 499;
// The SQL RPC accepts at most 500 rows. Reserve one row for hasMore lookahead,
// so every page published to the browser remains at most 499 rows.
export const TEACHER_ATTEMPT_EXPORT_MAX_PAGE_SIZE = 499;

export interface TeacherAttemptReportingClient {
    rpc(name: string, args: Record<string, unknown>): Promise<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export interface TeacherAttemptAggregate {
    totalAttemptCount: number;
    completedAttemptCount: number;
    inProgressAttemptCount: number;
    baseAttemptCount: number;
    completedBaseAttemptCount: number;
    distinctStudentCount: number;
    completedBaseScorePercentSum: number;
    averageScorePercent: number;
    periodAttemptCount: number;
    periodHandwritingArchiveCount: number;
    periodHandwritingQuestionCount: number;
    periodHandwritingStrokeCount: number;
    snapshotAt: string;
}

export interface TeacherAttemptAggregateInput {
    examId?: string;
    periodStart?: string;
    periodEnd?: string;
}

export type TeacherAttemptAggregateResult =
    | { status: "loaded"; aggregate: TeacherAttemptAggregate }
    | { status: "invalid_request" | "service_unavailable"; error?: string };

export interface TeacherAttemptExportRow {
    attemptId: string;
    examId: string;
    /** Stable, organization-salted pseudonym; never a raw profile/login/name. */
    studentScopeHash: string;
    status: "completed";
    scorePercent: number;
    isRetake: boolean;
    handwritingArchived: boolean;
    handwritingQuestionCount: number;
    handwritingStrokeCount: number;
    startedAt: string;
    finishedAt: string;
}

export interface TeacherAttemptExportCursor {
    finishedAt: string;
    id: string;
}

export interface TeacherAttemptExportPage {
    rows: TeacherAttemptExportRow[];
    hasMore: boolean;
    nextCursor?: TeacherAttemptExportCursor;
}

export interface TeacherAttemptExportPageInput {
    examId?: string;
    snapshotAt: string;
    cursor?: TeacherAttemptExportCursor;
    pageSize?: number;
}

export type TeacherAttemptExportPageResult =
    | { status: "loaded"; page: TeacherAttemptExportPage }
    | { status: "invalid_request" | "service_unavailable"; error?: string };

export type TeacherAttemptExportDatasetGatewayResult =
    | { status: "loaded"; aggregate: TeacherAttemptAggregate; rows: TeacherAttemptExportRow[] }
    | { status: "capacity_exceeded" | "invalid_request" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function safeIso(value: unknown): string {
    const normalized = clean(value);
    if (!normalized || !Number.isFinite(Date.parse(normalized))) return "";
    return normalized;
}

function safeCount(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeNonNegativeNumber(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function optionalScope(value: unknown, maxBytes: number): string | null | undefined {
    if (value === undefined || value === null) return null;
    const normalized = clean(value);
    if (!normalized || new TextEncoder().encode(normalized).byteLength > maxBytes) return undefined;
    return normalized;
}

function aggregateFromProjection(value: unknown): TeacherAttemptAggregate | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const totalAttemptCount = safeCount(row.total_attempt_count);
    const completedAttemptCount = safeCount(row.completed_attempt_count);
    const inProgressAttemptCount = safeCount(row.in_progress_attempt_count);
    const baseAttemptCount = safeCount(row.base_attempt_count);
    const completedBaseAttemptCount = safeCount(row.completed_base_attempt_count);
    const distinctStudentCount = safeCount(row.distinct_student_count);
    const completedBaseScorePercentSum = safeNonNegativeNumber(row.completed_base_score_percent_sum);
    const averageScorePercent = safeNonNegativeNumber(row.completed_base_average_score_percent);
    const periodAttemptCount = safeCount(row.period_attempt_count);
    const periodHandwritingArchiveCount = safeCount(row.period_handwriting_archive_count);
    const periodHandwritingQuestionCount = safeCount(row.period_handwriting_question_count);
    const periodHandwritingStrokeCount = safeCount(row.period_handwriting_stroke_count);
    const snapshotAt = safeIso(row.snapshot_at);
    if (
        totalAttemptCount === null || completedAttemptCount === null || inProgressAttemptCount === null
        || baseAttemptCount === null || completedBaseAttemptCount === null || distinctStudentCount === null
        || completedBaseScorePercentSum === null || averageScorePercent === null
        || periodAttemptCount === null || periodHandwritingArchiveCount === null
        || periodHandwritingQuestionCount === null || periodHandwritingStrokeCount === null || !snapshotAt
        || completedAttemptCount + inProgressAttemptCount !== totalAttemptCount
        || baseAttemptCount > totalAttemptCount
        || completedBaseAttemptCount > completedAttemptCount
        || completedBaseAttemptCount > baseAttemptCount
        || distinctStudentCount > totalAttemptCount
        || periodAttemptCount > totalAttemptCount
        || periodHandwritingArchiveCount > periodAttemptCount
        || (completedBaseAttemptCount === 0 && (completedBaseScorePercentSum !== 0 || averageScorePercent !== 0))
    ) return null;
    return {
        totalAttemptCount,
        completedAttemptCount,
        inProgressAttemptCount,
        baseAttemptCount,
        completedBaseAttemptCount,
        distinctStudentCount,
        completedBaseScorePercentSum,
        averageScorePercent,
        periodAttemptCount,
        periodHandwritingArchiveCount,
        periodHandwritingQuestionCount,
        periodHandwritingStrokeCount,
        snapshotAt,
    };
}

function validPeriod(start: unknown, end: unknown): { start: string | null; end: string | null } | null {
    if (start === undefined && end === undefined) return { start: null, end: null };
    const normalizedStart = safeIso(start);
    const normalizedEnd = safeIso(end);
    if (!normalizedStart || !normalizedEnd) return null;
    const duration = Date.parse(normalizedEnd) - Date.parse(normalizedStart);
    if (duration <= 0 || duration > 366 * 24 * 60 * 60 * 1_000) return null;
    return { start: normalizedStart, end: normalizedEnd };
}

export async function aggregateTeacherAttemptsWithGateway(
    client: TeacherAttemptReportingClient,
    context: WorkspaceContext,
    input: TeacherAttemptAggregateInput = {},
): Promise<TeacherAttemptAggregateResult> {
    const organizationId = optionalScope(context.organizationId, 128);
    const examId = optionalScope(input.examId, 256);
    const period = validPeriod(input.periodStart, input.periodEnd);
    if (!organizationId || examId === undefined || !period) return { status: "invalid_request" };
    const result = await client.rpc("omr_teacher_attempt_aggregate_v1", {
        p_organization_id: organizationId,
        p_exam_id: examId,
        p_period_start: period.start,
        p_period_end: period.end,
    });
    if (result.error) return {
        status: "service_unavailable",
        error: "Canonical attempt reporting unavailable",
    };
    const rows = Array.isArray(result.data) ? result.data : [];
    const aggregate = rows.length === 1 ? aggregateFromProjection(rows[0]) : null;
    return aggregate
        ? { status: "loaded", aggregate }
        : { status: "service_unavailable", error: "Invalid canonical attempt aggregate" };
}

function exportRowFromProjection(value: unknown): TeacherAttemptExportRow | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const attemptId = clean(row.attempt_id);
    const examId = clean(row.exam_id);
    const studentScopeHash = clean(row.student_scope_hash);
    const scorePercent = safeNonNegativeNumber(row.score_percent);
    const handwritingQuestionCount = safeCount(row.handwriting_question_count);
    const handwritingStrokeCount = safeCount(row.handwriting_stroke_count);
    const startedAt = safeIso(row.started_at);
    const finishedAt = safeIso(row.finished_at);
    if (
        !attemptId || !examId || !/^[a-f0-9]{32}$/.test(studentScopeHash) || scorePercent === null
        || row.status !== "completed"
        || typeof row.is_retake !== "boolean" || typeof row.handwriting_archived !== "boolean"
        || handwritingQuestionCount === null || handwritingStrokeCount === null
        || !startedAt || !finishedAt || Date.parse(finishedAt) < Date.parse(startedAt)
    ) return null;
    return {
        attemptId,
        examId,
        studentScopeHash,
        status: row.status,
        scorePercent,
        isRetake: row.is_retake,
        handwritingArchived: row.handwriting_archived,
        handwritingQuestionCount,
        handwritingStrokeCount,
        startedAt,
        finishedAt,
    };
}

function followsDescendingCursor(previous: TeacherAttemptExportCursor, current: TeacherAttemptExportCursor): boolean {
    const previousTime = Date.parse(previous.finishedAt);
    const currentTime = Date.parse(current.finishedAt);
    return currentTime < previousTime || (currentTime === previousTime && current.id < previous.id);
}

export async function exportTeacherAttemptPageWithGateway(
    client: TeacherAttemptReportingClient,
    context: WorkspaceContext,
    input: TeacherAttemptExportPageInput,
): Promise<TeacherAttemptExportPageResult> {
    const organizationId = optionalScope(context.organizationId, 128);
    const examId = optionalScope(input.examId, 256);
    const snapshotAt = safeIso(input.snapshotAt);
    const pageSize = input.pageSize ?? TEACHER_ATTEMPT_EXPORT_DEFAULT_PAGE_SIZE;
    const cursorId = input.cursor ? optionalScope(input.cursor.id, 256) : null;
    const cursorFinishedAt = input.cursor ? safeIso(input.cursor.finishedAt) : null;
    if (
        !organizationId || examId === undefined || !snapshotAt
        || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TEACHER_ATTEMPT_EXPORT_MAX_PAGE_SIZE
        || cursorId === undefined || (input.cursor && (!cursorId || !cursorFinishedAt))
    ) return { status: "invalid_request" };

    const result = await client.rpc("omr_teacher_attempt_export_page_v1", {
        p_organization_id: organizationId,
        p_exam_id: examId,
        p_snapshot_at: snapshotAt,
        p_after_finished_at: cursorFinishedAt,
        p_after_id: cursorId,
        p_limit: pageSize + 1,
    });
    if (result.error) return {
        status: "service_unavailable",
        error: "Canonical attempt reporting unavailable",
    };
    const projections = Array.isArray(result.data) ? result.data : [];
    if (projections.length > pageSize + 1) {
        return { status: "service_unavailable", error: "Invalid canonical attempt export page" };
    }
    const parsed = projections.map(exportRowFromProjection);
    if (parsed.some(row => !row)) {
        return { status: "service_unavailable", error: "Invalid canonical attempt export page" };
    }
    const allRows = parsed as TeacherAttemptExportRow[];
    let previous = input.cursor;
    for (const row of allRows) {
        const current = { finishedAt: row.finishedAt, id: row.attemptId };
        if (
            row.finishedAt > snapshotAt
            || (examId && row.examId !== examId)
            || (previous && !followsDescendingCursor(previous, current))
        ) {
            return { status: "service_unavailable", error: "Invalid canonical attempt export page" };
        }
        previous = current;
    }
    const hasMore = allRows.length > pageSize;
    const rows = allRows.slice(0, pageSize);
    const last = rows.at(-1);
    return {
        status: "loaded",
        page: {
            rows,
            hasMore,
            ...(last ? { nextCursor: { finishedAt: last.finishedAt, id: last.attemptId } } : {}),
        },
    };
}

export async function exportTeacherAttemptDatasetWithGateway(
    client: TeacherAttemptReportingClient,
    context: WorkspaceContext,
    input: { examId?: string; limit: number },
): Promise<TeacherAttemptExportDatasetGatewayResult> {
    const organizationId = optionalScope(context.organizationId, 128);
    const examId = optionalScope(input.examId, 256);
    if (
        !organizationId || examId === undefined
        || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 5_000
    ) return { status: "invalid_request" };
    const result = await client.rpc("omr_teacher_attempt_export_v1", {
        p_organization_id: organizationId,
        p_exam_id: examId,
        p_limit: input.limit,
    });
    if (result.error) return {
        status: "service_unavailable",
        error: "Canonical attempt export unavailable",
    };
    const payload = result.data && typeof result.data === "object" && !Array.isArray(result.data)
        ? result.data as Record<string, unknown>
        : null;
    if (!payload) return { status: "service_unavailable", error: "Invalid canonical attempt export" };
    if (payload.status === "capacity_exceeded") return { status: "capacity_exceeded" };
    if (payload.status !== "loaded" || !Array.isArray(payload.rows)) {
        return { status: "service_unavailable", error: "Invalid canonical attempt export" };
    }
    const aggregate = aggregateFromProjection(payload.aggregate);
    const parsed = payload.rows.map(exportRowFromProjection);
    const rowCount = safeCount(payload.rowCount);
    if (
        !aggregate || rowCount === null || rowCount !== aggregate.completedAttemptCount
        || rowCount !== parsed.length || parsed.some(row => !row)
    ) return { status: "service_unavailable", error: "Invalid canonical attempt export" };
    const rows = parsed as TeacherAttemptExportRow[];
    let previous: TeacherAttemptExportCursor | undefined;
    for (const row of rows) {
        const current = { finishedAt: row.finishedAt, id: row.attemptId };
        if (
            row.finishedAt > aggregate.snapshotAt
            || (examId && row.examId !== examId)
            || (previous && !followsDescendingCursor(previous, current))
        ) return { status: "service_unavailable", error: "Invalid canonical attempt export" };
        previous = current;
    }
    return { status: "loaded", aggregate, rows };
}
