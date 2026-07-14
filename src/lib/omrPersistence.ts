import { deleteStoredData } from "@/utils/blobStore";
import { canonicalQuestionIdFor } from "@/lib/questionBank";
import {
    DEFAULT_WORKSPACE_ORGANIZATION_NAME,
    readActiveWorkspaceContext,
    workspaceBootstrapRows,
    type WorkspaceContext,
} from "@/lib/workspaceContext";
import { questionChoiceCount, type Attempt, type Exam, type QuestionResult, type QuestionResultStatus, type StoredDataRef } from "@/types/omr";

type Env = Record<string, string | undefined>;

export interface SupabaseConfig {
    url: string;
    publishableKey: string;
}

export interface SupabaseExamRow {
    id: string;
    organization_id?: string | null;
    class_id?: string | null;
    title: string;
    payload: Exam;
    created_by_user_id?: string | null;
    created_at: string;
    updated_at: string;
    archived: boolean;
}

export interface SupabaseExamQuestionRow {
    id: string;
    organization_id?: string | null;
    class_id?: string | null;
    exam_id: string;
    question_id: number;
    question_number: number;
    canonical_question_id: string;
    label: string | null;
    subject: string | null;
    unit: string | null;
    concept: string | null;
    skill: string | null;
    source: string | null;
    difficulty: string | null;
    cognitive_level: string | null;
    mistake_types: string[];
    prerequisites: string[];
    expected_time_sec: number | null;
    choices: 4 | 5;
    correct_answer: number | null;
    score: number;
    pdf_page: number | null;
    pdf_location: Exam["questions"][number]["pdfLocation"] | null;
    pdf_region: Exam["questions"][number]["pdfRegion"] | null;
    has_pdf_region: boolean;
    asset_status: "metadata_only" | "pdf_region_ready" | "image_asset_ready";
    image_asset_ref: StoredDataRef | null;
    payload: Exam["questions"][number];
    updated_at: string;
}

export interface SupabaseAttemptRow {
    id: string;
    organization_id?: string | null;
    class_id?: string | null;
    assignment_id?: string | null;
    student_profile_id?: string | null;
    exam_id: string;
    student_name: string;
    student_id: string | null;
    group_id: string | null;
    group_name: string | null;
    region_id: string | null;
    region_name: string | null;
    identity_type: "guest" | "temporary" | "registered" | null;
    status: Attempt["status"];
    score: number;
    total_score: number;
    score_percent: number;
    retake_source_attempt_id: string | null;
    retake_mode: "wrong" | "similar" | "custom" | null;
    retake_question_ids: number[];
    merged_from_guest_id: string | null;
    merged_at: string | null;
    idempotency_key: string | null;
    payload: Attempt;
    started_at: string;
    finished_at: string;
}

export interface SupabaseQuestionResultRow {
    id: string;
    organization_id?: string | null;
    class_id?: string | null;
    assignment_id?: string | null;
    student_profile_id?: string | null;
    attempt_id: string;
    exam_id: string;
    student_name: string;
    student_id: string | null;
    group_id: string | null;
    group_name: string | null;
    region_id: string | null;
    region_name: string | null;
    identity_type: "guest" | "temporary" | "registered" | null;
    question_id: number;
    question_number: number;
    canonical_question_id: string | null;
    label: string | null;
    subject: string | null;
    unit: string | null;
    concept: string | null;
    skill: string | null;
    source: string | null;
    difficulty: string | null;
    cognitive_level: string | null;
    mistake_types: string[];
    prerequisites: string[];
    expected_time_sec: number | null;
    selected_answer: number | null;
    correct_answer: number | null;
    status: QuestionResultStatus;
    is_correct: boolean;
    is_wrong: boolean;
    is_unanswered: boolean;
    score: number;
    earned_score: number;
    pdf_page: number | null;
    pdf_location: QuestionResult["pdfLocation"] | null;
    pdf_region: QuestionResult["pdfRegion"] | null;
    time_sec: number | null;
    visit_count: number | null;
    revisit_count: number | null;
    answer_change_count: number | null;
    handwriting_stroke_count: number | null;
    handwriting_page: number | null;
    retake_source_attempt_id: string | null;
    retake_mode: "wrong" | "similar" | "custom" | null;
    answered_at: string | null;
    finished_at: string;
    payload: QuestionResult;
    updated_at: string;
}

export interface PersistenceResult {
    localSaved: boolean;
    remoteSaved: boolean;
    remoteError?: string;
}

interface LoadResult<T> {
    items: T[];
    remoteLoaded: boolean;
    remoteError?: string;
    remoteSynced?: boolean;
    pendingSyncCount?: number;
}

interface SupabaseQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

type SupabaseSelectQuery = {
    eq(column: string, value: string): SupabaseSelectQuery;
    maybeSingle(): Promise<SupabaseQueryResult<unknown>>;
    order(column: string, options?: { ascending?: boolean }): Promise<SupabaseQueryResult<unknown[]>>;
};

type SupabaseClientLike = {
    from(table: string): {
        select(columns?: string): SupabaseSelectQuery;
        upsert(row: unknown): Promise<SupabaseQueryResult<unknown>>;
        delete(): {
            eq(column: string, value: string): Promise<SupabaseQueryResult<unknown>>;
        };
    };
};

const EXAM_PREFIX = "omr_exam_";
const ATTEMPTS_KEY = "omr_attempts";
const DELETED_EXAMS_KEY = "omr_deleted_exam_ids";
const SOLVE_DRAFT_PREFIX = "omr_draft_";

let supabaseClientPromise: Promise<SupabaseClientLike | null> | null = null;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function scopedValue(value: unknown): string | null {
    return clean(value) || null;
}

function contextOrganizationId(context?: WorkspaceContext | null): string | null {
    return scopedValue(context?.organizationId);
}

function contextActorUserId(context?: WorkspaceContext | null): string | null {
    return scopedValue(context?.actorUserId);
}

function storedScopeContext(scope: {
    organizationId?: string;
    createdByUserId?: string;
} | null | undefined): WorkspaceContext | null {
    const organizationId = scopedValue(scope?.organizationId);
    if (!organizationId) return null;
    return {
        organizationId,
        organizationName: DEFAULT_WORKSPACE_ORGANIZATION_NAME,
        actorUserId: scopedValue(scope?.createdByUserId) || undefined,
    };
}

function activePersistenceContext(): WorkspaceContext {
    return readActiveWorkspaceContext();
}

function shouldFilterRemoteByOrganization(): boolean {
    // Always scope Supabase queries by organization_id — even for the DEFAULT
    // workspace — so multiple teachers sharing a Supabase project can never
    // read each other's data. DEFAULT users stored with organization_id='default'
    // are still correctly isolated from teacher-specific workspaces.
    return true;
}

function examWithPersistenceContext(exam: Exam, context = activePersistenceContext()): Exam {
    const organizationId = scopedValue(exam.organizationId) || contextOrganizationId(context);
    const createdByUserId = scopedValue(exam.createdByUserId) || contextActorUserId(context);
    return {
        ...exam,
        ...(organizationId ? { organizationId } : {}),
        ...(createdByUserId ? { createdByUserId } : {}),
    };
}

function contextForAttempt(attempt: Attempt): WorkspaceContext {
    const attemptContext = storedScopeContext(attempt);
    if (attemptContext) return attemptContext;

    const examContext = storedScopeContext(readLocalExam(attempt.examId));
    if (examContext) return examContext;

    return activePersistenceContext();
}

function attemptWithPersistenceContext(attempt: Attempt, context = contextForAttempt(attempt)): Attempt {
    const organizationId = scopedValue(attempt.organizationId) || contextOrganizationId(context);
    const classId = scopedValue(attempt.classId) || scopedValue(attempt.groupId);
    const assignmentId = scopedValue(attempt.assignmentId);
    const studentProfileId = scopedValue(attempt.studentProfileId) || scopedValue(attempt.studentId);
    return {
        ...attempt,
        ...(organizationId ? { organizationId } : {}),
        ...(classId ? { classId } : {}),
        ...(assignmentId ? { assignmentId } : {}),
        ...(studentProfileId ? { studentProfileId } : {}),
    };
}

export function getSupabaseConfigFromEnv(env: Env): SupabaseConfig | null {
    const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const publishableKey = (
        env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    )?.trim();

    if (!url || !publishableKey) return null;
    return { url, publishableKey };
}

export function getSupabaseConfig(): SupabaseConfig | null {
    return getSupabaseConfigFromEnv(process.env);
}

export function isSupabaseConfigured(): boolean {
    return !!getSupabaseConfig();
}

export function examToSupabaseRow(exam: Exam, context?: WorkspaceContext | null): SupabaseExamRow {
    const createdAt = exam.createdAt || new Date().toISOString();
    return {
        id: exam.id,
        organization_id: scopedValue(exam.organizationId) || contextOrganizationId(context),
        class_id: scopedValue(exam.classId),
        title: exam.title,
        payload: exam,
        created_by_user_id: scopedValue(exam.createdByUserId) || contextActorUserId(context),
        created_at: createdAt,
        updated_at: exam.updatedAt || createdAt,
        archived: !!exam.archived,
    };
}

export function examFromSupabaseRow(row: SupabaseExamRow | { payload: Exam }): Exam {
    const exam = sanitizeExamPayload(row.payload);
    if (!exam) throw new Error("Invalid exam payload");
    if ("organization_id" in row || "class_id" in row || "created_by_user_id" in row) {
        return {
            ...exam,
            organizationId: scopedValue(row.organization_id) || exam.organizationId,
            classId: scopedValue(row.class_id) || exam.classId,
            createdByUserId: scopedValue(row.created_by_user_id) || exam.createdByUserId,
        };
    }
    return exam;
}

export function examQuestionToSupabaseRow(
    exam: Exam,
    question: Exam["questions"][number],
    updatedAt = new Date().toISOString(),
    context?: WorkspaceContext | null,
): SupabaseExamQuestionRow {
    const questionId = numberValue(question.id);
    if (questionId === undefined) {
        throw new Error("Invalid exam question payload");
    }

    const questionNumber = numberValue(question.number) || questionId;
    const tags = question.tags || {};
    const canonicalQuestionId = canonicalQuestionIdFor(exam.id, questionId);
    const pdfPage = question.pdfRegion?.page || question.pdfLocation?.page || null;
    const imageAssetRef = question.imageAssetRef || null;
    const assetStatus = imageAssetRef
        ? "image_asset_ready"
        : question.pdfRegion
            ? "pdf_region_ready"
            : "metadata_only";

    return {
        id: canonicalQuestionId,
        organization_id: scopedValue(exam.organizationId) || contextOrganizationId(context),
        class_id: scopedValue(exam.classId),
        exam_id: exam.id,
        question_id: questionId,
        question_number: questionNumber,
        canonical_question_id: canonicalQuestionId,
        label: nullableString(question.label),
        subject: nullableString(tags.subject),
        unit: nullableString(tags.unit),
        concept: nullableString(tags.concept),
        skill: nullableString(tags.skill),
        source: nullableString(tags.source),
        difficulty: nullableString(tags.difficulty),
        cognitive_level: nullableString(tags.cognitiveLevel),
        mistake_types: stringArray(tags.mistakeTypes),
        prerequisites: stringArray(tags.prerequisites),
        expected_time_sec: nullableNumber(tags.expectedTimeSec),
        choices: questionChoiceCount(question),
        correct_answer: nullableNumber(question.answer),
        score: numberValue(question.score) || 0,
        pdf_page: pdfPage,
        pdf_location: question.pdfLocation || null,
        pdf_region: question.pdfRegion || null,
        has_pdf_region: !!question.pdfRegion,
        asset_status: assetStatus,
        image_asset_ref: imageAssetRef,
        payload: question,
        updated_at: updatedAt,
    };
}

export function examQuestionRowsForExam(
    exam: Exam,
    updatedAt = new Date().toISOString(),
    context?: WorkspaceContext | null,
): SupabaseExamQuestionRow[] {
    return exam.questions.flatMap(question => {
        try {
            return [examQuestionToSupabaseRow(exam, question, updatedAt, context)];
        } catch {
            return [];
        }
    });
}

export function stripHeavyAttemptPayload(attempt: Attempt): Attempt {
    let stripped: Attempt = attempt.drawings ? { ...attempt, drawings: undefined } : attempt;
    // If handwriting was not successfully archived, clear the IndexedDB strokesRef
    // so localStorage never holds a pointer to data that may not exist.
    if (stripped.handwriting && stripped.handwriting.status !== 'saved' && stripped.handwriting.strokesRef) {
        stripped = { ...stripped, handwriting: { ...stripped.handwriting, strokesRef: undefined } };
    }
    return stripped;
}

export function attemptToSupabaseRow(attempt: Attempt, context?: WorkspaceContext | null): SupabaseAttemptRow {
    const score = numberValue(attempt.score) || 0;
    const totalScore = numberValue(attempt.totalScore) || 0;
    const scorePercent = totalScore > 0 ? Math.round((score / totalScore) * 100) : 0;
    const classId = scopedValue(attempt.classId) || scopedValue(attempt.groupId);
    const studentProfileId = scopedValue(attempt.studentProfileId) || scopedValue(attempt.studentId);

    return {
        id: attempt.id,
        organization_id: scopedValue(attempt.organizationId) || contextOrganizationId(context),
        class_id: classId,
        assignment_id: scopedValue(attempt.assignmentId),
        student_profile_id: studentProfileId,
        exam_id: attempt.examId,
        student_name: attempt.studentName,
        student_id: attempt.studentId || null,
        group_id: attempt.groupId || null,
        group_name: attempt.groupName || null,
        region_id: attempt.regionId || null,
        region_name: attempt.regionName || null,
        identity_type: identityTypeValue(attempt.identityType),
        status: attempt.status,
        score,
        total_score: totalScore,
        score_percent: scorePercent,
        retake_source_attempt_id: attempt.retake?.sourceAttemptId || null,
        retake_mode: retakeModeValue(attempt.retake?.mode),
        retake_question_ids: numberArray(attempt.retake?.questionIds),
        merged_from_guest_id: attempt.mergedFromGuestId || null,
        merged_at: attempt.mergedAt || null,
        idempotency_key: scopedValue(attempt.idempotencyKey),
        payload: stripHeavyAttemptPayload(attempt),
        started_at: attempt.startedAt,
        finished_at: attempt.finishedAt,
    };
}

export function attemptFromSupabaseRow(row: SupabaseAttemptRow | { payload: Attempt }): Attempt {
    const attempt = sanitizeAttemptPayload(row.payload);
    if (!attempt) throw new Error("Invalid attempt payload");
    if ("organization_id" in row || "class_id" in row || "assignment_id" in row || "student_profile_id" in row) {
        const organizationId = scopedValue(row.organization_id);
        const classId = scopedValue(row.class_id);
        const assignmentId = scopedValue(row.assignment_id);
        // Prefer the row's explicit column, fall back to the payload's studentProfileId,
        // then to studentId so analytics joins never lose the profile link.
        const studentProfileId = scopedValue(row.student_profile_id)
            || scopedValue(attempt.studentProfileId)
            || scopedValue(attempt.studentId);
        return {
            ...attempt,
            ...(organizationId ? { organizationId } : {}),
            ...(classId && classId !== attempt.groupId ? { classId } : {}),
            ...(assignmentId ? { assignmentId } : {}),
            ...(studentProfileId ? { studentProfileId } : {}),
        };
    }
    return attempt;
}

function isQuestionResultStatus(value: unknown): value is QuestionResultStatus {
    return value === "correct" || value === "wrong" || value === "unanswered" || value === "ungraded";
}

function nullableString(value: unknown): string | null {
    return stringValue(value) || null;
}

function nullableNumber(value: unknown): number | null {
    return numberValue(value) ?? null;
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function numberArray(value: unknown): number[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is number => typeof item === "number" && Number.isFinite(item));
}

function identityTypeValue(value: unknown): "guest" | "temporary" | "registered" | null {
    return value === "guest" || value === "temporary" || value === "registered" ? value : null;
}

function retakeModeValue(value: unknown): "wrong" | "similar" | "custom" | null {
    return value === "wrong" || value === "similar" || value === "custom" ? value : null;
}

export function questionResultToSupabaseRow(
    result: QuestionResult,
    attempt?: Attempt,
    updatedAt = new Date().toISOString(),
    context?: WorkspaceContext | null,
): SupabaseQuestionResultRow {
    const attemptId = stringValue(result.attemptId) || attempt?.id;
    const examId = stringValue(result.examId) || attempt?.examId;
    const questionId = numberValue(result.questionId);
    if (!attemptId || !examId || questionId === undefined) {
        throw new Error("Invalid question result payload");
    }

    const questionNumber = numberValue(result.questionNumber) || questionId;
    const status = isQuestionResultStatus(result.status) ? result.status : "ungraded";
    const studentName = stringValue(result.studentName) || attempt?.studentName || "Student";
    const finishedAt = stringValue(result.finishedAt) || attempt?.finishedAt || new Date(0).toISOString();
    const studentId = nullableString(result.studentId) || nullableString(attempt?.studentId);
    const groupId = nullableString(result.groupId) || nullableString(attempt?.groupId);
    const groupName = nullableString(result.groupName) || nullableString(attempt?.groupName);
    const classId = scopedValue(result.classId) || scopedValue(attempt?.classId) || groupId;
    const assignmentId = scopedValue(result.assignmentId) || scopedValue(attempt?.assignmentId);
    const studentProfileId = scopedValue(result.studentProfileId) || scopedValue(attempt?.studentProfileId) || studentId;
    const organizationId = scopedValue(result.organizationId)
        || scopedValue(attempt?.organizationId)
        || contextOrganizationId(context);
    const regionId = nullableString(result.regionId) || nullableString(attempt?.regionId);
    const regionName = nullableString(result.regionName) || nullableString(attempt?.regionName);
    const canonicalQuestionId = nullableString(result.canonicalQuestionId) || canonicalQuestionIdFor(examId, questionId);
    const identityType = identityTypeValue(result.identityType) || identityTypeValue(attempt?.identityType);
    const retakeSourceAttemptId = nullableString(result.retakeSourceAttemptId)
        || nullableString(attempt?.retake?.sourceAttemptId);
    const retakeMode = retakeModeValue(result.retakeMode) || retakeModeValue(attempt?.retake?.mode);
    const payload: QuestionResult = {
        ...result,
        attemptId,
        examId,
        organizationId: organizationId || undefined,
        classId: classId || undefined,
        assignmentId: assignmentId || undefined,
        studentProfileId: studentProfileId || undefined,
        studentName,
        studentId: studentId || undefined,
        groupId: groupId || undefined,
        groupName: groupName || undefined,
        regionId: regionId || undefined,
        regionName: regionName || undefined,
        identityType: identityType || undefined,
        questionId,
        questionNumber,
        canonicalQuestionId,
        status,
        isCorrect: status === "correct",
        isWrong: status === "wrong",
        isUnanswered: status === "unanswered",
        retakeSourceAttemptId: retakeSourceAttemptId || undefined,
        retakeMode: retakeMode || undefined,
        finishedAt,
    };

    return {
        id: `${attemptId}:${questionId}`,
        organization_id: organizationId,
        class_id: classId,
        assignment_id: assignmentId,
        student_profile_id: studentProfileId,
        attempt_id: attemptId,
        exam_id: examId,
        student_name: studentName,
        student_id: studentId,
        group_id: groupId,
        group_name: groupName,
        region_id: regionId,
        region_name: regionName,
        identity_type: identityType,
        question_id: questionId,
        question_number: questionNumber,
        canonical_question_id: canonicalQuestionId,
        label: nullableString(result.label),
        subject: nullableString(result.subject),
        unit: nullableString(result.unit),
        concept: nullableString(result.concept),
        skill: nullableString(result.skill),
        source: nullableString(result.source),
        difficulty: nullableString(result.difficulty),
        cognitive_level: nullableString(result.cognitiveLevel),
        mistake_types: stringArray(result.mistakeTypes),
        prerequisites: stringArray(result.prerequisites),
        expected_time_sec: nullableNumber(result.expectedTimeSec),
        selected_answer: nullableNumber(result.selectedAnswer),
        correct_answer: nullableNumber(result.correctAnswer),
        status,
        is_correct: status === "correct",
        is_wrong: status === "wrong",
        is_unanswered: status === "unanswered",
        score: numberValue(result.score) || 0,
        earned_score: numberValue(result.earnedScore) || 0,
        pdf_page: nullableNumber(result.pdfPage),
        pdf_location: result.pdfLocation || null,
        pdf_region: result.pdfRegion || null,
        time_sec: nullableNumber(result.timeSec),
        visit_count: nullableNumber(result.visitCount),
        revisit_count: nullableNumber(result.revisitCount),
        answer_change_count: nullableNumber(result.answerChangeCount),
        handwriting_stroke_count: nullableNumber(result.handwritingStrokeCount),
        handwriting_page: nullableNumber(result.handwritingPage),
        retake_source_attempt_id: retakeSourceAttemptId,
        retake_mode: retakeMode,
        answered_at: nullableString(result.answeredAt),
        finished_at: finishedAt,
        payload,
        updated_at: updatedAt,
    };
}

export function questionResultRowsForAttempt(
    attempt: Attempt,
    updatedAt = new Date().toISOString(),
    context?: WorkspaceContext | null,
): SupabaseQuestionResultRow[] {
    return (attempt.questionResults || []).flatMap(result => {
        try {
            return [questionResultToSupabaseRow(result, attempt, updatedAt, context)];
        } catch {
            return [];
        }
    });
}

export function attemptsWithQuestionResults(attempts: Attempt[]): Attempt[] {
    return attempts.filter(attempt => questionResultRowsForAttempt(attempt).length > 0);
}

function getActivityTime(item: Exam | Attempt): number {
    if ("finishedAt" in item) {
        return Date.parse(item.finishedAt || item.startedAt || "") || 0;
    }
    return Date.parse(item.updatedAt || item.createdAt || "") || 0;
}

export function sortByNewestActivity<T extends Exam | Attempt>(items: T[]): T[] {
    return [...items].sort((a, b) => getActivityTime(b) - getActivityTime(a));
}

function isAttemptItem(item: Exam | Attempt): item is Attempt {
    return "examId" in item && "answers" in item;
}

function arrayLength(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function preserveAttemptAnalytics(candidate: Attempt, current: Attempt): Attempt {
    return {
        ...candidate,
        questionResults: arrayLength(candidate.questionResults) > 0 ? candidate.questionResults : current.questionResults,
        questionTimings: arrayLength(candidate.questionTimings) > 0 ? candidate.questionTimings : current.questionTimings,
        questionDrawings: arrayLength(candidate.questionDrawings) > 0 ? candidate.questionDrawings : current.questionDrawings,
        handwriting: candidate.handwriting || current.handwriting,
        handwritingArchived: candidate.handwritingArchived ?? current.handwritingArchived,
        handwritingPlan: candidate.handwritingPlan || current.handwritingPlan,
        drawingPageCount: candidate.drawingPageCount ?? current.drawingPageCount,
        drawingStrokeCount: candidate.drawingStrokeCount ?? current.drawingStrokeCount,
        drawingsRef: candidate.drawingsRef || current.drawingsRef,
    };
}

function mergeItemPayload<T extends { id: string } & (Exam | Attempt)>(candidate: T, current?: T): T {
    if (!current || !isAttemptItem(candidate) || !isAttemptItem(current)) return candidate;
    return preserveAttemptAnalytics(candidate, current) as T;
}

function shouldReplaceMergedItem<T extends { id: string } & (Exam | Attempt)>(candidate: T, current: T): boolean {
    const candidateTime = getActivityTime(candidate);
    const currentTime = getActivityTime(current);
    if (candidateTime !== currentTime) return candidateTime > currentTime;

    if (isAttemptItem(candidate) && isAttemptItem(current)) {
        const candidateResultCount = arrayLength(candidate.questionResults);
        const currentResultCount = arrayLength(current.questionResults);
        if (candidateResultCount !== currentResultCount) return candidateResultCount > currentResultCount;
    }

    return true;
}

function mergeById<T extends { id: string } & (Exam | Attempt)>(localItems: T[], remoteItems: T[]): T[] {
    const merged = new Map<string, T>();

    for (const item of [...localItems, ...remoteItems]) {
        const current = merged.get(item.id);
        if (!current) {
            merged.set(item.id, item);
        } else if (shouldReplaceMergedItem(item, current)) {
            merged.set(item.id, mergeItemPayload(item, current));
        } else {
            merged.set(item.id, mergeItemPayload(current, item));
        }
    }

    return sortByNewestActivity([...merged.values()]);
}

export function mergeAttemptsForPersistence(localItems: Attempt[], remoteItems: Attempt[]): Attempt[] {
    return mergeById(localItems, remoteItems);
}

function hasBrowserStorage(): boolean {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readJson<T>(value: string | null, fallback: T): T {
    if (!value) return fallback;
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readJsonArray(value: string | null): unknown[] {
    const parsed = readJson<unknown>(value, []);
    return Array.isArray(parsed) ? parsed : [];
}

function sanitizeQuestions(value: unknown): Exam["questions"] {
    if (!Array.isArray(value)) return [];

    return value
        .filter(isRecord)
        .map((question, index) => {
            const id = numberValue(question.id);
            if (id === undefined) return null;
            const number = numberValue(question.number) || index + 1;
            return {
                ...question,
                id,
                number,
                answer: numberValue(question.answer),
                choices: question.choices === 4 || question.choices === 5 ? question.choices : undefined,
                score: numberValue(question.score),
            } as Exam["questions"][number];
        })
        .filter((question): question is Exam["questions"][number] => !!question);
}

export function sanitizeExamPayload(value: unknown): Exam | null {
    if (!isRecord(value)) return null;
    const id = stringValue(value.id);
    if (!id) return null;

    const questions = sanitizeQuestions(value.questions);
    return {
        ...(value as Partial<Exam>),
        id,
        title: stringValue(value.title) || "제목 없는 시험",
        createdAt: stringValue(value.createdAt) || new Date(0).toISOString(),
        updatedAt: stringValue(value.updatedAt),
        questions,
    };
}

function sanitizeAnswers(value: unknown): Record<number, number> {
    if (!isRecord(value)) return {};
    const answers: Record<number, number> = {};
    for (const [questionId, selected] of Object.entries(value)) {
        const numericQuestionId = Number(questionId);
        const numericSelected = numberValue(selected);
        if (Number.isFinite(numericQuestionId) && numericSelected !== undefined) {
            answers[numericQuestionId] = numericSelected;
        }
    }
    return answers;
}

export function sanitizeAttemptPayload(value: unknown): Attempt | null {
    if (!isRecord(value)) return null;
    const id = stringValue(value.id);
    const examId = stringValue(value.examId);
    if (!id || !examId) return null;

    const finishedAt = stringValue(value.finishedAt) || stringValue(value.startedAt) || new Date(0).toISOString();
    const startedAt = stringValue(value.startedAt) || finishedAt;
    const status = value.status === "in_progress" ? "in_progress" : "completed";
    const questionResults = Array.isArray(value.questionResults) ? value.questionResults : undefined;
    const questionTimings = Array.isArray(value.questionTimings) ? value.questionTimings : undefined;
    const questionDrawings = Array.isArray(value.questionDrawings) ? value.questionDrawings : undefined;

    return {
        ...(value as Partial<Attempt>),
        id,
        examId,
        examTitle: stringValue(value.examTitle) || "제목 없는 시험",
        studentName: stringValue(value.studentName) || "Student",
        startedAt,
        finishedAt,
        score: numberValue(value.score) || 0,
        totalScore: numberValue(value.totalScore) || 0,
        answers: sanitizeAnswers(value.answers),
        questionResults,
        questionTimings,
        questionDrawings,
        status,
    } as Attempt;
}

export function readLocalDeletedExamIds(): Record<string, string> {
    if (!hasBrowserStorage()) return {};
    return readJson<Record<string, string>>(localStorage.getItem(DELETED_EXAMS_KEY), {});
}

function writeLocalDeletedExamIds(index: Record<string, string>): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        const entries = Object.entries(index).filter(([id]) => !!id);
        if (entries.length === 0) {
            localStorage.removeItem(DELETED_EXAMS_KEY);
        } else {
            localStorage.setItem(DELETED_EXAMS_KEY, JSON.stringify(Object.fromEntries(entries)));
        }
        return true;
    } catch {
        return false;
    }
}

export function markLocalExamDeleted(id: string, deletedAt = new Date().toISOString()): boolean {
    if (!id) return false;
    const next = { ...readLocalDeletedExamIds(), [id]: deletedAt };
    return writeLocalDeletedExamIds(next);
}

export function clearLocalExamDeleted(id: string): boolean {
    const index = readLocalDeletedExamIds();
    if (!index[id]) return true;
    const next = { ...index };
    delete next[id];
    return writeLocalDeletedExamIds(next);
}

export function isExamLocallyDeleted(id: string): boolean {
    return !!readLocalDeletedExamIds()[id];
}

export function readLocalExam(id: string): Exam | null {
    if (!hasBrowserStorage()) return null;
    if (isExamLocallyDeleted(id)) return null;
    return sanitizeExamPayload(readJson<unknown>(localStorage.getItem(`${EXAM_PREFIX}${id}`), null));
}

export function readLocalExams(): Exam[] {
    if (!hasBrowserStorage()) return [];

    const deletedExamIds = readLocalDeletedExamIds();
    const exams: Exam[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(EXAM_PREFIX)) continue;
        const exam = sanitizeExamPayload(readJson<unknown>(localStorage.getItem(key), null));
        if (exam?.id && !deletedExamIds[exam.id]) exams.push(exam);
    }

    return sortByNewestActivity(exams);
}

function isStoredDataRef(value: unknown): value is StoredDataRef {
    return isRecord(value)
        && value.store === "indexeddb"
        && typeof value.key === "string"
        && value.key.trim().length > 0;
}

export function storedDataRefsForExamDeletion(
    exam: Exam | null | undefined,
    attempts: Attempt[],
    draftPayloads: unknown[] = [],
): StoredDataRef[] {
    const refs = new Map<string, StoredDataRef>();
    const addRef = (value: unknown) => {
        if (!isStoredDataRef(value)) return;
        refs.set(`${value.store}:${value.key}`, value);
    };

    addRef(exam?.pdfDataRef);
    addRef(exam?.answerKeyPdfRef);
    for (const question of exam?.questions || []) {
        addRef(question.imageAssetRef);
    }

    for (const attempt of attempts) {
        addRef(attempt.drawingsRef);
        addRef(attempt.handwriting?.strokesRef);
    }

    for (const draft of draftPayloads) {
        if (!isRecord(draft)) continue;
        addRef(draft.drawingsRef);
    }

    return Array.from(refs.values());
}

function isSolveDraftKeyForExam(key: string, examId: string): boolean {
    const baseKey = `${SOLVE_DRAFT_PREFIX}${examId}`;
    return key === baseKey || key.startsWith(`${baseKey}_`);
}

function readLocalSolveDraftPayloadsForExam(examId: string): unknown[] {
    if (!hasBrowserStorage()) return [];
    const payloads: unknown[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !isSolveDraftKeyForExam(key, examId)) continue;
        payloads.push(readJson<unknown>(localStorage.getItem(key), null));
    }
    return payloads;
}

function deleteLocalSolveDraftsForExam(examId: string): void {
    if (!hasBrowserStorage()) return;
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && isSolveDraftKeyForExam(key, examId)) keys.push(key);
    }
    keys.forEach(key => localStorage.removeItem(key));
}

async function deleteStoredDataRefs(refs: StoredDataRef[]): Promise<void> {
    await Promise.all(refs.map(ref => deleteStoredData(ref).catch(() => undefined)));
}

export function saveLocalExam(exam: Exam): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        clearLocalExamDeleted(exam.id);
        localStorage.setItem(`${EXAM_PREFIX}${exam.id}`, JSON.stringify(exam));
        return true;
    } catch {
        return false;
    }
}

export function deleteLocalExam(id: string): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        localStorage.removeItem(`${EXAM_PREFIX}${id}`);
        const attempts = readLocalAttempts().filter(attempt => attempt.examId !== id);
        localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));
        deleteLocalSolveDraftsForExam(id);
        markLocalExamDeleted(id);
        return true;
    } catch {
        return false;
    }
}

export function readLocalAttempts(): Attempt[] {
    if (!hasBrowserStorage()) return [];
    const deletedExamIds = readLocalDeletedExamIds();
    return sortByNewestActivity(
        readJsonArray(localStorage.getItem(ATTEMPTS_KEY))
            .map(sanitizeAttemptPayload)
            .filter((attempt): attempt is Attempt => !!attempt)
            .filter(attempt => !deletedExamIds[attempt.examId])
    );
}

export function saveLocalAttempt(attempt: Attempt): boolean {
    if (!hasBrowserStorage()) return false;
    try {
        const localAttempt = stripHeavyAttemptPayload(attempt);
        const attempts = readLocalAttempts();
        const next = attempts.filter(item => item.id !== attempt.id);
        next.push(localAttempt);
        localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(sortByNewestActivity(next)));
        return true;
    } catch {
        return false;
    }
}

/**
 * Persist a fully merged attempt set against whatever is currently on disk,
 * rather than overwriting the index with an in-memory snapshot. `loadAttempts`
 * reads local attempts once at the top, then awaits remote fetch + resync; any
 * attempt written during that window (e.g. the solve page autosaving, or a
 * concurrent submit) would be clobbered by a bare `setItem(mergedItems)`. Merging
 * against the freshly re-read store — newest activity wins per id — keeps those
 * in-flight writes instead of losing them during the flush.
 */
export function saveLocalAttemptsMerged(attempts: Attempt[]): Attempt[] {
    if (!hasBrowserStorage()) return attempts;
    try {
        const merged = mergeById(readLocalAttempts(), attempts);
        const stripped = merged.map(stripHeavyAttemptPayload);
        localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(sortByNewestActivity(stripped)));
        return merged;
    } catch {
        return attempts;
    }
}

async function getSupabaseClient(): Promise<SupabaseClientLike | null> {
    const config = getSupabaseConfig();
    if (!config) return null;
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = import("@supabase/supabase-js")
        .then((supabaseModule: unknown) => {
            const { createClient } = supabaseModule as {
                createClient: (url: string, key: string, options: unknown) => SupabaseClientLike;
            };

            return createClient(config.url, config.publishableKey, {
            auth: {
                persistSession: false,
                autoRefreshToken: false,
            },
            });
        })
        .catch(error => {
            console.warn("Supabase client unavailable", error);
            return null;
        });

    return supabaseClientPromise;
}

async function getAvailableSupabaseClient(): Promise<SupabaseClientLike | null> {
    const client = await getSupabaseClient();
    if (!client && isSupabaseConfigured()) {
        throw new Error("Supabase client unavailable");
    }
    return client;
}

async function upsertRemoteWorkspaceBootstrap(
    client: SupabaseClientLike,
    context: WorkspaceContext,
): Promise<void> {
    const rows = workspaceBootstrapRows(context);
    const organizationResult = await client.from("omr_organizations").upsert(rows.organization);
    if (organizationResult.error) {
        throw new Error(organizationResult.error.message || "Failed to bootstrap Supabase organization");
    }

    if (rows.userProfile) {
        const userResult = await client.from("omr_user_profiles").upsert(rows.userProfile);
        if (userResult.error) {
            throw new Error(userResult.error.message || "Failed to bootstrap Supabase user profile");
        }
    }

    if (rows.member) {
        const memberResult = await client.from("omr_organization_members").upsert(rows.member);
        if (memberResult.error) {
            throw new Error(memberResult.error.message || "Failed to bootstrap Supabase organization member");
        }
    }

    if (rows.teacherProfile) {
        const teacherResult = await client.from("omr_teacher_profiles").upsert(rows.teacherProfile);
        if (teacherResult.error) {
            throw new Error(teacherResult.error.message || "Failed to bootstrap Supabase teacher profile");
        }
    }
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (error && typeof error === "object" && "message" in error) {
        return String((error as { message?: unknown }).message || "Unknown Supabase error");
    }
    return "Unknown Supabase error";
}

export function itemsNeedingRemoteSync<T extends { id: string } & (Exam | Attempt)>(
    localItems: T[],
    remoteItems: T[],
): T[] {
    const remoteById = new Map(remoteItems.map(item => [item.id, item]));
    return localItems.filter(localItem => {
        const remoteItem = remoteById.get(localItem.id);
        return !remoteItem || getActivityTime(localItem) > getActivityTime(remoteItem);
    });
}

async function syncLocalItems<T extends { id: string } & (Exam | Attempt)>(
    items: T[],
    syncOne: (item: T) => Promise<void>,
): Promise<{ failedCount: number; error?: string }> {
    const failures: string[] = [];

    for (const item of items) {
        try {
            await syncOne(item);
        } catch (error) {
            failures.push(`${item.id}: ${errorMessage(error)}`);
        }
    }

    if (failures.length === 0) return { failedCount: 0 };
    return {
        failedCount: failures.length,
        error: `원격 재동기화 실패: ${failures.slice(0, 3).join("; ")}`,
    };
}

async function retryDeletedRemoteExams(deletedExamIds: string[]): Promise<{ failedCount: number; error?: string }> {
    if (deletedExamIds.length === 0 || !isSupabaseConfigured()) return { failedCount: 0 };

    const failures: string[] = [];
    for (const id of deletedExamIds) {
        try {
            await deleteRemoteExam(id);
            clearLocalExamDeleted(id);
        } catch (error) {
            failures.push(`${id}: ${errorMessage(error)}`);
        }
    }

    if (failures.length === 0) return { failedCount: 0 };
    return {
        failedCount: failures.length,
        error: `원격 삭제 재시도 실패: ${failures.slice(0, 3).join("; ")}`,
    };
}

async function fetchRemoteExam(id: string): Promise<Exam | null> {
    const client = await getAvailableSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
        .from("omr_exams")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) throw new Error(error.message || "Failed to load exam from Supabase");
    if (!data) return null;
    try {
        return examFromSupabaseRow(data as SupabaseExamRow);
    } catch {
        return null;
    }
}

async function fetchRemoteExams(): Promise<Exam[]> {
    const client = await getAvailableSupabaseClient();
    if (!client) return [];
    const context = activePersistenceContext();
    const query = client.from("omr_exams").select("*");
    const scopedQuery = shouldFilterRemoteByOrganization()
        ? query.eq("organization_id", context.organizationId)
        : query;

    const { data, error } = await scopedQuery.order("updated_at", { ascending: false });

    if (error) throw new Error(error.message || "Failed to load exams from Supabase");
    return (data || [])
        .map(row => {
            try {
                return examFromSupabaseRow(row as SupabaseExamRow);
            } catch {
                return null;
            }
        })
        .filter((exam): exam is Exam => !!exam);
}

async function fetchRemoteAttempts(): Promise<Attempt[]> {
    const client = await getAvailableSupabaseClient();
    if (!client) return [];
    const context = activePersistenceContext();
    const query = client.from("omr_attempts").select("*");
    const scopedQuery = shouldFilterRemoteByOrganization()
        ? query.eq("organization_id", context.organizationId)
        : query;

    const { data, error } = await scopedQuery.order("finished_at", { ascending: false });

    if (error) throw new Error(error.message || "Failed to load attempts from Supabase");
    return (data || [])
        .map(row => {
            try {
                return attemptFromSupabaseRow(row as SupabaseAttemptRow);
            } catch {
                return null;
            }
        })
        .filter((attempt): attempt is Attempt => !!attempt);
}

async function fetchRemoteAttempt(id: string): Promise<Attempt | null> {
    const client = await getAvailableSupabaseClient();
    if (!client) return null;

    const { data, error } = await client
        .from("omr_attempts")
        .select("*")
        .eq("id", id)
        .maybeSingle();

    if (error) throw new Error(error.message || "Failed to load attempt from Supabase");
    if (!data) return null;
    try {
        return attemptFromSupabaseRow(data as SupabaseAttemptRow);
    } catch {
        return null;
    }
}

/**
 * Fetch the freshest remote copy of an attempt, optionally constrained to an
 * organization. Teacher client paths (which have no server-action boundary yet)
 * use this to re-read before a merge-write, so a reply never clobbers a question
 * the student asked after this device cached the attempt, and never touches a
 * row outside the teacher's active workspace. Returns null when Supabase is
 * unavailable or the row is absent / out of the given org scope.
 */
export async function fetchRemoteAttemptScoped(
    id: string,
    options: { organizationId?: string } = {},
): Promise<Attempt | null> {
    const client = await getAvailableSupabaseClient();
    if (!client) return null;

    const org = options.organizationId?.trim();
    let query = client.from("omr_attempts").select("*").eq("id", id);
    if (org) query = query.eq("organization_id", org);
    const { data, error } = await query.maybeSingle();

    if (error) throw new Error(error.message || "Failed to load attempt from Supabase");
    if (!data) return null;
    try {
        return attemptFromSupabaseRow(data as SupabaseAttemptRow);
    } catch {
        return null;
    }
}

async function upsertRemoteExam(exam: Exam): Promise<void> {
    const client = await getAvailableSupabaseClient();
    if (!client) return;
    const context = activePersistenceContext();
    const scopedExam = examWithPersistenceContext(exam, context);
    await upsertRemoteWorkspaceBootstrap(client, context);

    const { error } = await client.from("omr_exams").upsert(examToSupabaseRow(scopedExam, context));
    if (error) throw new Error(error.message || "Failed to save exam to Supabase");

    await replaceRemoteExamQuestions(scopedExam, context);
}

async function replaceRemoteExamQuestions(exam: Exam, context = activePersistenceContext()): Promise<void> {
    const client = await getAvailableSupabaseClient();
    if (!client) return;

    const deleteResult = await client.from("omr_exam_questions").delete().eq("exam_id", exam.id);
    if (deleteResult.error) {
        throw new Error(deleteResult.error.message || "Failed to replace exam questions in Supabase");
    }

    const questionRows = examQuestionRowsForExam(exam, undefined, context);
    if (questionRows.length > 0) {
        const upsertResult = await client.from("omr_exam_questions").upsert(questionRows);
        if (upsertResult.error) {
            throw new Error(upsertResult.error.message || "Failed to save exam questions to Supabase");
        }
    }
}

async function upsertRemoteAttempt(attempt: Attempt): Promise<void> {
    const client = await getAvailableSupabaseClient();
    if (!client) return;
    const context = contextForAttempt(attempt);
    const scopedAttempt = attemptWithPersistenceContext(attempt, context);
    await upsertRemoteWorkspaceBootstrap(client, context);

    const { error } = await client.from("omr_attempts").upsert(attemptToSupabaseRow(scopedAttempt, context));
    if (error) throw new Error(error.message || "Failed to save attempt to Supabase");

    await upsertRemoteQuestionResults(scopedAttempt, context);
}

async function upsertRemoteQuestionResults(attempt: Attempt, context = contextForAttempt(attempt)): Promise<void> {
    const client = await getAvailableSupabaseClient();
    if (!client) return;
    const scopedAttempt = attemptWithPersistenceContext(attempt, context);

    const questionRows = questionResultRowsForAttempt(scopedAttempt, undefined, context);
    if (questionRows.length > 0) {
        const result = await client.from("omr_question_results").upsert(questionRows);
        if (result.error) {
            throw new Error(result.error.message || "Failed to save question results to Supabase");
        }
    }
}

async function syncQuestionResultsForAttempts(attempts: Attempt[]): Promise<{ failedCount: number; error?: string }> {
    const queue = attemptsWithQuestionResults(attempts);
    return syncLocalItems(queue, upsertRemoteQuestionResults);
}

async function deleteRemoteExam(id: string): Promise<void> {
    const client = await getAvailableSupabaseClient();
    if (!client) return;

    const questionResult = await client.from("omr_question_results").delete().eq("exam_id", id);
    if (questionResult.error) {
        throw new Error(questionResult.error.message || "Failed to delete exam question results from Supabase");
    }

    const examQuestionResult = await client.from("omr_exam_questions").delete().eq("exam_id", id);
    if (examQuestionResult.error) {
        throw new Error(examQuestionResult.error.message || "Failed to delete exam questions from Supabase");
    }

    const attemptResult = await client.from("omr_attempts").delete().eq("exam_id", id);
    if (attemptResult.error) {
        throw new Error(attemptResult.error.message || "Failed to delete exam attempts from Supabase");
    }

    const examResult = await client.from("omr_exams").delete().eq("id", id);
    if (examResult.error) {
        throw new Error(examResult.error.message || "Failed to delete exam from Supabase");
    }
}

function refreshLocalExamFromRemote(id: string): void {
    if (!isSupabaseConfigured()) return;
    void fetchRemoteExam(id)
        .then(remoteExam => {
            if (remoteExam && !isExamLocallyDeleted(remoteExam.id)) {
                saveLocalExam(remoteExam);
            }
        })
        .catch(error => console.warn("Failed to refresh remote exam", error));
}

function refreshLocalAttemptFromRemote(id: string): void {
    if (!isSupabaseConfigured()) return;
    void fetchRemoteAttempt(id)
        .then(remoteAttempt => {
            if (remoteAttempt && !isExamLocallyDeleted(remoteAttempt.examId)) {
                saveLocalAttempt(remoteAttempt);
            }
        })
        .catch(error => console.warn("Failed to refresh remote attempt", error));
}

export async function loadExam(id: string): Promise<Exam | null> {
    if (isExamLocallyDeleted(id)) {
        await retryDeletedRemoteExams([id]);
        return null;
    }

    const localExam = readLocalExam(id);
    if (localExam) {
        refreshLocalExamFromRemote(id);
        return localExam;
    }

    try {
        const remoteExam = await fetchRemoteExam(id);
        if (remoteExam) {
            saveLocalExam(remoteExam);
            return remoteExam;
        }
    } catch (error) {
        console.warn("Falling back to local exam", error);
    }
    return localExam;
}

export async function loadExams(): Promise<LoadResult<Exam>> {
    const localItems = readLocalExams();
    try {
        const deletedExamIds = readLocalDeletedExamIds();
        const deletedRetry = await retryDeletedRemoteExams(Object.keys(deletedExamIds));
        const remoteItems = (await fetchRemoteExams())
            .filter(exam => !deletedExamIds[exam.id]);
        const syncQueue = isSupabaseConfigured()
            ? itemsNeedingRemoteSync(localItems, remoteItems)
            : [];
        const syncResult = await syncLocalItems(syncQueue, upsertRemoteExam);
        for (const exam of remoteItems) saveLocalExam(exam);
        const remoteError = [deletedRetry.error, syncResult.error].filter(Boolean).join(" / ") || undefined;
        return {
            items: mergeById(localItems, remoteItems),
            remoteLoaded: isSupabaseConfigured(),
            remoteSynced: isSupabaseConfigured() ? !remoteError : undefined,
            pendingSyncCount: deletedRetry.failedCount + syncResult.failedCount,
            remoteError,
        };
    } catch (error) {
        return { items: localItems, remoteLoaded: false, remoteError: errorMessage(error) };
    }
}

export async function loadAttempts(): Promise<LoadResult<Attempt>> {
    const localItems = readLocalAttempts();
    try {
        const deletedExamIds = readLocalDeletedExamIds();
        const remoteItems = (await fetchRemoteAttempts())
            .filter(attempt => !deletedExamIds[attempt.examId]);
        const syncQueue = isSupabaseConfigured()
            ? itemsNeedingRemoteSync(localItems, remoteItems)
            : [];
        const syncResult = await syncLocalItems(syncQueue, upsertRemoteAttempt);
        const mergedItems = mergeById(localItems, remoteItems);
        // Storage-merge against the current store so attempts written while the
        // remote fetch/resync above was in flight are not clobbered by this persist.
        const persistedItems = saveLocalAttemptsMerged(mergedItems);
        const questionResultSync = isSupabaseConfigured()
            ? await syncQuestionResultsForAttempts(mergedItems)
            : { failedCount: 0 };
        const remoteError = [syncResult.error, questionResultSync.error].filter(Boolean).join(" / ") || undefined;
        return {
            items: persistedItems,
            remoteLoaded: isSupabaseConfigured(),
            remoteSynced: isSupabaseConfigured() ? !remoteError : undefined,
            pendingSyncCount: syncResult.failedCount + questionResultSync.failedCount,
            remoteError,
        };
    } catch (error) {
        return { items: localItems, remoteLoaded: false, remoteError: errorMessage(error) };
    }
}

export async function loadAttempt(id: string): Promise<Attempt | null> {
    const localAttempt = readLocalAttempts().find(attempt => attempt.id === id) || null;
    if (localAttempt?.examId && isExamLocallyDeleted(localAttempt.examId)) return null;
    if (localAttempt) {
        refreshLocalAttemptFromRemote(id);
        return localAttempt;
    }

    try {
        const remoteAttempt = await fetchRemoteAttempt(id);
        if (remoteAttempt && !isExamLocallyDeleted(remoteAttempt.examId)) {
            saveLocalAttempt(remoteAttempt);
            return remoteAttempt;
        }
    } catch (error) {
        console.warn("Falling back to local attempt", error);
    }
    return localAttempt;
}

export async function saveExam(exam: Exam): Promise<PersistenceResult> {
    const context = activePersistenceContext();
    const scopedExam = examWithPersistenceContext(exam, context);
    const localSaved = saveLocalExam(scopedExam);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteExam(scopedExam);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function saveAttempt(attempt: Attempt): Promise<PersistenceResult> {
    const context = contextForAttempt(attempt);
    const scopedAttempt = attemptWithPersistenceContext(attempt, context);
    const localSaved = saveLocalAttempt(scopedAttempt);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await upsertRemoteAttempt(scopedAttempt);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}

export async function deleteExam(id: string): Promise<PersistenceResult> {
    const localExam = readLocalExam(id);
    const localAttempts = readLocalAttempts().filter(attempt => attempt.examId === id);
    const localDraftPayloads = readLocalSolveDraftPayloadsForExam(id);
    const refsToDelete = storedDataRefsForExamDeletion(localExam, localAttempts, localDraftPayloads);
    const localSaved = deleteLocalExam(id);
    if (localSaved) await deleteStoredDataRefs(refsToDelete);
    if (!isSupabaseConfigured()) return { localSaved, remoteSaved: false };

    try {
        await deleteRemoteExam(id);
        clearLocalExamDeleted(id);
        return { localSaved, remoteSaved: true };
    } catch (error) {
        return { localSaved, remoteSaved: false, remoteError: errorMessage(error) };
    }
}
