import type { Attempt, Exam } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import { baseAttemptsOnly, resolveAttemptScore, retakeAttemptsOnly } from "@/lib/attemptScores";
import {
    buildLearningRecommendations,
    getAttemptQuestionResults,
    type LearningRecommendationSeverity,
    type QuestionResultGroupKind,
} from "@/lib/premiumAnalytics";
import { attemptMatchesStudentProfile } from "@/utils/storage";

const DEFAULT_WEAKNESS_KINDS: QuestionResultGroupKind[] = ["concept", "mistakeType", "unit"];

export interface StudentProfileAttemptInsight {
    id: string;
    examId: string;
    examTitle: string;
    finishedAt: string;
    scorePercent: number;
    wrongQuestionNumbers: number[];
    unansweredQuestionNumbers: number[];
    handwritingArchived: boolean;
    handwritingLabel: string;
    detailHref: string;
    isRetake: boolean;
    retakeQuestionCount: number;
}

export interface StudentProfileWeaknessInsight {
    key: string;
    examId: string;
    examTitle: string;
    kind: QuestionResultGroupKind;
    title: string;
    basis: string;
    wrongCount: number;
    unansweredCount: number;
    totalCount: number;
    wrongRate: number;
    questionNumbers: number[];
    recommendedQuestionIds: number[];
    severity: LearningRecommendationSeverity;
    reason: string;
    sourceAttemptId: string;
    retakeMode: "wrong" | "similar";
    retakeQuestionIds: number[];
    retakeLabels: string[];
    retakeConcepts: string[];
    recommendedAction: string;
}

export interface StudentProfileInsight {
    attempts: StudentProfileAttemptInsight[];
    averageScore: number;
    bestScore: number;
    latestScore: number;
    trendDelta: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    handwritingArchiveCount: number;
    baseAttemptCount: number;
    retakeAttemptCount: number;
    weaknessGroups: StudentProfileWeaknessInsight[];
}

export interface StudentProfileInsightOptions {
    recentLimit?: number;
    weaknessLimit?: number;
    weaknessKinds?: QuestionResultGroupKind[];
}

function activityTime(attempt: Attempt): number {
    return Date.parse(attempt.finishedAt || attempt.startedAt || "") || 0;
}

function handwritingLabel(attempt: Attempt): string {
    const questionCount = attempt.questionDrawings?.length || attempt.handwriting?.summary.questionCount || 0;
    if (questionCount > 0) return `${questionCount}문항`;
    const pageCount = attempt.drawingPageCount || attempt.handwriting?.summary.pageCount || 0;
    if (pageCount > 0) return `${pageCount}쪽`;
    return "저장됨";
}

function hasArchivedHandwriting(attempt: Attempt): boolean {
    return !!attempt.handwritingArchived && !!(attempt.handwriting?.strokesRef || attempt.drawingsRef);
}

function sortedUniqueQuestionNumbers(values: number[]): number[] {
    return Array.from(new Set(values)).sort((a, b) => a - b);
}

export function buildStudentProfileInsight(
    student: RosterStudent,
    attempts: Attempt[],
    examById: Map<string, Exam>,
    options: StudentProfileInsightOptions = {},
): StudentProfileInsight {
    const recentLimit = Math.max(1, options.recentLimit ?? 8);
    const weaknessLimit = Math.max(1, options.weaknessLimit ?? 6);
    const weaknessKinds = options.weaknessKinds?.length ? options.weaknessKinds : DEFAULT_WEAKNESS_KINDS;

    const matchedAttempts = attempts
        .filter(attempt => attemptMatchesStudentProfile(attempt, student))
        .sort((a, b) => activityTime(b) - activityTime(a));
    const baseMatchedAttempts = baseAttemptsOnly(matchedAttempts);
    const retakeMatchedAttempts = retakeAttemptsOnly(matchedAttempts);
    const baseAttemptIds = new Set(baseMatchedAttempts.map(attempt => attempt.id));

    const attemptInsights = matchedAttempts.map(attempt => {
        const exam = examById.get(attempt.examId);
        const results = exam ? getAttemptQuestionResults(exam, attempt) : [];
        const wrongQuestionNumbers = sortedUniqueQuestionNumbers(
            results
                .filter(result => result.status === "wrong" || result.isWrong)
                .map(result => result.questionNumber)
        );
        const unansweredQuestionNumbers = sortedUniqueQuestionNumbers(
            results
                .filter(result => result.status === "unanswered" || result.isUnanswered)
                .map(result => result.questionNumber)
        );

        return {
            id: attempt.id,
            examId: attempt.examId,
            examTitle: attempt.examTitle || exam?.title || "시험",
            finishedAt: attempt.finishedAt,
            scorePercent: resolveAttemptScore(attempt, exam).scorePercent,
            wrongQuestionNumbers,
            unansweredQuestionNumbers,
            handwritingArchived: hasArchivedHandwriting(attempt),
            handwritingLabel: handwritingLabel(attempt),
            detailHref: `/teacher/attempt/${attempt.id}`,
            isRetake: !!attempt.retake,
            retakeQuestionCount: attempt.retake?.questionIds.length || 0,
        };
    });

    const scoredAttempts = attemptInsights.filter(attempt => (
        baseAttemptIds.has(attempt.id) && Number.isFinite(attempt.scorePercent)
    ));
    const averageScore = scoredAttempts.length > 0
        ? Math.round(scoredAttempts.reduce((sum, attempt) => sum + attempt.scorePercent, 0) / scoredAttempts.length)
        : student.avgScore;
    const bestScore = scoredAttempts.length > 0
        ? Math.max(...scoredAttempts.map(attempt => attempt.scorePercent))
        : student.avgScore;
    const latestScore = scoredAttempts[0]?.scorePercent ?? student.avgScore;
    const previousScore = scoredAttempts[1]?.scorePercent ?? latestScore;

    const attemptsByExam = new Map<string, Attempt[]>();
    for (const attempt of baseMatchedAttempts) {
        if (!examById.has(attempt.examId)) continue;
        attemptsByExam.set(attempt.examId, [...(attemptsByExam.get(attempt.examId) || []), attempt]);
    }

    const weaknessGroups: StudentProfileWeaknessInsight[] = [];
    let wrongQuestionCount = 0;
    let unansweredQuestionCount = 0;

    for (const [examId, examAttempts] of attemptsByExam.entries()) {
        const exam = examById.get(examId);
        if (!exam) continue;
        const results = examAttempts.flatMap(attempt => getAttemptQuestionResults(exam, attempt));
        wrongQuestionCount += results.filter(result => result.status === "wrong" || result.isWrong).length;
        unansweredQuestionCount += results.filter(result => result.status === "unanswered" || result.isUnanswered).length;

        const sourceAttempt = examAttempts[0];
        for (const recommendation of buildLearningRecommendations(exam, examAttempts, {
            scope: "student",
            attempt: sourceAttempt,
            kinds: weaknessKinds,
            limit: weaknessLimit * 2,
        })) {
            weaknessGroups.push({
                key: `${exam.id}:${recommendation.key}`,
                examId: exam.id,
                examTitle: exam.title,
                kind: recommendation.kind,
                title: recommendation.title,
                basis: recommendation.basis,
                wrongCount: recommendation.wrongCount,
                unansweredCount: recommendation.unansweredCount,
                totalCount: recommendation.totalCount,
                wrongRate: recommendation.wrongRate,
                questionNumbers: recommendation.questionNumbers,
                recommendedQuestionIds: recommendation.recommendedQuestionIds,
                severity: recommendation.severity,
                reason: recommendation.reason,
                sourceAttemptId: recommendation.sourceAttemptId,
                retakeMode: recommendation.retakeMode,
                retakeQuestionIds: recommendation.retakeQuestionIds,
                retakeLabels: recommendation.retakeLabels,
                retakeConcepts: recommendation.retakeConcepts,
                recommendedAction: recommendation.recommendedAction,
            });
        }
    }

    const kindRank: Record<QuestionResultGroupKind, number> = {
        concept: 0,
        mistakeType: 1,
        unit: 2,
        source: 3,
        skill: 4,
        difficulty: 5,
        label: 6,
    };

    const rankedWeaknessGroups = weaknessGroups
        .sort((a, b) => {
            if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
            if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
            if (b.unansweredCount !== a.unansweredCount) return b.unansweredCount - a.unansweredCount;
            if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
            return a.title.localeCompare(b.title, "ko");
        })
        .slice(0, weaknessLimit);

    return {
        attempts: attemptInsights.slice(0, recentLimit),
        averageScore,
        bestScore,
        latestScore,
        trendDelta: latestScore - previousScore,
        wrongQuestionCount,
        unansweredQuestionCount,
        handwritingArchiveCount: attemptInsights.filter(attempt => attempt.handwritingArchived).length,
        baseAttemptCount: baseMatchedAttempts.length,
        retakeAttemptCount: retakeMatchedAttempts.length,
        weaknessGroups: rankedWeaknessGroups,
    };
}
