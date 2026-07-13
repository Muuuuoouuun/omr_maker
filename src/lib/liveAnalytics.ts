import type { Attempt, Exam } from "@/types/omr";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";

export interface LiveQuestionHeatmapCell {
    questionId: number;
    q: number;
    correct: number;
    total: number;
}

export interface LiveQuestionHeatmapQuestion {
    id: number;
    answer?: number;
}

interface BuildLiveQuestionHeatmapOptions {
    examId: string;
    sourceExam?: Exam;
    questions: LiveQuestionHeatmapQuestion[];
    totalQuestionCount: number;
    submittedAttempts: Attempt[];
    submittedDisplayCount: number;
    allowSynthetic: boolean;
}

function hashString(str: string): number {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = ((h << 5) - h) + str.charCodeAt(i);
        h |= 0;
    }
    return Math.abs(h);
}

/** Stable identity key for collapsing repeat submissions from the same student. */
function liveAttemptIdentityKey(attempt: Attempt): string {
    return attempt.studentProfileId
        || attempt.studentId
        || attempt.guestId
        || attempt.studentName
        || attempt.id;
}

/** Recency for picking the latest attempt per student. Falls back to start time. */
function liveAttemptRecency(attempt: Attempt): number {
    return (Date.parse(attempt.finishedAt || "") || 0)
        || (Date.parse(attempt.startedAt || "") || 0);
}

/**
 * Collapse the raw attempt list for a single exam into one row per student:
 * excludes premium retakes (which only cover a question subset and would skew
 * per-question denominators) and keeps the latest attempt per student identity
 * so repeat submissions never double-count on the live cards, count tiles, or
 * question heatmap. Mirrors the retake skip in kakaoNotificationQueue.
 */
export function dedupeLiveAttempts(attempts: Attempt[]): Attempt[] {
    const latestByStudent = new Map<string, Attempt>();
    for (const attempt of attempts) {
        if (!attempt || attempt.retake) continue;
        const key = liveAttemptIdentityKey(attempt);
        const existing = latestByStudent.get(key);
        if (!existing || liveAttemptRecency(attempt) >= liveAttemptRecency(existing)) {
            latestByStudent.set(key, attempt);
        }
    }
    return Array.from(latestByStudent.values());
}

export function buildRealQuestionHeatmap(exam: Exam, attempts: Attempt[]): LiveQuestionHeatmapCell[] {
    const submittedAttempts = attempts.filter(attempt => attempt.status === "completed");

    // Grade each attempt once up-front (getAttemptQuestionResults recomputes the
    // whole-exam grading per call) and index the results by questionId, so the
    // per-question loop below is O(Q×A) map lookups instead of O(Q²×A) re-gradings.
    const resultsByAttempt = submittedAttempts.map(attempt =>
        new Map(getAttemptQuestionResults(exam, attempt).map(result => [result.questionId, result]))
    );

    return exam.questions.map((question, index) => {
        let correct = 0;
        let total = 0;

        for (const results of resultsByAttempt) {
            const result = results.get(question.id);
            if (!result || result.status === "ungraded") continue;
            total += 1;
            if (result.status === "correct") correct += 1;
        }

        return {
            questionId: question.id,
            q: index + 1,
            correct,
            total,
        };
    });
}

export function buildLiveQuestionHeatmap({
    examId,
    sourceExam,
    questions,
    totalQuestionCount,
    submittedAttempts,
    submittedDisplayCount,
    allowSynthetic,
}: BuildLiveQuestionHeatmapOptions): LiveQuestionHeatmapCell[] {
    const qList: LiveQuestionHeatmapQuestion[] = questions.length > 0
        ? questions
        : Array.from({ length: totalQuestionCount }, (_, index) => ({ id: index + 1 }));

    if (qList.length === 0) return [];

    const submittedReal = submittedAttempts.filter(attempt => attempt.status === "completed");
    const totalReal = submittedReal.length;

    if (sourceExam && totalReal > 0) {
        const realHeatmapByQuestionId = new Map(
            buildRealQuestionHeatmap(sourceExam, submittedReal).map(cell => [cell.questionId, cell])
        );
        return qList.map((question, index) => {
            const cell = realHeatmapByQuestionId.get(question.id);
            return cell ?? { questionId: question.id, q: index + 1, correct: 0, total: 0 };
        });
    }

    if (totalReal > 0) {
        return qList.map((question, index) => {
            if (question.answer === undefined || question.answer === null) {
                return { questionId: question.id, q: index + 1, correct: 0, total: 0 };
            }

            let correct = 0;
            for (const attempt of submittedReal) {
                const selected = attempt.answers ? attempt.answers[question.id] : undefined;
                if (selected !== undefined && selected === question.answer) correct++;
            }
            return { questionId: question.id, q: index + 1, correct, total: totalReal };
        });
    }

    if (allowSynthetic && submittedDisplayCount > 0) {
        return qList.map((question, index) => {
            const seed = hashString(`${examId}:${index + 1}`);
            const baseline = 35 + (seed % 56);
            const correct = Math.round((baseline / 100) * submittedDisplayCount);
            return { questionId: question.id, q: index + 1, correct, total: submittedDisplayCount };
        });
    }

    return qList.map((question, index) => ({
        questionId: question.id,
        q: index + 1,
        correct: 0,
        total: 0,
    }));
}
