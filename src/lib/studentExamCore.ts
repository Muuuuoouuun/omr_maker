import type { Attempt, Exam, FocusLossEvent, QuestionTiming, StoredDataRef } from "@/types/omr";
import { gradeAttempt } from "@/types/omr";
import { buildQuestionResults } from "@/lib/premiumAnalytics";
import type { ExamAccessSession } from "@/lib/examAccess";
import type { StudentServerIdentity } from "@/lib/studentServerSession";

export interface SubmitAttemptInput {
    examId: string;
    answers: Record<number, number>;
    startedAt: string;
    autoSubmitted?: boolean;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    tabFociLostCount?: number;
    drawingsRef?: StoredDataRef;
    drawingPageCount?: number;
    drawingStrokeCount?: number;
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
    const graded = gradeAttempt(exam.questions, input.answers);
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
        drawingsRef: input.drawingsRef,
        drawingPageCount: input.drawingPageCount,
        drawingStrokeCount: input.drawingStrokeCount,
    };
    attempt.questionResults = buildQuestionResults(exam, attempt);
    return attempt;
}
