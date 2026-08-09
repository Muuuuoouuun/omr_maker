import {
    studentAttemptRecordFromAttempt,
    studentAttemptReviewExamFromExam,
    type StudentAttemptDetailResult,
    type StudentAttemptListResult,
    type StudentAttemptReviewExam,
    type StudentTrustedOfficialReview,
} from "@/lib/studentAttemptHistoryContract";
import type { StudentServerSession } from "@/lib/studentServerSession";
import {
    attemptFromSupabaseRow,
    examFromSupabaseRow,
    type SupabaseAttemptRow,
    type SupabaseExamRow,
} from "@/lib/omrPersistence";
import { SUPABASE_ATTEMPT_LIST_READ_COLUMNS, SUPABASE_ATTEMPT_READ_COLUMNS } from "@/lib/supabaseReadColumns";
import { attemptFromSupabaseListRow } from "@/lib/supabaseListProjection";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_OPERATIONS_LIMITS,
} from "@/lib/initialOperationsPolicy";
import { questionWeight, type Attempt, type Exam, type QuestionResult } from "@/types/omr";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import {
    attestCanonicalQuestionResultEvidence,
    buildCanonicalExamDefinitionManifest,
} from "@/lib/canonicalQuestionResultManifest";
import {
    buildLearningRecommendations,
    buildStudentWeaknessGroups,
    resolveAttemptGrading,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";

interface StudentAttemptReadResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface StudentAttemptReadQuery {
    eq(column: string, value: string): StudentAttemptReadQuery;
    gt(column: string, value: string): StudentAttemptReadQuery;
    order(column: string, options: { ascending: boolean }): StudentAttemptReadQuery;
    limit(value: number): PromiseLike<StudentAttemptReadResult<unknown[]>>;
    maybeSingle(): PromiseLike<StudentAttemptReadResult<unknown>>;
}

export interface StudentAttemptReadGatewayClient {
    from(table: "omr_attempts" | "omr_exams"): {
        select(columns: string): StudentAttemptReadQuery;
    };
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function attemptMatchesSession(attempt: Attempt, session: StudentServerSession): boolean {
    if (
        clean(attempt.organizationId) !== clean(session.organizationId)
        || clean(attempt.studentProfileId) !== clean(session.studentId)
        || clean(attempt.studentId) !== clean(session.studentId)
        || attempt.status !== "completed"
    ) {
        return false;
    }
    const questionIds = new Set<number>();
    return Array.isArray(attempt.questionResults) && attempt.questionResults.every(result => {
        if (
            clean(result.attemptId) !== clean(attempt.id)
            || clean(result.examId) !== clean(attempt.examId)
            || clean(result.studentId) !== clean(session.studentId)
            || questionIds.has(result.questionId)
        ) {
            return false;
        }
        questionIds.add(result.questionId);
        return true;
    });
}

function parseScopedAttempt(row: unknown, session: StudentServerSession, listProjection = false): Attempt | null {
    try {
        const attempt = listProjection
            ? attemptFromSupabaseListRow(row, attestCanonicalQuestionResultEvidence)
            : attemptFromSupabaseRow(row as SupabaseAttemptRow, attestCanonicalQuestionResultEvidence);
        return attemptMatchesSession(attempt, session) ? attempt : null;
    } catch {
        return null;
    }
}

function fallbackReviewExam(attempt: Attempt): StudentAttemptReviewExam {
    return {
        id: attempt.examId,
        title: attempt.examTitle,
        createdAt: attempt.startedAt,
        questions: (attempt.questionResults || []).map(result => ({
            id: result.questionId,
            number: result.questionNumber,
            choices: Math.max(result.selectedAnswer || 0, result.correctAnswer || 0) > 4 ? 5 : 4,
            ...(typeof result.correctAnswer === "number" ? { answer: result.correctAnswer } : {}),
            score: result.score,
            ...(result.label ? { label: result.label } : {}),
            ...((result.subject || result.unit || result.concept || result.skill || result.source
                || result.difficulty || result.cognitiveLevel || result.mistakeTypes || result.prerequisites
                || typeof result.expectedTimeSec === "number") ? {
                    tags: {
                        ...(result.subject ? { subject: result.subject } : {}),
                        ...(result.unit ? { unit: result.unit } : {}),
                        ...(result.concept ? { concept: result.concept } : {}),
                        ...(result.skill ? { skill: result.skill } : {}),
                        ...(result.source ? { source: result.source } : {}),
                        ...(result.difficulty ? { difficulty: result.difficulty } : {}),
                        ...(result.cognitiveLevel ? { cognitiveLevel: result.cognitiveLevel } : {}),
                        ...(result.mistakeTypes ? { mistakeTypes: [...result.mistakeTypes] } : {}),
                        ...(result.prerequisites ? { prerequisites: [...result.prerequisites] } : {}),
                        ...(typeof result.expectedTimeSec === "number" ? { expectedTimeSec: result.expectedTimeSec } : {}),
                    },
                } : {}),
            ...(result.pdfLocation ? { pdfLocation: result.pdfLocation } : {}),
            ...(result.pdfRegion ? { pdfRegion: result.pdfRegion } : {}),
            ...(result.passagePdfRegions ? { passagePdfRegions: result.passagePdfRegions } : {}),
        })),
    };
}

function sameOptionalString(left: unknown, right: unknown): boolean {
    return (typeof left === "string" && left.trim() ? left : undefined)
        === (typeof right === "string" && right.trim() ? right : undefined);
}

function samePdfLocation(
    left: Exam["questions"][number]["pdfLocation"],
    right: QuestionResult["pdfLocation"],
): boolean {
    if (!left || !right) return left === right;
    return left.page === right.page && left.x === right.x && left.y === right.y;
}

function samePdfRegion(
    left: Exam["questions"][number]["pdfRegion"],
    right: QuestionResult["pdfRegion"],
): boolean {
    if (!left || !right) return left === right;
    return left.page === right.page && left.x === right.x && left.y === right.y
        && left.width === right.width && left.height === right.height;
}

function samePassagePdfRegions(
    left: Exam["questions"][number]["passagePdfRegions"],
    right: QuestionResult["passagePdfRegions"],
): boolean {
    const leftRegions = left || [];
    const rightRegions = right || [];
    return leftRegions.length === rightRegions.length
        && leftRegions.every((region, index) => samePdfRegion(region, rightRegions[index]));
}

function exactCurrentQuestionMatchesSubmitted(
    current: Exam["questions"][number],
    result: QuestionResult,
    totalQuestions: number,
): boolean {
    const submittedChoiceCount = Math.max(result.selectedAnswer || 0, result.correctAnswer || 0) > 4 ? 5 : 4;
    return current.id === result.questionId
        && current.number === result.questionNumber
        && (current.choices ?? submittedChoiceCount) === submittedChoiceCount
        && current.answer === result.correctAnswer
        && questionWeight(current, totalQuestions) === result.score
        && sameOptionalString(current.label, result.label)
        && sameOptionalString(current.tags?.subject, result.subject)
        && sameOptionalString(current.tags?.unit, result.unit)
        && sameOptionalString(current.tags?.concept, result.concept)
        && sameOptionalString(current.tags?.skill, result.skill)
        && sameOptionalString(current.tags?.source, result.source)
        && sameOptionalString(current.tags?.difficulty, result.difficulty)
        && sameOptionalString(current.tags?.cognitiveLevel, result.cognitiveLevel)
        && JSON.stringify(current.tags?.mistakeTypes || []) === JSON.stringify(result.mistakeTypes || [])
        && JSON.stringify(current.tags?.prerequisites || []) === JSON.stringify(result.prerequisites || [])
        && (current.tags?.expectedTimeSec ?? undefined) === (result.expectedTimeSec ?? undefined)
        && samePdfLocation(current.pdfLocation, result.pdfLocation)
        && samePdfRegion(current.pdfRegion, result.pdfRegion)
        && samePassagePdfRegions(current.passagePdfRegions, result.passagePdfRegions);
}

function ownedRemoteHandwritingRef(attempt: Attempt, session: StudentServerSession) {
    const candidate = attempt.handwriting?.strokesRef || attempt.drawingsRef;
    if (
        !isRemoteAssetStoredDataRef(candidate)
        || candidate.kind !== "attempt_handwriting"
        || candidate.organizationId !== session.organizationId
        || candidate.attemptId !== attempt.id
    ) return undefined;
    return candidate;
}

export async function listStudentAttemptsWithGateway(
    client: StudentAttemptReadGatewayClient,
    session: StudentServerSession,
): Promise<StudentAttemptListResult> {
    const rows: unknown[] = [];
    const ceiling = INITIAL_OPERATIONS_LIMITS.studentAttempts;
    const pageSize = INITIAL_OPERATIONS_LIMITS.listPageSize;
    let cursorId = "";
    while (rows.length <= ceiling) {
        const requestSize = Math.min(pageSize, (ceiling + 1) - rows.length);
        let query = client
            .from("omr_attempts")
            .select(SUPABASE_ATTEMPT_LIST_READ_COLUMNS)
            .eq("organization_id", session.organizationId)
            .eq("student_profile_id", session.studentId)
            .eq("student_id", session.studentId)
            .eq("status", "completed");
        if (cursorId) query = query.gt("id", cursorId);
        const result = await query
            .order("id", { ascending: true })
            .limit(requestSize);
        if (result.error) return { status: "service_unavailable", error: result.error.message };
        const page = result.data || [];
        if (page.length === 0) break;
        const pageIds = page.map(row => {
            const record = row as { id?: unknown; payload?: { id?: unknown } };
            return clean(record.id) || clean(record.payload?.id);
        });
        if (
            pageIds.some(id => !id || (cursorId && id <= cursorId))
            || pageIds.some((id, index) => index > 0 && id <= pageIds[index - 1])
        ) {
            return { status: "service_unavailable", error: "Invalid canonical attempt pagination" };
        }
        rows.push(...page);
        if (rows.length > ceiling) {
            return { status: "service_unavailable", error: INITIAL_CAPACITY_EXCEEDED_ERROR };
        }
        cursorId = pageIds[pageIds.length - 1];
        if (page.length < requestSize) break;
    }

    const attempts = [];
    for (const row of rows) {
        const attempt = parseScopedAttempt(row, session, true);
        const safeAttempt = attempt ? studentAttemptRecordFromAttempt(attempt) : null;
        if (!safeAttempt) {
            return { status: "service_unavailable", error: "Invalid scoped student attempt" };
        }
        attempts.push(safeAttempt);
    }
    attempts.sort((left, right) => {
        const byFinishedAt = Date.parse(right.finishedAt) - Date.parse(left.finishedAt);
        return byFinishedAt || left.id.localeCompare(right.id);
    });
    return { status: "loaded", attempts };
}

export async function loadStudentAttemptWithGateway(
    client: StudentAttemptReadGatewayClient,
    attemptId: string,
    session: StudentServerSession,
): Promise<StudentAttemptDetailResult> {
    const normalizedAttemptId = clean(attemptId);
    if (!normalizedAttemptId) return { status: "not_found" };
    const attemptResult = await client
        .from("omr_attempts")
        .select(SUPABASE_ATTEMPT_READ_COLUMNS)
        .eq("organization_id", session.organizationId)
        .eq("student_profile_id", session.studentId)
        .eq("student_id", session.studentId)
        .eq("status", "completed")
        .eq("id", normalizedAttemptId)
        .maybeSingle();
    if (attemptResult.error) return { status: "service_unavailable", error: attemptResult.error.message };
    if (!attemptResult.data) return { status: "not_found" };

    const attempt = parseScopedAttempt(attemptResult.data, session);
    const safeAttempt = attempt ? studentAttemptRecordFromAttempt(attempt, {
        includeCanonicalEvidence: true,
    }) : null;
    if (!attempt || !safeAttempt) {
        return { status: "service_unavailable", error: "Invalid scoped student attempt" };
    }

    const examResult = await client
        .from("omr_exams")
        .select("id, organization_id, payload")
        .eq("organization_id", session.organizationId)
        .eq("id", attempt.examId)
        .maybeSingle();
    if (examResult.error) return { status: "service_unavailable", error: examResult.error.message };

    let reviewExam = fallbackReviewExam(attempt);
    let trustedReview: StudentTrustedOfficialReview | undefined;
    let retakeEligibleQuestionIds: number[] | undefined;
    if (examResult.data) {
        try {
            const exam = examFromSupabaseRow(examResult.data as SupabaseExamRow);
            if (clean(exam.organizationId) !== clean(session.organizationId) || clean(exam.id) !== clean(attempt.examId)) {
                return { status: "service_unavailable", error: "Invalid scoped review exam" };
            }
            const currentReviewExam = studentAttemptReviewExamFromExam(exam);
            const currentDefinition = buildCanonicalExamDefinitionManifest(exam).questionResultsDefinitionManifestHash;
            if (attempt.questionResultsDefinitionManifestHash === currentDefinition) {
                retakeEligibleQuestionIds = safeAttempt.questionResults
                    .filter(result => result.status === "wrong" || result.status === "unanswered")
                    .map(result => result.questionId)
                    .sort((left, right) => left - right);
            }
            const currentQuestionById = new Map(currentReviewExam.questions.map(question => [question.id, question]));
            const currentRawQuestionById = new Map(exam.questions.map(question => [question.id, question]));
            const submittedReviewExam = fallbackReviewExam(attempt);
            const submittedQuestionById = new Map(submittedReviewExam.questions.map(question => [question.id, question]));
            reviewExam = {
                ...currentReviewExam,
                questions: safeAttempt.questionResults.map(result => {
                    const current = currentQuestionById.get(result.questionId);
                    const currentRaw = currentRawQuestionById.get(result.questionId);
                    const submitted = submittedQuestionById.get(result.questionId)!;
                    return {
                        ...submitted,
                        id: submitted.id,
                        number: submitted.number,
                        ...(current?.explanation && currentRaw && exactCurrentQuestionMatchesSubmitted(
                            currentRaw,
                            attempt.questionResults!.find(row => row.questionId === result.questionId)!,
                            exam.questions.length,
                        ) ? { explanation: current.explanation } : {}),
                        ...(typeof result.correctAnswer === "number"
                            ? { answer: result.correctAnswer }
                            : {}),
                    };
                }),
            };
        } catch {
            return { status: "service_unavailable", error: "Invalid canonical review exam" };
        }
    }

    const reviewAnalyticsExam: Exam = {
        id: reviewExam.id,
        title: reviewExam.title,
        createdAt: reviewExam.createdAt,
        questions: reviewExam.questions.map(question => ({ ...question })),
    };
    const gradingResolution = resolveAttemptGrading(reviewAnalyticsExam, attempt);
    if (gradingResolution.source === "canonical_submission") {
        trustedReview = {
            gradingSource: "canonical_submission",
            questions: reviewExam.questions.map(question => ({ ...question })),
            questionResults: safeAttempt.questionResults.map(result => ({ ...result })),
            scoreSummary: { ...gradingResolution.scoreSummary },
            weaknessGroups: buildStudentWeaknessGroups(reviewAnalyticsExam, attempt).slice(0, 3),
            recommendations: buildLearningRecommendations(reviewAnalyticsExam, [attempt], {
                scope: "attempt",
                attempt,
                includeSlowCorrect: true,
                limit: 5,
            }),
            behavior: summarizeAttemptBehavior(attempt),
        };
    }

    const handwritingRef = ownedRemoteHandwritingRef(attempt, session);
    return {
        status: "loaded",
        detail: {
            attempt: safeAttempt,
            exam: reviewExam,
            ...(handwritingRef ? { handwritingRef } : {}),
            ...(retakeEligibleQuestionIds?.length ? { retakeEligibleQuestionIds } : {}),
            ...(trustedReview ? { trustedReview } : {}),
        },
    };
}
