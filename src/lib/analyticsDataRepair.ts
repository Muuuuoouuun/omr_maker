import type { Attempt, Exam } from "@/types/omr";
import { getAttemptQuestionResults, getEffectiveExamQuestionsForAttempt, summarizeAttemptScore } from "@/lib/premiumAnalytics";

export interface QuestionResultRepairItem {
    attemptId: string;
    examId: string;
    examTitle: string;
    studentName: string;
    expectedQuestionCount: number;
    existingQuestionResultCount: number;
    missingQuestionResultCount: number;
    repairedAttempt: Attempt;
}

export interface QuestionResultRepairPlan {
    repairableCount: number;
    repairedQuestionResultCount: number;
    skippedOrphanAttemptCount: number;
    skippedInProgressAttemptCount: number;
    items: QuestionResultRepairItem[];
}

function isCompletedAttempt(attempt: Attempt): boolean {
    return attempt.status !== "in_progress";
}

export function repairAttemptQuestionResults(exam: Exam, attempt: Attempt): QuestionResultRepairItem | null {
    if (exam.id !== attempt.examId || !isCompletedAttempt(attempt)) return null;
    const effectiveQuestions = getEffectiveExamQuestionsForAttempt(exam, attempt);
    const expectedQuestionCount = effectiveQuestions.length;
    if (expectedQuestionCount === 0) return null;

    const effectiveQuestionIds = new Set(effectiveQuestions.map(question => question.id));
    const existingQuestionResultCount = attempt.questionResults?.filter(result => (
        result.examId === exam.id && effectiveQuestionIds.has(result.questionId)
    )).length || 0;
    if (existingQuestionResultCount >= expectedQuestionCount) return null;

    const questionResults = getAttemptQuestionResults(exam, attempt);
    if (questionResults.length < expectedQuestionCount) return null;

    const scoreSummary = summarizeAttemptScore(exam, { ...attempt, questionResults });
    const repairedAttempt: Attempt = {
        ...attempt,
        questionResults,
        score: scoreSummary.earnedScore,
        totalScore: scoreSummary.totalScore,
    };

    return {
        attemptId: attempt.id,
        examId: exam.id,
        examTitle: attempt.examTitle || exam.title,
        studentName: attempt.studentName,
        expectedQuestionCount,
        existingQuestionResultCount,
        missingQuestionResultCount: expectedQuestionCount - existingQuestionResultCount,
        repairedAttempt,
    };
}

export function buildQuestionResultRepairPlan(exams: Exam[], attempts: Attempt[]): QuestionResultRepairPlan {
    const examById = new Map(exams.map(exam => [exam.id, exam]));
    const items: QuestionResultRepairItem[] = [];
    let skippedOrphanAttemptCount = 0;
    let skippedInProgressAttemptCount = 0;

    for (const attempt of attempts) {
        const exam = examById.get(attempt.examId);
        if (!exam) {
            skippedOrphanAttemptCount += 1;
            continue;
        }
        if (!isCompletedAttempt(attempt)) {
            skippedInProgressAttemptCount += 1;
            continue;
        }

        const item = repairAttemptQuestionResults(exam, attempt);
        if (item) items.push(item);
    }

    return {
        repairableCount: items.length,
        repairedQuestionResultCount: items.reduce((sum, item) => sum + item.missingQuestionResultCount, 0),
        skippedOrphanAttemptCount,
        skippedInProgressAttemptCount,
        items,
    };
}
