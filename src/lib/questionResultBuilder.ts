import { questionWeight, type Attempt, type Exam, type Question, type QuestionResult, type QuestionResultStatus } from "@/types/omr";
import { canonicalQuestionIdFor } from "@/lib/questionBank";

function roundScore(value: number): number {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}

function isAnswered(selected: number | undefined): selected is number {
    return selected !== undefined && selected !== null && selected !== 0;
}

function resolveQuestionStatus(question: Question, selectedAnswer: number | undefined): QuestionResultStatus {
    if (question.answer === undefined || question.answer === null) return "ungraded";
    if (!isAnswered(selectedAnswer)) return "unanswered";
    return selectedAnswer === question.answer ? "correct" : "wrong";
}

export function getEffectiveExamQuestionsForAttempt(exam: Exam, attempt: Pick<Attempt, "retake">): Question[] {
    const retakeQuestionIds = attempt.retake?.questionIds;
    if (!retakeQuestionIds?.length) return exam.questions;
    const activeIds = new Set(retakeQuestionIds);
    const activeQuestions = exam.questions.filter(question => activeIds.has(question.id));
    return activeQuestions.length > 0 ? activeQuestions : exam.questions;
}

/** Client-safe immutable-row projection; canonical sealing remains server-only. */
export function buildQuestionResults(exam: Exam, attempt: Attempt): QuestionResult[] {
    const questions = getEffectiveExamQuestionsForAttempt(exam, attempt);
    const totalQuestions = questions.length;
    const timingByQuestionId = new Map(
        (attempt.questionTimings || []).map(timing => [timing.questionId, timing]),
    );
    const drawingByQuestionId = new Map(
        (attempt.questionDrawings || []).map(drawing => [drawing.questionId, drawing]),
    );

    return questions.map(question => {
        const selectedAnswer = attempt.answers[question.id];
        const status = resolveQuestionStatus(question, selectedAnswer);
        const score = roundScore(questionWeight(question, totalQuestions));
        const timing = timingByQuestionId.get(question.id);
        const drawing = drawingByQuestionId.get(question.id);
        const answered = isAnswered(selectedAnswer);
        return {
            schemaVersion: 1,
            attemptId: attempt.id,
            examId: attempt.examId || exam.id,
            examTitle: attempt.examTitle || exam.title,
            organizationId: attempt.organizationId,
            classId: attempt.classId,
            assignmentId: attempt.assignmentId,
            assignmentRevision: attempt.assignmentRevision,
            studentProfileId: attempt.studentProfileId,
            studentName: attempt.studentName,
            studentId: attempt.studentId,
            groupId: attempt.groupId,
            groupName: attempt.groupName,
            regionId: attempt.regionId,
            regionName: attempt.regionName,
            identityType: attempt.identityType,
            questionId: question.id,
            questionNumber: question.number,
            canonicalQuestionId: canonicalQuestionIdFor(exam.id, question.id),
            label: question.label,
            score,
            earnedScore: status === "correct" ? score : 0,
            selectedAnswer: answered ? selectedAnswer : undefined,
            correctAnswer: question.answer,
            status,
            isCorrect: status === "correct",
            isWrong: status === "wrong",
            isUnanswered: status === "unanswered",
            subject: question.tags?.subject,
            unit: question.tags?.unit,
            concept: question.tags?.concept,
            skill: question.tags?.skill,
            source: question.tags?.source,
            difficulty: question.tags?.difficulty,
            cognitiveLevel: question.tags?.cognitiveLevel,
            mistakeTypes: question.tags?.mistakeTypes ? [...question.tags.mistakeTypes] : undefined,
            prerequisites: question.tags?.prerequisites ? [...question.tags.prerequisites] : undefined,
            expectedTimeSec: question.tags?.expectedTimeSec,
            pdfPage: question.pdfRegion?.page || question.pdfLocation?.page,
            pdfLocation: question.pdfLocation,
            pdfRegion: question.pdfRegion,
            passagePdfRegions: question.passagePdfRegions,
            timeSec: timing?.totalTimeSec,
            visitCount: timing?.visitCount,
            revisitCount: timing?.revisitCount,
            answerChangeCount: timing?.answerChangeCount,
            handwritingStrokeCount: drawing?.strokeCount,
            handwritingPage: drawing?.page,
            retakeSourceAttemptId: attempt.retake?.sourceAttemptId,
            retakeMode: attempt.retake?.mode,
            answeredAt: timing?.lastAnsweredAt,
            finishedAt: attempt.finishedAt,
        };
    });
}
