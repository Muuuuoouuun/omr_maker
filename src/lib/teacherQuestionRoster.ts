import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import { resolveAttemptScore, type ResolvedAttemptScore } from "@/lib/attemptScores";
import { resolveAttemptGrading } from "@/lib/premiumAnalytics";

export interface TeacherAttemptSummary {
    score: ResolvedAttemptScore;
    rows: QuestionResult[];
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
}

export function summarizeTeacherAttempt(exam: Exam, attempt: Attempt): TeacherAttemptSummary {
    // Historical totals survive key edits. Never derive official rows from today's exam.
    const grading = attempt.questionResults?.length && !attempt.questionResultsSource
        ? resolveAttemptGrading(exam, attempt) : undefined;
    const canonical = grading?.source === "canonical_submission" ? grading : undefined;
    const rows = canonical?.questionResults ?? [];
    const score = canonical
        ? { ...canonical.scoreSummary, source: canonical.source }
        : resolveAttemptScore(attempt);
    let correctCount = 0;
    let wrongCount = 0;
    let unansweredCount = 0;
    for (const row of rows) {
        if (row.status === "correct") correctCount++;
        if (row.status === "wrong") wrongCount++;
        if (row.status === "unanswered") unansweredCount++;
    }
    return { score, rows, correctCount, wrongCount, unansweredCount };
}

export function belongsToExam(exam: Exam, attempt: Attempt) {
    return attempt.examId === exam.id
        && !(exam.organizationId && attempt.organizationId && exam.organizationId !== attempt.organizationId);
}

export interface TeacherRosterQuestion {
    id: number;
    number: number;
    rows: QuestionResult[];
}

export type TeacherQuestionRoster =
    | { status: "unavailable" | "empty" }
    | { status: "ready"; questions: TeacherRosterQuestion[]; total: number };

export function buildTeacherQuestionRoster(
    exam: Exam,
    attempts: readonly Attempt[],
    summaries: ReadonlyMap<string, TeacherAttemptSummary>,
    expectedOriginalCount: number | null,
): TeacherQuestionRoster {
    if (expectedOriginalCount === null || attempts.some(attempt => !belongsToExam(exam, attempt))) {
        return { status: "unavailable" };
    }
    const originals = attempts.filter(attempt => attempt.status === "completed" && !attempt.retake);
    if (originals.length !== expectedOriginalCount || new Set(originals.map(a => a.id)).size !== originals.length) {
        return { status: "unavailable" };
    }
    if (originals.length === 0) return { status: "empty" };

    // A changed answer key or numbering is a separate definition. Mixing versions
    // would assign the wrong students to the selected item.
    const definition = originals[0].questionResultsDefinitionManifestHash;
    const byQuestion = new Map<number, TeacherRosterQuestion>();
    for (const attempt of originals) {
        const summary = summaries.get(attempt.id);
        if ((exam.organizationId && attempt.organizationId !== exam.organizationId)
            || !definition || attempt.questionResultsDefinitionManifestHash !== definition
            || !summary?.rows.length || summary.score.source !== "canonical_submission") {
            return { status: "unavailable" };
        }
        for (const row of summary.rows) {
            let question = byQuestion.get(row.questionId);
            if (!question) {
                question = { id: row.questionId, number: row.questionNumber, rows: [] };
                byQuestion.set(row.questionId, question);
            }
            question.rows.push(row);
        }
    }

    const questions = Array.from(byQuestion.values()).sort((a, b) => a.number - b.number);
    if (new Set(questions.map(question => question.number)).size !== questions.length) {
        return { status: "unavailable" };
    }
    return { status: "ready", questions, total: originals.length };
}
