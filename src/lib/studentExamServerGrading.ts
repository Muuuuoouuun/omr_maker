import type { Attempt, Exam, StoredPlanKey } from "@/types/omr";
import { gradeAttempt } from "@/types/omr";
import { buildCanonicalQuestionResultEvidence } from "@/lib/canonicalQuestionResultManifest";
import { buildQuestionResults } from "@/lib/questionResultBuilder";
import {
    ownerStudentId,
    resolveRetakeScope,
    type SubmitAttemptInput,
} from "@/lib/studentExamCore";
import type { StudentServerIdentity } from "@/lib/studentServerSession";
import {
    findMissingRequiredSubQuestions,
    sanitizeSubQuestionAnswersForQuestions,
} from "@/lib/subQuestions";

function clampStartedAt(startedAtInput: string, finishedAtIso: string, exam: Exam): string {
    const finishedMs = Date.parse(finishedAtIso);
    const startedMs = Date.parse(startedAtInput);
    if (!Number.isFinite(finishedMs)) return finishedAtIso;
    if (!Number.isFinite(startedMs) || startedMs > finishedMs) return finishedAtIso;
    const windowMs = ((exam.durationMin ?? 50) + 5) * 60 * 1000;
    const floorMs = finishedMs - windowMs;
    return startedMs < floorMs ? new Date(floorMs).toISOString() : startedAtInput;
}

/** Server-only grading boundary; never import this module from a client component. */
export function buildServerAttempt(
    input: SubmitAttemptInput,
    exam: Exam,
    identity: StudentServerIdentity,
    attemptId: string,
    finishedAtIso: string,
    premium: { handwritingArchive?: boolean; handwritingPlan?: StoredPlanKey } = {},
    assignmentGeneration: Pick<Attempt, "assignmentId" | "assignmentRevision"> = {},
): Attempt {
    const assignmentId = assignmentGeneration.assignmentId?.trim();
    const assignmentRevision = assignmentGeneration.assignmentRevision;
    if (assignmentId
        ? !Number.isSafeInteger(assignmentRevision) || Number(assignmentRevision) <= 0
        : assignmentRevision !== undefined
    ) {
        throw new Error("INVALID_ASSIGNMENT_GENERATION");
    }
    const scope = resolveRetakeScope(exam, input.retake);
    const graded = gradeAttempt(scope.questions, input.answers);
    const subQuestionAnswers = sanitizeSubQuestionAnswersForQuestions(scope.questions, input.subQuestionAnswers, finishedAtIso);
    const missingRequiredSubQuestions = findMissingRequiredSubQuestions(scope.questions, subQuestionAnswers);
    if (!input.autoSubmitted && missingRequiredSubQuestions.length > 0) {
        throw new Error("REQUIRED_SUB_QUESTIONS_MISSING");
    }
    const attempt: Attempt = {
        id: attemptId,
        examId: exam.id,
        examTitle: exam.title,
        organizationId: exam.organizationId,
        ...(assignmentId ? { assignmentId, assignmentRevision } : {}),
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
        subQuestionAnswers: Object.keys(subQuestionAnswers).length > 0 ? subQuestionAnswers : undefined,
        missingRequiredSubQuestions: input.autoSubmitted && missingRequiredSubQuestions.length > 0
            ? missingRequiredSubQuestions
            : undefined,
        status: "completed",
        autoSubmitted: input.autoSubmitted,
        tabFociLostCount: input.tabFociLostCount,
        questionTimings: input.questionTimings,
        focusLossEvents: input.focusLossEvents,
        drawings: premium.handwritingArchive ? input.drawings : undefined,
        drawingsRef: premium.handwritingArchive ? input.drawingsRef : undefined,
        handwriting: premium.handwritingArchive ? input.handwriting : undefined,
        handwritingArchived: !!premium.handwritingArchive && !!(input.drawingsRef || input.drawings),
        handwritingPlan: premium.handwritingArchive ? premium.handwritingPlan : "free",
        drawingPageCount: premium.handwritingArchive ? input.drawingPageCount : undefined,
        drawingStrokeCount: premium.handwritingArchive ? input.drawingStrokeCount : undefined,
        questionDrawings: premium.handwritingArchive ? input.questionDrawings : undefined,
        retake: scope.retake,
    };
    attempt.questionResults = buildQuestionResults({ ...exam, questions: scope.questions }, attempt);
    Object.assign(attempt, buildCanonicalQuestionResultEvidence(attempt, attempt.questionResults));
    return attempt;
}
