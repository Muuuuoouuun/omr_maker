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
    SubQuestionAnswers,
} from "@/types/omr";
import type { ExamAccessSession } from "@/lib/examAccess";
import type { StudentServerIdentity } from "@/lib/studentServerSession";

export interface SubmitAttemptInput {
    examId: string;
    /** Stable per draft so network retries resolve to one server attempt. */
    submissionId: string;
    answers: Record<number, number>;
    subQuestionAnswers?: SubQuestionAnswers;
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

/**
 * Only a real stroke payload/reference needs the server-owned plan lookup.
 * Empty handwriting summaries are useful client UI state, but cannot produce
 * an archive and should not add a database round trip to every submission.
 */
export function hasArchiveableHandwriting(input: SubmitAttemptInput): boolean {
    if (input.drawingsRef || input.handwriting?.strokesRef) return true;
    return Object.values(input.drawings || {}).some(paths => Array.isArray(paths) && paths.length > 0);
}

/**
 * The idempotency read and canonical-exam read are independent. Start both in
 * the first database round; a retry can return as soon as its stored attempt is
 * found, while a new submission awaits the already-running exam read.
 */
export async function loadSubmissionBaseInParallel<TAttempt, TExam>(
    loadExistingAttempt: () => Promise<TAttempt | null>,
    loadExamRow: () => Promise<TExam | null>,
): Promise<{ existingAttempt: TAttempt | null; examRow: TExam | null }> {
    const existingAttemptPromise = loadExistingAttempt();
    const examRowPromise = loadExamRow();
    // A retry does not consume this speculative read. Observe a possible
    // rejection so returning early cannot create an unhandled promise.
    void examRowPromise.catch(() => undefined);
    const existingAttempt = await existingAttemptPromise;
    if (existingAttempt) return { existingAttempt, examRow: null };
    return { existingAttempt: null, examRow: await examRowPromise };
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
