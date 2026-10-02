import {
    attemptFromSupabaseRow,
    examFromSupabaseRow,
    questionResultRowsForAttempt,
    type SupabaseAttemptRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import {
    SUPABASE_ATTEMPT_LIST_READ_COLUMNS,
    SUPABASE_ATTEMPT_READ_COLUMNS,
    SUPABASE_EXAM_READ_COLUMNS,
    SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS,
} from "@/lib/supabaseReadColumns";
import {
    attemptFromSupabaseListRow,
    teacherAttemptSummaryFromSupabaseListRow,
} from "@/lib/supabaseListProjection";
import { gradeTeacherForcedAttemptOnServer } from "@/lib/serverAttemptGrading";
import { STUDENT_QUESTION_MAX_LENGTH } from "@/lib/studentQuestions";
import { canTeacherRoleWrite } from "@/lib/teacherSession";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
import type { WorkspaceContext } from "@/lib/workspaceContext";
import type { Attempt, SubQuestionReviewStatus } from "@/types/omr";
import type { TeacherAttemptSummary } from "@/lib/teacherAttemptSummary";
import { attestCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import {
    canonicalUtcTimestampMicrosecondKey,
    normalizeCanonicalUtcTimestamp,
    type CanonicalCollectionMeta,
} from "@/lib/canonicalCollectionContract";

interface AttemptQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface AttemptSelectQuery extends PromiseLike<AttemptQueryResult<unknown[]>> {
    eq(column: string, value: string): AttemptSelectQuery;
    gt(column: string, value: string): AttemptSelectQuery;
    in(column: string, values: string[]): AttemptSelectQuery;
    order(column: string, options: { ascending: boolean }): AttemptSelectQuery;
    or(filters: string): AttemptSelectQuery;
    limit(value: number): PromiseLike<AttemptQueryResult<unknown[]>>;
    maybeSingle(): Promise<AttemptQueryResult<unknown>>;
}

export interface TeacherAttemptGatewayClient {
    from(table: "omr_attempts" | "omr_exams"): {
        select(columns: string): AttemptSelectQuery;
    };
    rpc(
        name:
            | "omr_answer_attempt_question_v1"
            | "omr_set_subquestion_review_v1"
            | "omr_force_finish_attempts_v1",
        args: Record<string, unknown>,
    ): Promise<AttemptQueryResult<Array<{ payload: Attempt }> | { payload: Attempt }>>;
    rpc(
        name:
            | "omr_list_active_attempt_sessions_v2"
            | "omr_prepare_teacher_force_finish_sessions_v1"
            | "omr_prepare_teacher_force_finish_sessions_compact_v2"
            | "omr_force_finish_attempt_sessions_v1"
            | "omr_force_finish_attempt_sessions_compact_v2",
        args: Record<string, unknown>,
    ): Promise<AttemptQueryResult<unknown>>;
}

export interface TeacherActiveAttemptSession {
    sessionId: string;
    attemptId: string;
    examId: string;
    classId?: string;
    assignmentId?: string;
    assignmentRevision?: number;
    ownerStudentId: string;
    studentProfileId?: string;
    studentName: string;
    identityType: "guest" | "temporary" | "registered";
    startedAt: string;
    deadlineAt: string;
    lastHeartbeatAt: string;
    revision: number;
    answeredCount: number;
    totalQuestionCount: number;
    currentQuestionId?: number;
}

export type TeacherActiveAttemptSessionListResult =
    | { status: "loaded"; sessions: TeacherActiveAttemptSession[] }
    | { status: "forbidden" | "service_unavailable"; error?: string };

export type TeacherAttemptListResult =
    | { status: "loaded"; attempts: Attempt[]; page: TeacherAttemptPage; meta: CanonicalCollectionMeta }
    | { status: "service_unavailable"; error?: string };

export type TeacherAttemptSummaryListResult =
    | { status: "loaded"; attempts: TeacherAttemptSummary[]; page: TeacherAttemptPage; meta: CanonicalCollectionMeta }
    | { status: "service_unavailable"; error?: string };

export interface TeacherAttemptPage {
    partial: boolean;
    hasMore: boolean;
    itemCount: number;
    nextCursor?: {
        finishedAt: string;
        id: string;
    };
}

export type TeacherAttemptLoadResult =
    | { status: "loaded"; attempt: Attempt }
    | { status: "not_found" | "service_unavailable"; error?: string };

export type TeacherAttemptMutationResult =
    | { status: "saved"; attempt: Attempt }
    | { status: "invalid_request" | "forbidden" | "not_found"; error?: string }
    | { status: "service_unavailable"; error?: string };

export type TeacherAttemptBatchMutationResult =
    | { status: "saved"; attempts: Attempt[] }
    | { status: "invalid_request" | "forbidden" | "not_found"; error?: string }
    | { status: "service_unavailable"; error?: string };

export interface AnswerTeacherAttemptQuestionInput {
    attemptId: string;
    questionId: string | number;
    answer: string;
}

export interface SetTeacherAttemptSubquestionReviewInput {
    attemptId: string;
    questionId: string | number;
    subquestionId: string;
    status: SubQuestionReviewStatus;
}

export interface ForceFinishTeacherAttemptsInput {
    attemptIds: string[];
    finishedAt: string;
}

export interface ForceFinishTeacherAttemptSessionsInput {
    sessionIds: string[];
    finishedAt: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function mutationContextIsAuthorized(context: WorkspaceContext): boolean {
    return !!clean(context.organizationId)
        && !!clean(context.actorUserId)
        && !!clean(context.actorLabel)
        && canTeacherRoleWrite(context.memberRole);
}

function actorRpcArgs(context: WorkspaceContext) {
    return {
        p_actor_user_id: clean(context.actorUserId),
        p_member_role: context.memberRole,
        p_actor_label: clean(context.actorLabel),
    };
}

function safePositiveInteger(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeNonNegativeInteger(value: unknown): number | null {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function safeIso(value: unknown): string {
    return normalizeCanonicalUtcTimestamp(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

type ProjectionValidator = (value: unknown) => boolean;

function isBoundedString(value: unknown, maxLength = 10_000): value is string {
    return typeof value === "string" && value.length <= maxLength;
}

function isExactProjectionText(value: unknown): value is string {
    return isBoundedString(value, 1_000) && !!value && value.trim() === value;
}

function isFiniteNonNegative(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalProjectionField(
    record: Record<string, unknown>,
    key: string,
    validator: ProjectionValidator,
): boolean {
    return record[key] === undefined || record[key] === null || validator(record[key]);
}

function hasOnlyProjectionKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
    const allowedKeys = new Set(allowed);
    return Object.keys(record).every(key => allowedKeys.has(key));
}

function isStringArray(value: unknown): boolean {
    return Array.isArray(value) && value.every(item => isBoundedString(item, 1_000));
}

function isPositiveIntegerArray(value: unknown): boolean {
    return Array.isArray(value) && value.every(isPositiveSafeInteger);
}

function isStoredDataRefProjection(value: unknown): boolean {
    if (!isPlainRecord(value)) return false;
    if (!hasOnlyProjectionKeys(value, [
        "store", "key", "organizationId", "kind", "examId", "attemptId", "name", "mimeType", "size", "updatedAt",
    ])) return false;
    if ((value.store !== "indexeddb" && value.store !== "remote") || !isExactProjectionText(value.key)) return false;
    const textFields = ["organizationId", "examId", "attemptId", "name", "mimeType"];
    if (!textFields.every(key => optionalProjectionField(value, key, isBoundedString))) return false;
    if (!optionalProjectionField(value, "kind", item => (
        item === "problem_pdf" || item === "answer_key_pdf" || item === "attempt_handwriting"
    ))) return false;
    return optionalProjectionField(value, "size", isFiniteNonNegative)
        && optionalProjectionField(value, "updatedAt", item => !!safeIso(item));
}

function isPdfLocationProjection(value: unknown, region: boolean): boolean {
    if (!isPlainRecord(value)
        || !hasOnlyProjectionKeys(value, region ? ["page", "x", "y", "width", "height"] : ["page", "x", "y"])
        || !isPositiveSafeInteger(value.page)
        || !isFiniteNonNegative(value.x)
        || !isFiniteNonNegative(value.y)) return false;
    return !region || (isFiniteNonNegative(value.width) && isFiniteNonNegative(value.height));
}

function isQuestionDrawingSummaryProjection(value: unknown): boolean {
    return isPlainRecord(value)
        && hasOnlyProjectionKeys(value, ["questionId", "questionNumber", "page", "strokeCount"])
        && isPositiveSafeInteger(value.questionId)
        && isPositiveSafeInteger(value.questionNumber)
        && isPositiveSafeInteger(value.page)
        && isNonNegativeSafeInteger(value.strokeCount);
}

function isQuestionResultProjection(value: unknown): boolean {
    if (!isPlainRecord(value)
        || !hasOnlyProjectionKeys(value, [
            "schemaVersion", "attemptId", "examId", "examTitle", "organizationId", "classId", "assignmentId", "assignmentRevision",
            "studentProfileId", "studentName", "studentId", "groupId", "groupName", "regionId", "regionName",
            "identityType", "questionId", "questionNumber", "canonicalQuestionId", "label", "score", "earnedScore",
            "selectedAnswer", "correctAnswer", "status", "isCorrect", "isWrong", "isUnanswered", "subject", "unit",
            "concept", "skill", "source", "difficulty", "cognitiveLevel", "mistakeTypes", "prerequisites",
            "expectedTimeSec", "pdfPage", "pdfLocation", "pdfRegion", "passagePdfRegions", "timeSec", "visitCount",
            "revisitCount", "answerChangeCount", "handwritingStrokeCount", "handwritingPage", "retakeSourceAttemptId",
            "retakeMode", "answeredAt", "finishedAt",
        ])
        || value.schemaVersion !== 1
        || !["attemptId", "examId", "examTitle", "studentName"].every(key => isExactProjectionText(value[key]))
        || !isPositiveSafeInteger(value.questionId)
        || !isPositiveSafeInteger(value.questionNumber)
        || !isFiniteNonNegative(value.score)
        || !isFiniteNonNegative(value.earnedScore)
        || !["correct", "wrong", "unanswered", "ungraded"].includes(String(value.status))
        || typeof value.isCorrect !== "boolean"
        || typeof value.isWrong !== "boolean"
        || typeof value.isUnanswered !== "boolean"
        || !safeIso(value.finishedAt)) return false;
    const optionalTexts = [
        "organizationId", "classId", "assignmentId", "studentProfileId", "studentId", "groupId",
        "groupName", "regionId", "regionName", "canonicalQuestionId", "label", "subject", "unit",
        "concept", "skill", "source", "retakeSourceAttemptId",
    ];
    if (!optionalTexts.every(key => optionalProjectionField(value, key, isBoundedString))) return false;
    if (!optionalProjectionField(value, "assignmentRevision", isPositiveSafeInteger)
        || Boolean(value.assignmentId) !== Boolean(value.assignmentRevision)) return false;
    if (!optionalProjectionField(value, "identityType", item => (
        item === "guest" || item === "temporary" || item === "registered"
    ))) return false;
    if (!optionalProjectionField(value, "difficulty", item => (
        item === "easy" || item === "medium" || item === "hard" || item === "killer"
    ))) return false;
    if (!optionalProjectionField(value, "cognitiveLevel", item => (
        item === "recall" || item === "understanding" || item === "application" || item === "reasoning"
    ))) return false;
    if (!optionalProjectionField(value, "retakeMode", item => (
        item === "wrong" || item === "similar" || item === "custom"
    ))) return false;
    if (!["selectedAnswer", "correctAnswer", "pdfPage", "handwritingPage"].every(
        key => optionalProjectionField(value, key, isPositiveSafeInteger),
    )) return false;
    if (!["visitCount", "revisitCount", "answerChangeCount", "handwritingStrokeCount"].every(
        key => optionalProjectionField(value, key, isNonNegativeSafeInteger),
    )) return false;
    if (!["expectedTimeSec", "timeSec"].every(
        key => optionalProjectionField(value, key, isFiniteNonNegative),
    )) return false;
    return optionalProjectionField(value, "mistakeTypes", isStringArray)
        && optionalProjectionField(value, "prerequisites", isStringArray)
        && optionalProjectionField(value, "pdfLocation", item => isPdfLocationProjection(item, false))
        && optionalProjectionField(value, "pdfRegion", item => isPdfLocationProjection(item, true))
        && optionalProjectionField(value, "passagePdfRegions", item => (
            Array.isArray(item) && item.every(region => isPdfLocationProjection(region, true))
        ))
        && optionalProjectionField(value, "answeredAt", item => !!safeIso(item));
}

function isQuestionTimingProjection(value: unknown): boolean {
    if (!isPlainRecord(value)
        || !hasOnlyProjectionKeys(value, [
            "questionId", "questionNumber", "totalTimeSec", "visitCount", "revisitCount", "answerChangeCount",
            "firstVisitedAt", "lastVisitedAt", "lastAnsweredAt",
        ])
        || !isPositiveSafeInteger(value.questionId)
        || !isPositiveSafeInteger(value.questionNumber)
        || !isFiniteNonNegative(value.totalTimeSec)
        || !isNonNegativeSafeInteger(value.visitCount)
        || !isNonNegativeSafeInteger(value.revisitCount)
        || !isNonNegativeSafeInteger(value.answerChangeCount)) return false;
    return ["firstVisitedAt", "lastVisitedAt", "lastAnsweredAt"].every(
        key => optionalProjectionField(value, key, item => !!safeIso(item)),
    );
}

function isFocusLossEventProjection(value: unknown): boolean {
    return isPlainRecord(value)
        && hasOnlyProjectionKeys(value, ["at", "questionId", "questionNumber", "count", "reason"])
        && !!safeIso(value.at)
        && isNonNegativeSafeInteger(value.count)
        && (value.reason === "blur" || value.reason === "hidden")
        && optionalProjectionField(value, "questionId", isPositiveSafeInteger)
        && optionalProjectionField(value, "questionNumber", isPositiveSafeInteger);
}

function isStudentQuestionProjection(value: unknown): boolean {
    if (!isPlainRecord(value)
        || !Object.keys(value).every(key => (
            key === "questionId" || key === "questionNumber" || key === "body"
            || key === "createdAt" || key === "status" || key === "answer"
        ))
        || !isPositiveSafeInteger(value.questionId)
        || !isPositiveSafeInteger(value.questionNumber)
        || value.body !== ""
        || !isBoundedString(value.createdAt)
        || (value.status !== "queued" && value.status !== "answered")) return false;
    return optionalProjectionField(value, "answer", answer => isPlainRecord(answer)
        && Object.keys(answer).every(key => key === "body" || key === "createdAt")
        && answer.body === ""
        && isBoundedString(answer.createdAt));
}

function isAttemptHandwritingProjection(value: unknown): boolean {
    if (!isPlainRecord(value)
        || !hasOnlyProjectionKeys(value, ["schemaVersion", "status", "strokesRef", "plan", "summary", "questions"])
        || value.schemaVersion !== 1
        || !["none", "saved", "failed", "unavailable", "plan_required"].includes(String(value.status))
        || !["free", "pro", "academy", "school"].includes(String(value.plan))
        || !isPlainRecord(value.summary)
        || !hasOnlyProjectionKeys(value.summary, ["pageCount", "strokeCount", "questionCount"])
        || !["pageCount", "strokeCount", "questionCount"].every(
            key => isNonNegativeSafeInteger((value.summary as Record<string, unknown>)[key]),
        )
        || !isPlainRecord(value.questions)) return false;
    if (!optionalProjectionField(value, "strokesRef", isStoredDataRefProjection)) return false;
    return Reflect.ownKeys(value.questions).every(key => typeof key === "string"
        && /^[1-9]\d*$/.test(key)
        && Number.isSafeInteger(Number(key))
        && isQuestionDrawingSummaryProjection((value.questions as Record<string, unknown>)[key]));
}

function isRetakeProjection(value: unknown): boolean {
    return isPlainRecord(value)
        && hasOnlyProjectionKeys(value, ["sourceAttemptId", "questionIds", "mode", "labels", "concepts", "createdAt"])
        && isExactProjectionText(value.sourceAttemptId)
        && isPositiveIntegerArray(value.questionIds)
        && (value.mode === "wrong" || value.mode === "similar" || value.mode === "custom")
        && !!safeIso(value.createdAt)
        && optionalProjectionField(value, "labels", isStringArray)
        && optionalProjectionField(value, "concepts", isStringArray);
}

function isCanonicalAttemptOptionalProjection(value: Record<string, unknown>): boolean {
    const optionalTexts = [
        "class_id", "assignment_id", "student_profile_id", "student_id", "group_id", "group_name",
        "region_id", "region_name", "retake_source_attempt_id", "merged_from_guest_id", "guest_id",
    ];
    if (!optionalTexts.every(key => optionalProjectionField(value, key, isExactProjectionText))) return false;
    if (!optionalProjectionField(value, "identity_type", item => (
        item === "guest" || item === "temporary" || item === "registered"
    ))) return false;
    if (!optionalProjectionField(value, "retake_mode", item => (
        item === "wrong" || item === "similar" || item === "custom"
    ))) return false;
    if (!optionalProjectionField(value, "retake_question_ids", isPositiveIntegerArray)) return false;
    const hasRetakeSource = value.retake_source_attempt_id !== undefined && value.retake_source_attempt_id !== null;
    const hasRetakeMode = value.retake_mode !== undefined && value.retake_mode !== null;
    if (hasRetakeSource !== hasRetakeMode) return false;
    if (!optionalProjectionField(value, "merged_at", item => !!safeIso(item))) return false;
    if (!optionalProjectionField(value, "score_percent", isFiniteNonNegative)) return false;
    if (!["auto_submitted", "handwriting_archived"].every(
        key => optionalProjectionField(value, key, item => typeof item === "boolean"),
    )) return false;
    if (!["tab_foci_lost_count", "handwriting_question_count", "drawing_page_count", "drawing_stroke_count"].every(
        key => optionalProjectionField(value, key, isNonNegativeSafeInteger),
    )) return false;
    if (!optionalProjectionField(value, "handwriting_plan", item => (
        item === "free" || item === "pro" || item === "academy" || item === "school"
    ))) return false;
    return optionalProjectionField(value, "question_results", item => (
        Array.isArray(item) && item.every(isQuestionResultProjection)
    ))
        && optionalProjectionField(value, "question_timings", item => (
            Array.isArray(item) && item.every(isQuestionTimingProjection)
        ))
        && optionalProjectionField(value, "focus_loss_events", item => (
            Array.isArray(item) && item.every(isFocusLossEventProjection)
        ))
        && optionalProjectionField(value, "student_questions", item => (
            Array.isArray(item) && item.every(isStudentQuestionProjection)
        ))
        && optionalProjectionField(value, "drawings_ref", isStoredDataRefProjection)
        && optionalProjectionField(value, "handwriting_strokes_ref", isStoredDataRefProjection)
        && optionalProjectionField(value, "handwriting", isAttemptHandwritingProjection)
        && optionalProjectionField(value, "question_drawings", item => (
            Array.isArray(item) && item.every(isQuestionDrawingSummaryProjection)
        ))
        && optionalProjectionField(value, "retake", isRetakeProjection);
}

function isCanonicalAnswers(value: unknown): value is Record<string, number> {
    if (!isPlainRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    return Reflect.ownKeys(value).every(key => {
        if (typeof key !== "string" || !/^[1-9]\d*$/.test(key) || !Number.isSafeInteger(Number(key))) return false;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !!descriptor
            && descriptor.enumerable
            && Object.hasOwn(descriptor, "value")
            && typeof descriptor.value === "number"
            && Number.isFinite(descriptor.value);
    });
}

function isCanonicalAttemptListRow(
    value: unknown,
    organizationId: string,
    requireAnswers: boolean,
): value is Record<string, unknown> {
    if (!isPlainRecord(value)) return false;
    return value.organization_id === organizationId
        && isExactProjectionText(value.id)
        && isExactProjectionText(value.exam_id)
        && isExactProjectionText(value.student_name)
        && isExactProjectionText(value.exam_title)
        && (value.status === "in_progress" || value.status === "completed")
        && typeof value.score === "number"
        && Number.isFinite(value.score)
        && value.score >= 0
        && typeof value.total_score === "number"
        && Number.isFinite(value.total_score)
        && value.total_score >= 0
        && !!safeIso(value.started_at)
        && !!safeIso(value.finished_at)
        && (value.updated_at === undefined || !!safeIso(value.updated_at))
        && isCanonicalAttemptOptionalProjection(value)
        && (!requireAnswers || isCanonicalAnswers(value.answers));
}

function postgrestQuotedFilterValue(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

interface AttemptDatabaseCursor {
    finishedAtMicroseconds: string;
    id: string;
}

function attemptDatabaseCursor(value: unknown): AttemptDatabaseCursor | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as { id?: unknown; finished_at?: unknown };
    const id = clean(row.id);
    const finishedAtMicroseconds = canonicalUtcTimestampMicrosecondKey(row.finished_at);
    return id && finishedAtMicroseconds ? { finishedAtMicroseconds, id } : undefined;
}

function attemptPublicCursor(value: unknown): TeacherAttemptPage["nextCursor"] | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as { id?: unknown; finished_at?: unknown };
    const id = clean(row.id);
    const finishedAt = safeIso(row.finished_at);
    return id && finishedAt ? { finishedAt, id } : undefined;
}

function followsDescendingAttemptCursor(
    previous: AttemptDatabaseCursor,
    current: AttemptDatabaseCursor,
): boolean {
    return current.finishedAtMicroseconds < previous.finishedAtMicroseconds
        || (current.finishedAtMicroseconds === previous.finishedAtMicroseconds && current.id < previous.id);
}

async function listRecentTeacherAttemptRows(
    client: TeacherAttemptGatewayClient,
    context: WorkspaceContext,
    columns: string,
    examId?: string,
    requireAnswers = false,
): Promise<
    | { status: "loaded"; rows: unknown[]; hasMore: boolean }
    | { status: "service_unavailable"; error?: string }
> {
    const ceiling = INITIAL_OPERATIONS_LIMITS.teacherAttempts;
    const pageSize = INITIAL_OPERATIONS_LIMITS.listPageSize;
    const normalizedExamId = examId?.trim();
    const rows: unknown[] = [];
    let previousCursor: AttemptDatabaseCursor | undefined;

    while (rows.length <= ceiling) {
        const requestSize = Math.min(pageSize, (ceiling + 1) - rows.length);
        let query = client
            .from("omr_attempts")
            .select(columns)
            .eq("organization_id", context.organizationId);
        if (normalizedExamId) query = query.eq("exam_id", normalizedExamId);
        if (previousCursor) {
            const finishedAt = postgrestQuotedFilterValue(previousCursor.finishedAtMicroseconds);
            const id = postgrestQuotedFilterValue(previousCursor.id);
            query = query.or(`finished_at.lt.${finishedAt},and(finished_at.eq.${finishedAt},id.lt.${id})`);
        }
        const ordered = query
            .order("finished_at", { ascending: false })
            .order("id", { ascending: false });
        const result = await ordered.limit(requestSize);
        if (result.error) return { status: "service_unavailable", error: result.error.message };
        const page = result.data || [];
        if (page.length > requestSize) {
            return { status: "service_unavailable", error: "Invalid canonical attempt pagination" };
        }
        for (const row of page) {
            if (!isCanonicalAttemptListRow(row, clean(context.organizationId), requireAnswers)) {
                return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
            }
            const cursor = attemptDatabaseCursor(row);
            if (!cursor) {
                return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
            }
            if (previousCursor && !followsDescendingAttemptCursor(previousCursor, cursor)) {
                return { status: "service_unavailable", error: "Invalid canonical attempt pagination" };
            }
            previousCursor = cursor;
        }
        rows.push(...page);
        if (page.length < requestSize) break;
    }

    return {
        status: "loaded",
        rows: rows.slice(0, ceiling),
        hasMore: rows.length > ceiling,
    };
}

function optionalClean(value: unknown): string | undefined {
    return clean(value) || undefined;
}

function activeSessionFromProjection(value: unknown): TeacherActiveAttemptSession | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const sessionId = clean(row.session_id);
    const attemptId = clean(row.attempt_id);
    const examId = clean(row.exam_id);
    const ownerStudentId = clean(row.owner_student_id);
    const studentName = clean(row.student_name);
    const identityType = row.identity_type;
    const startedAt = safeIso(row.started_at);
    const deadlineAt = safeIso(row.deadline_at);
    const lastHeartbeatAt = safeIso(row.last_heartbeat_at);
    const revision = safePositiveInteger(row.revision);
    const answeredCount = safeNonNegativeInteger(row.answered_count);
    const totalQuestionCount = safePositiveInteger(row.total_question_count);
    const currentQuestionId = safePositiveInteger(row.current_question_id);
    const assignmentId = optionalClean(row.assignment_id);
    const assignmentRevision = safePositiveInteger(row.assignment_revision);
    if (
        !sessionId || !attemptId || !examId || !ownerStudentId || !studentName
        || (identityType !== "guest" && identityType !== "temporary" && identityType !== "registered")
        || !startedAt || !deadlineAt || !lastHeartbeatAt || !revision
        || answeredCount === null || !totalQuestionCount || answeredCount > totalQuestionCount
        || Boolean(assignmentId) !== Boolean(assignmentRevision)
    ) return null;
    return {
        sessionId,
        attemptId,
        examId,
        ...(optionalClean(row.class_id) ? { classId: optionalClean(row.class_id) } : {}),
        ...(assignmentId && assignmentRevision ? { assignmentId, assignmentRevision } : {}),
        ownerStudentId,
        ...(optionalClean(row.student_profile_id) ? { studentProfileId: optionalClean(row.student_profile_id) } : {}),
        studentName,
        identityType,
        startedAt,
        deadlineAt,
        lastHeartbeatAt,
        revision,
        answeredCount,
        totalQuestionCount,
        ...(currentQuestionId ? { currentQuestionId } : {}),
    };
}

export async function listTeacherActiveAttemptSessionsWithGateway(
    client: TeacherAttemptGatewayClient,
    context: WorkspaceContext,
    examId: string,
): Promise<TeacherActiveAttemptSessionListResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const normalizedExamId = clean(examId);
    if (!normalizedExamId) return { status: "service_unavailable", error: "Invalid exam scope" };
    const result = await client.rpc("omr_list_active_attempt_sessions_v2", {
        p_organization_id: clean(context.organizationId),
        p_exam_id: normalizedExamId,
        p_actor_user_id: clean(context.actorUserId),
        p_member_role: context.memberRole,
        p_limit: INITIAL_OPERATIONS_LIMITS.activeStudents + 1,
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const rows = Array.isArray(result.data) ? result.data : [];
    if (rows.length > INITIAL_OPERATIONS_LIMITS.activeStudents) {
        return { status: "service_unavailable", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
    }
    const sessions = rows.map(activeSessionFromProjection);
    if (
        sessions.some(session => !session)
        || new Set(sessions.map(session => session?.sessionId)).size !== sessions.length
        || sessions.some(session => session?.examId !== normalizedExamId)
    ) {
        return { status: "service_unavailable", error: "Invalid active session projection" };
    }
    return { status: "loaded", sessions: sessions as TeacherActiveAttemptSession[] };
}

function attemptFromMutationResult(
    result: AttemptQueryResult<Array<{ payload: Attempt }> | { payload: Attempt }>,
): TeacherAttemptMutationResult {
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const record = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!record?.payload) return { status: "not_found" };
    try {
        return { status: "saved", attempt: attemptFromSupabaseRow(record, attestCanonicalQuestionResultEvidence) };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}

export async function answerTeacherAttemptQuestionWithGateway(
    client: TeacherAttemptGatewayClient,
    input: AnswerTeacherAttemptQuestionInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const attemptId = clean(input.attemptId);
    const questionId = String(input.questionId).trim();
    const answer = clean(input.answer);
    if (
        !attemptId
        || !/^\d+$/.test(questionId)
        || !answer
        || answer.length > STUDENT_QUESTION_MAX_LENGTH
    ) {
        return { status: "invalid_request" };
    }
    return attemptFromMutationResult(await client.rpc("omr_answer_attempt_question_v1", {
        p_organization_id: context.organizationId,
        p_attempt_id: attemptId,
        p_question_id: questionId,
        p_answer: answer,
        ...actorRpcArgs(context),
    }));
}

export async function setTeacherAttemptSubquestionReviewWithGateway(
    client: TeacherAttemptGatewayClient,
    input: SetTeacherAttemptSubquestionReviewInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const attemptId = clean(input.attemptId);
    const questionId = String(input.questionId).trim();
    const subquestionId = clean(input.subquestionId);
    if (
        !attemptId
        || !/^\d+$/.test(questionId)
        || !subquestionId
        || subquestionId.length > 100
        || subquestionId.includes(":")
        || (input.status !== "reviewed" && input.status !== "needs_review")
    ) {
        return { status: "invalid_request" };
    }
    return attemptFromMutationResult(await client.rpc("omr_set_subquestion_review_v1", {
        p_organization_id: context.organizationId,
        p_attempt_id: attemptId,
        p_subquestion_id: `${questionId}:${subquestionId}`,
        p_status: input.status,
        ...actorRpcArgs(context),
    }));
}

export async function forceFinishTeacherAttemptsWithGateway(
    client: TeacherAttemptGatewayClient,
    input: ForceFinishTeacherAttemptsInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptBatchMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const attemptIds = [...new Set((input.attemptIds || []).map(clean).filter(Boolean))];
    const finishedAt = clean(input.finishedAt);
    if (
        attemptIds.length === 0
        || attemptIds.length > 100
        || !Number.isFinite(Date.parse(finishedAt))
    ) {
        return { status: "invalid_request" };
    }
    const attemptResult = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .in("id", attemptIds)
        .order("id", { ascending: true });
    if (attemptResult.error) {
        return { status: "service_unavailable", error: attemptResult.error.message };
    }
    const storedAttempts = (attemptResult.data || []).flatMap(row => {
        try {
            const record = row as SupabaseAttemptRow;
            return [{
                attempt: attemptFromSupabaseRow(record, attestCanonicalQuestionResultEvidence),
            }];
        } catch {
            return [];
        }
    });
    if (
        storedAttempts.length !== attemptIds.length
        || new Set(storedAttempts.map(item => item.attempt.id)).size !== attemptIds.length
        || storedAttempts.some(item => !attemptIds.includes(item.attempt.id))
    ) {
        return { status: "not_found" };
    }

    const examIds = [...new Set(storedAttempts.map(item => clean(item.attempt.examId)).filter(Boolean))];
    const examResult = await client
        .from("omr_exams")
        .select(SUPABASE_EXAM_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .in("id", examIds)
        .order("id", { ascending: true });
    if (examResult.error) {
        return { status: "service_unavailable", error: examResult.error.message };
    }
    const examsById = new Map((examResult.data || []).flatMap(row => {
        try {
            const record = row as SupabaseExamRow;
            const exam = examFromSupabaseRow(record);
            const updatedAt = clean(record.updated_at);
            return updatedAt ? [[exam.id, { exam, updatedAt }] as const] : [];
        } catch {
            return [];
        }
    }));
    if (examsById.size !== examIds.length) return { status: "not_found" };

    const gradingByAttemptId = new Map<string, Record<string, unknown>>();
    for (const stored of storedAttempts) {
        const canonicalExam = examsById.get(stored.attempt.examId);
        if (!canonicalExam) return { status: "not_found" };
        const graded = gradeTeacherForcedAttemptOnServer(
            canonicalExam.exam,
            stored.attempt,
            finishedAt,
        );
        if (!graded.ok) {
            return { status: "service_unavailable", error: graded.error };
        }
        const questionResultRows = questionResultRowsForAttempt(
            graded.attempt,
            finishedAt,
            context,
        );
        if (questionResultRows.length !== (graded.attempt.questionResults || []).length) {
            return { status: "service_unavailable", error: "Invalid canonical grading rows" };
        }
        gradingByAttemptId.set(stored.attempt.id, {
            attempt_id: stored.attempt.id,
            expected_answers: stored.attempt.answers || {},
            expected_is_retake: !!stored.attempt.retake,
            expected_retake_question_ids: stored.attempt.retake?.questionIds || [],
            expected_exam_updated_at: canonicalExam.updatedAt,
            score: graded.attempt.score,
            total_score: graded.attempt.totalScore,
            question_results: graded.attempt.questionResults || [],
            question_result_rows: questionResultRows,
        });
    }
    const gradings = attemptIds.map(attemptId => gradingByAttemptId.get(attemptId));
    if (gradings.some(grading => !grading)) {
        return { status: "service_unavailable", error: "Missing canonical grading" };
    }

    const result = await client.rpc("omr_force_finish_attempts_v1", {
        p_organization_id: context.organizationId,
        p_attempt_ids: attemptIds,
        p_finished_at: finishedAt,
        ...actorRpcArgs(context),
        p_gradings: gradings,
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const records = Array.isArray(result.data) ? result.data : result.data ? [result.data] : [];
    if (records.length !== attemptIds.length) return { status: "not_found" };
    try {
        const attempts = records.map(record => attemptFromSupabaseRow(record, attestCanonicalQuestionResultEvidence));
        if (
            attempts.some(item => clean(item.organizationId) !== clean(context.organizationId))
            || attempts.some(item => item.status !== "completed")
            || attempts.some((item, index) => item.id !== attemptIds[index])
        ) {
            return { status: "service_unavailable", error: "Invalid canonical attempt scope" };
        }
        return { status: "saved", attempts };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}

interface PreparedTeacherAttemptSession {
    sessionId: string;
    revision: number;
    gradingFingerprint: string;
    assignmentId?: string;
    assignmentRevision?: number;
}

function safeRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function preparedTeacherSession(value: unknown, organizationId: string): PreparedTeacherAttemptSession | null {
    const row = safeRecord(value);
    if (!row || (row.status !== "in_progress" && row.status !== "submitted")) return null;
    const sessionId = clean(row.session_id);
    const revision = safePositiveInteger(row.revision);
    const gradingFingerprint = clean(row.grading_fingerprint);
    const assignmentId = optionalClean(row.assignment_id);
    const assignmentRevision = safePositiveInteger(row.assignment_revision);
    if (
        !sessionId || !revision
        || !/^[a-f0-9]{64}$/.test(gradingFingerprint)
        || clean(row.organization_id) !== organizationId
        || Boolean(assignmentId) !== Boolean(assignmentRevision)
    ) return null;
    return {
        sessionId,
        revision,
        gradingFingerprint,
        ...(assignmentId && assignmentRevision ? { assignmentId, assignmentRevision } : {}),
    };
}

export async function forceFinishTeacherAttemptSessionsWithGateway(
    client: TeacherAttemptGatewayClient,
    input: ForceFinishTeacherAttemptSessionsInput,
    context: WorkspaceContext,
): Promise<TeacherAttemptBatchMutationResult> {
    if (!mutationContextIsAuthorized(context)) return { status: "forbidden" };
    const sessionIds = [...new Set((input.sessionIds || []).map(clean).filter(Boolean))];
    const finishedAt = clean(input.finishedAt);
    if (
        sessionIds.length === 0
        || sessionIds.length > INITIAL_OPERATIONS_LIMITS.activeStudents
        || !Number.isFinite(Date.parse(finishedAt))
    ) return { status: "invalid_request" };

    const preparedResult = await client.rpc("omr_prepare_teacher_force_finish_sessions_compact_v2", {
        p_organization_id: clean(context.organizationId),
        p_session_ids: sessionIds,
        p_actor_user_id: clean(context.actorUserId),
        p_member_role: context.memberRole,
    });
    if (preparedResult.error) {
        return { status: "service_unavailable", error: preparedResult.error.message };
    }
    const preparedRows = Array.isArray(preparedResult.data) ? preparedResult.data : [];
    const sessions = preparedRows.map(row => preparedTeacherSession(row, clean(context.organizationId)));
    if (
        sessions.length !== sessionIds.length
        || sessions.some(session => !session)
        || new Set(sessions.map(session => session?.sessionId)).size !== sessionIds.length
        || sessions.some(session => !sessionIds.includes(session?.sessionId || ""))
    ) return { status: "not_found" };

    const expectationBySessionId = new Map<string, Record<string, unknown>>();
    for (const session of sessions as PreparedTeacherAttemptSession[]) {
        expectationBySessionId.set(session.sessionId, {
            session_id: session.sessionId,
            expected_revision: session.revision,
            expected_fingerprint: session.gradingFingerprint,
        });
    }
    const expectations = sessionIds.map(sessionId => expectationBySessionId.get(sessionId));
    if (expectations.some(expectation => !expectation)) {
        return { status: "service_unavailable", error: "Missing session grading CAS" };
    }
    const result = await client.rpc("omr_force_finish_attempt_sessions_compact_v2", {
        p_organization_id: clean(context.organizationId),
        p_session_ids: sessionIds,
        p_finished_at: finishedAt,
        ...actorRpcArgs(context),
        p_expectations: expectations,
    });
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    const records = Array.isArray(result.data) ? result.data : [];
    if (records.length !== sessionIds.length) return { status: "not_found" };
    try {
        const attempts = records.map(record => attemptFromSupabaseRow(
            record as { payload: Attempt },
            attestCanonicalQuestionResultEvidence,
        ));
        if (
            attempts.some(attempt => clean(attempt.organizationId) !== clean(context.organizationId))
            || attempts.some(attempt => attempt.status !== "completed")
            || new Set(attempts.map(attempt => attempt.id)).size !== attempts.length
        ) return { status: "service_unavailable", error: "Invalid canonical attempt scope" };
        return { status: "saved", attempts };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}

export async function listTeacherAttemptsWithGateway(
    client: TeacherAttemptGatewayClient,
    context: WorkspaceContext,
    examId?: string,
): Promise<TeacherAttemptListResult> {
    const result = await listRecentTeacherAttemptRows(
        client,
        context,
        SUPABASE_ATTEMPT_LIST_READ_COLUMNS,
        examId,
        true,
    );
    if (result.status === "service_unavailable") return result;
    const { rows, hasMore } = result;
    if (hasMore) {
        return { status: "service_unavailable", error: "Incomplete canonical attempt collection" };
    }

    const attempts: Attempt[] = [];
    for (const row of rows) {
        try {
            const record = row as Record<string, unknown>;
            const attempt = attemptFromSupabaseListRow({
                ...record,
                started_at: safeIso(record.started_at),
                finished_at: safeIso(record.finished_at),
                ...(record.updated_at === undefined ? {} : { updated_at: safeIso(record.updated_at) }),
            }, attestCanonicalQuestionResultEvidence);
            if (clean(attempt.organizationId) !== clean(context.organizationId)) {
                return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
            }
            attempts.push(attempt);
        } catch {
            return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
        }
    }
    if (attempts.length !== rows.length) {
        return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
    }
    const nextCursor = attemptPublicCursor(rows.at(-1));
    return {
        status: "loaded",
        attempts,
        page: {
            partial: false,
            hasMore: false,
            itemCount: attempts.length,
            ...(nextCursor ? { nextCursor } : {}),
        },
        meta: {
            organizationId: clean(context.organizationId),
            loadedAt: new Date().toISOString(),
            rawCount: rows.length,
            parsedCount: attempts.length,
        },
    };
}

export async function listTeacherAttemptSummariesWithGateway(
    client: TeacherAttemptGatewayClient,
    context: WorkspaceContext,
    examId?: string,
): Promise<TeacherAttemptSummaryListResult> {
    const result = await listRecentTeacherAttemptRows(
        client,
        context,
        SUPABASE_TEACHER_ATTEMPT_SUMMARY_READ_COLUMNS,
        examId,
    );
    if (result.status === "service_unavailable") return result;
    const { rows, hasMore } = result;
    if (hasMore) {
        return { status: "service_unavailable", error: "Incomplete canonical attempt collection" };
    }

    const attempts: TeacherAttemptSummary[] = [];
    for (const row of rows) {
        try {
            const record = row as Record<string, unknown>;
            const attempt = teacherAttemptSummaryFromSupabaseListRow({
                ...record,
                started_at: safeIso(record.started_at),
                finished_at: safeIso(record.finished_at),
                ...(record.updated_at === undefined ? {} : { updated_at: safeIso(record.updated_at) }),
            });
            if (clean(attempt.organizationId) !== clean(context.organizationId)) {
                return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
            }
            attempts.push(attempt);
        } catch {
            return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
        }
    }
    if (attempts.length !== rows.length) {
        return { status: "service_unavailable", error: "Invalid canonical attempt collection" };
    }
    const nextCursor = attemptPublicCursor(rows.at(-1));
    return {
        status: "loaded",
        attempts,
        page: {
            partial: false,
            hasMore: false,
            itemCount: attempts.length,
            ...(nextCursor ? { nextCursor } : {}),
        },
        meta: {
            organizationId: clean(context.organizationId),
            loadedAt: new Date().toISOString(),
            rawCount: rows.length,
            parsedCount: attempts.length,
        },
    };
}

export async function loadTeacherAttemptWithGateway(
    client: TeacherAttemptGatewayClient,
    attemptId: string,
    context: WorkspaceContext,
): Promise<TeacherAttemptLoadResult> {
    if (!attemptId.trim()) return { status: "not_found" };
    const result = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", context.organizationId)
        .eq("id", attemptId.trim())
        .maybeSingle();
    if (result.error) return { status: "service_unavailable", error: result.error.message };
    if (!result.data) return { status: "not_found" };
    try {
        return {
            status: "loaded",
            attempt: attemptFromSupabaseRow(result.data as SupabaseAttemptRow, attestCanonicalQuestionResultEvidence),
        };
    } catch {
        return { status: "service_unavailable", error: "Invalid canonical attempt payload" };
    }
}
