import type { Exam, QuestionResult } from "@/types/omr";

export interface StudentConceptEvidence {
    examId: string;
    examTitle: string;
    questionNumber: number;
    attemptId: string;
    status: QuestionResult["status"];
    finishedAt: string;
    /** Reserved for a future submission-time snapshot; current exam annotations are never historical evidence. */
    trapPoints: string[];
}

export interface StudentConceptMastery {
    concept: string;
    correctCount: number;
    totalCount: number;
    unansweredCount: number;
    distinctQuestionCount: number;
    attemptCount: number;
    correctRate: number;
    assessment: "strength" | "weakness" | "developing" | "insufficient";
    trendDelta: number | null;
    evidence: StudentConceptEvidence[];
}

export interface StudentConceptMasterySummary {
    groups: StudentConceptMastery[];
    unmappedQuestionCount: number;
}

function activityTimestamp(value: string): number | null {
    if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
    const datePart = value.slice(0, 10);
    const calendarDate = Date.parse(`${datePart}T00:00:00Z`);
    if (!Number.isFinite(calendarDate) || new Date(calendarDate).toISOString().slice(0, 10) !== datePart) return null;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
}

/** Uses canonical grading and concept snapshots only, never mutable exam annotations. */
export function buildStudentConceptMastery(
    results: readonly QuestionResult[],
    examById: ReadonlyMap<string, Exam>,
    finishedAtByAttempt: ReadonlyMap<string, string>,
): StudentConceptMasterySummary {
    // Retain the argument for callers, but never join mutable exam annotations into historical evidence.
    void examById;
    const grouped = new Map<string, StudentConceptEvidence[]>();
    const distinctQuestions = new Map<string, Set<string>>();
    const seenResults = new Set<string>();
    let unmappedQuestionCount = 0;
    for (const result of results) {
        if (result.status === "ungraded") continue;
        const resultKey = JSON.stringify([result.examId, result.attemptId, result.questionId]);
        if (seenResults.has(resultKey)) continue;
        seenResults.add(resultKey);
        const questionKey = JSON.stringify([result.examId, result.questionId]);
        // Keep the submitted concept snapshot: later edits must not relabel historical work.
        const concepts = result.concept?.trim() ? [result.concept.trim()] : [];
        if (!concepts.length) unmappedQuestionCount += 1;
        for (const concept of concepts) {
            const evidence = grouped.get(concept) || [];
            evidence.push({
                examId: result.examId,
                examTitle: result.examTitle,
                questionNumber: result.questionNumber,
                attemptId: result.attemptId,
                status: result.status,
                finishedAt: finishedAtByAttempt.get(result.attemptId) || "",
                trapPoints: [],
            });
            grouped.set(concept, evidence);
            const questions = distinctQuestions.get(concept) || new Set<string>();
            questions.add(questionKey);
            distinctQuestions.set(concept, questions);
        }
    }
    const groups = [...grouped].map(([concept, evidence]): StudentConceptMastery => {
        evidence.sort((a, b) => (activityTimestamp(b.finishedAt) ?? -Infinity) - (activityTimestamp(a.finishedAt) ?? -Infinity)
            || a.attemptId.localeCompare(b.attemptId) || a.questionNumber - b.questionNumber);
        const attempts = [...new Set(evidence.map(item => item.attemptId))];
        const correctCount = evidence.filter(item => item.status === "correct").length;
        const correctRate = Math.round(correctCount / evidence.length * 100);
        const distinctQuestionCount = distinctQuestions.get(concept)!.size;
        const sufficient = distinctQuestionCount >= 3 && attempts.length >= 2;
        // Compare equal-sized sets of recent and preceding original attempts only when both have evidence.
        const windowSize = Math.floor(attempts.length / 2);
        const recentIds = new Set(attempts.slice(0, windowSize));
        const previousIds = new Set(attempts.slice(windowSize, windowSize * 2));
        const recent = evidence.filter(item => recentIds.has(item.attemptId));
        const previous = evidence.filter(item => previousIds.has(item.attemptId));
        const allDatesKnown = evidence.every(item => activityTimestamp(item.finishedAt) !== null);
        // Equal timestamps across the split cannot establish a previous/recent ordering.
        const orderedWindows = recent.length > 0 && previous.length > 0
            && Math.min(...recent.map(item => activityTimestamp(item.finishedAt) ?? -Infinity))
                > Math.max(...previous.map(item => activityTimestamp(item.finishedAt) ?? Infinity));
        const trendDelta = allDatesKnown && orderedWindows && windowSize >= 1 && recent.length >= 2 && previous.length >= 2
            ? Math.round(recent.filter(item => item.status === "correct").length / recent.length * 100)
                - Math.round(previous.filter(item => item.status === "correct").length / previous.length * 100)
            : null;
        return {
            concept, correctCount, correctRate, totalCount: evidence.length,
            unansweredCount: evidence.filter(item => item.status === "unanswered").length,
            distinctQuestionCount, attemptCount: attempts.length,
            assessment: !sufficient ? "insufficient" : correctCount / evidence.length >= 0.8 ? "strength" : correctCount / evidence.length <= 0.5 ? "weakness" : "developing",
            trendDelta,
            evidence: evidence.slice(0, 6),
        };
    }).sort((a, b) => b.totalCount - a.totalCount || a.concept.localeCompare(b.concept, "ko"));
    return { groups, unmappedQuestionCount };
}
