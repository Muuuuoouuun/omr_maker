import type {
    Attempt,
    AttemptHandwriting,
    Exam,
    FocusLossEvent,
    PdfDrawings,
    Question,
    QuestionDrawingSummary,
    QuestionTiming,
    RetakeMetadata,
    StoredDataRef,
    StoredPlanKey,
} from "@/types/omr";
import { gradeAttempt } from "@/types/omr";
import { buildQuestionResults } from "@/lib/premiumAnalytics";
import type { ExamAccessSession } from "@/lib/examAccess";
import type { StudentServerIdentity } from "@/lib/studentServerSession";

export interface SubmitAttemptInput {
    examId: string;
    /** Stable per draft so network retries resolve to one server attempt. */
    submissionId: string;
    answers: Record<number, number>;
    startedAt: string;
    autoSubmitted?: boolean;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    tabFociLostCount?: number;
    drawingsRef?: StoredDataRef;
    drawingPageCount?: number;
    drawingStrokeCount?: number;
    /**
     * Client-trusted, non-grading metadata. `retake` narrows the graded question
     * scope (validated against the exam); handwriting fields ride along for the
     * teacher review views. None of these influence score computation inputs.
     */
    retake?: RetakeMetadata;
    drawings?: PdfDrawings;
    handwriting?: AttemptHandwriting;
    handwritingArchived?: boolean;
    handwritingPlan?: StoredPlanKey;
    questionDrawings?: QuestionDrawingSummary[];
}

const RETAKE_MODES: RetakeMetadata["mode"][] = ["wrong", "similar", "custom"];

/**
 * Validate a client-supplied retake scope against the trusted exam and decide
 * the graded question set. A partial scope narrows grading to the scoped ids
 * (grading the full list would count unscoped questions as unanswered). A
 * full-scope retake ("전체" button) grades every question — but the retake
 * metadata is STILL preserved so the attempt is classified as a retake and
 * never double-counted as a base attempt. Only a scope with no resolvable
 * question ids falls through to a plain base attempt.
 */
export function resolveRetakeScope(
    exam: Exam,
    retake: RetakeMetadata | undefined,
): { questions: Question[]; retake?: RetakeMetadata } {
    if (!retake) return { questions: exam.questions };
    const examIds = new Set(exam.questions.map(q => q.id));
    const validIds = [...new Set(retake.questionIds)].filter(id => examIds.has(id));
    if (validIds.length === 0) return { questions: exam.questions };
    const isFullScope = validIds.length >= exam.questions.length;
    return {
        questions: isFullScope ? exam.questions : exam.questions.filter(q => validIds.includes(q.id)),
        retake: {
            ...retake,
            questionIds: validIds,
            mode: RETAKE_MODES.includes(retake.mode) ? retake.mode : "custom",
        },
    };
}

/** Canonical owner id written to omr_attempts.student_id. Guests use the guest:<id> convention. */
export function ownerStudentId(identity: StudentServerIdentity): string {
    if (identity.kind === "guest") return `guest:${identity.guestId}`;
    return identity.studentId || "";
}

export function attemptOwnedBy(
    attempt: Pick<Attempt, "studentId" | "guestId">,
    identity: StudentServerIdentity,
): boolean {
    if (identity.kind === "guest") return !!identity.guestId && attempt.guestId === identity.guestId;
    return !!identity.studentId && attempt.studentId === identity.studentId;
}

export function identityAccessSession(identity: StudentServerIdentity): ExamAccessSession {
    return {
        groupId: identity.groupId,
        groupName: identity.groupName,
        isGuest: identity.kind === "guest",
        identityType: identity.identityType,
    };
}

/**
 * Remaining seconds for a student's countdown, never exceeding the schedule
 * window. A student who opens the exam N minutes before endAt must not get a
 * full-duration timer that would run past the window and strand their answers.
 * Returns the duration unchanged when the exam has no endAt.
 */
export function remainingSecondsWithinWindow(
    durationSeconds: number,
    endAt: string | undefined,
    now: number = Date.now(),
): number {
    const safeDuration = Number.isFinite(durationSeconds) ? Math.max(0, Math.floor(durationSeconds)) : 0;
    const endAtMs = endAt ? Date.parse(endAt) : NaN;
    if (!Number.isFinite(endAtMs)) return safeDuration;
    const untilEnd = Math.floor((endAtMs - now) / 1000);
    return Math.max(0, Math.min(safeDuration, untilEnd));
}

/** Clamp a client-supplied startedAt into a sane window ending at the server finish time. */
function clampStartedAt(startedAtInput: string, finishedAtIso: string, exam: Exam): string {
    const finishedMs = Date.parse(finishedAtIso);
    const startedMs = Date.parse(startedAtInput);
    if (!Number.isFinite(finishedMs)) return finishedAtIso;
    if (!Number.isFinite(startedMs) || startedMs > finishedMs) return finishedAtIso;
    const windowMs = ((exam.durationMin ?? 50) + 5) * 60 * 1000; // exam duration + 5min grace
    const floorMs = finishedMs - windowMs;
    return startedMs < floorMs ? new Date(floorMs).toISOString() : startedAtInput;
}

/**
 * Build a fully server-authoritative attempt: score, totalScore, questionResults are
 * computed here from the trusted exam; owner/org/identity come from the signed cookie.
 * Client-supplied score is never read.
 */
export function buildServerAttempt(
    input: SubmitAttemptInput,
    exam: Exam,
    identity: StudentServerIdentity,
    attemptId: string,
    finishedAtIso: string,
): Attempt {
    const scope = resolveRetakeScope(exam, input.retake);
    const graded = gradeAttempt(scope.questions, input.answers);
    const attempt: Attempt = {
        id: attemptId,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: exam.organizationId,
        studentName: identity.name,
        studentId: ownerStudentId(identity),
        guestId: identity.kind === "guest" ? identity.guestId : undefined,
        groupId: identity.groupId,
        groupName: identity.groupName,
        regionId: identity.regionId,
        regionName: identity.regionName,
        identityType: identity.identityType,
        startedAt: clampStartedAt(input.startedAt, finishedAtIso, exam),
        finishedAt: finishedAtIso,
        score: graded.earnedScore,
        totalScore: graded.totalScore,
        answers: input.answers,
        status: "completed",
        autoSubmitted: input.autoSubmitted,
        tabFociLostCount: input.tabFociLostCount,
        questionTimings: input.questionTimings,
        focusLossEvents: input.focusLossEvents,
        drawings: input.drawings,
        drawingsRef: input.drawingsRef,
        handwriting: input.handwriting,
        handwritingArchived: input.handwritingArchived,
        handwritingPlan: input.handwritingPlan,
        drawingPageCount: input.drawingPageCount,
        drawingStrokeCount: input.drawingStrokeCount,
        questionDrawings: input.questionDrawings,
        retake: scope.retake,
    };
    attempt.questionResults = buildQuestionResults({ ...exam, questions: scope.questions }, attempt);
    return attempt;
}
