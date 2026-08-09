import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import {
    baseAttemptsOnly,
    completedAttemptsOnly,
    resolveAttemptScore,
    retakeAttemptsOnly,
} from "@/lib/attemptScores";
import { resolveAwayCount } from "@/lib/examAwayTracker";
import {
    attemptElapsedTimeSec,
    buildMostMissedQuestionStats,
    buildLearningRecommendations,
    buildQuestionResultTagStats,
    getAttemptQuestionResults,
    hasGradableAttemptScore,
    summarizeAttemptBehavior,
    type LearningRecommendationSeverity,
    type QuestionResultTagStat,
    type QuestionResultGroupKind,
} from "@/lib/premiumAnalytics";
import { attemptMatchesStudentProfile } from "@/utils/storage";

const DEFAULT_WEAKNESS_KINDS: QuestionResultGroupKind[] = ["concept", "mistakeType", "unit"];

export interface StudentProfileAttemptInsight {
    id: string;
    examId: string;
    examTitle: string;
    finishedAt: string;
    scorePercent: number | null;
    elapsedTimeSec: number;
    totalTrackedTimeSec: number;
    averageQuestionTimeSec: number;
    wrongQuestionNumbers: number[];
    unansweredQuestionNumbers: number[];
    slowQuestionNumbers: number[];
    revisitedQuestionNumbers: number[];
    answerChangedQuestionNumbers: number[];
    focusLossCount: number;
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

export interface StudentProfileHeadlineWeaknessEvidence {
    kind: QuestionResultGroupKind;
    title: string;
    examIds: string[];
    wrongCount: number;
    maxWrongRate: number;
    recommendedAction: string;
}

export interface StudentProfileMissedQuestionInsight {
    key: string;
    examId: string;
    examTitle: string;
    questionId: number;
    questionNumber: number;
    label?: string;
    concept?: string;
    wrongCount: number;
    totalCount: number;
    wrongRate: number;
    averageTimeSec?: number;
}

export type StudentProfileTagInsight = QuestionResultTagStat;

export interface StudentProfileInsight {
    attempts: StudentProfileAttemptInsight[];
    averageScore: number | null;
    bestScore: number | null;
    latestScore: number | null;
    trendDelta: number | null;
    averageElapsedTimeSec: number;
    averageQuestionTimeSec: number;
    totalTrackedTimeSec: number;
    focusLossCount: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    handwritingArchiveCount: number;
    baseAttemptCount: number;
    retakeAttemptCount: number;
    weaknessGroups: StudentProfileWeaknessInsight[];
    /** Bounded title-level evidence for cumulative narrative; independent from the display top-N. */
    headlineWeaknessGroups: StudentProfileHeadlineWeaknessEvidence[];
    mostMissedQuestions: StudentProfileMissedQuestionInsight[];
    tagStats: StudentProfileTagInsight[];
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
    const summaryQuestionCount = "handwritingQuestionCount" in attempt
        && typeof attempt.handwritingQuestionCount === "number"
        ? attempt.handwritingQuestionCount
        : 0;
    const questionCount = attempt.questionDrawings?.length
        || attempt.handwriting?.summary.questionCount
        || summaryQuestionCount;
    if (questionCount > 0) return `${questionCount}문항`;
    const pageCount = attempt.drawingPageCount || attempt.handwriting?.summary.pageCount || 0;
    if (pageCount > 0) return `${pageCount}쪽`;
    return "저장됨";
}

function hasArchivedHandwriting(attempt: Attempt): boolean {
    const summaryStrokesRef = "handwritingStrokesRef" in attempt
        ? attempt.handwritingStrokesRef
        : undefined;
    return !!attempt.handwritingArchived
        && !!(attempt.handwriting?.strokesRef || summaryStrokesRef || attempt.drawingsRef);
}

function sortedUniqueQuestionNumbers(values: number[]): number[] {
    return Array.from(new Set(values)).sort((a, b) => a - b);
}

function roundedAverage(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

const HEADLINE_WEAKNESS_EVIDENCE_LIMIT = 12;

interface MutableHeadlineWeaknessEvidence {
    kind: QuestionResultGroupKind;
    title: string;
    examIds: Set<string>;
    wrongCount: number;
    maxWrongRate: number;
    recommendedAction: string;
    actionWrongCount: number;
    actionWrongRate: number;
}

function buildHeadlineWeaknessEvidence(
    groups: readonly StudentProfileWeaknessInsight[],
): StudentProfileHeadlineWeaknessEvidence[] {
    const evidenceByTitle = new Map<string, MutableHeadlineWeaknessEvidence>();
    for (const group of groups) {
        const title = group.title.trim();
        if (!title) continue;
        const key = `${group.kind}\u0000${title.toLocaleLowerCase("ko-KR")}`;
        const current = evidenceByTitle.get(key);
        if (!current) {
            evidenceByTitle.set(key, {
                kind: group.kind,
                title,
                examIds: new Set([group.examId]),
                wrongCount: Math.max(0, group.wrongCount),
                maxWrongRate: group.wrongRate,
                recommendedAction: group.recommendedAction.trim(),
                actionWrongCount: group.wrongCount,
                actionWrongRate: group.wrongRate,
            });
            continue;
        }

        current.examIds.add(group.examId);
        current.wrongCount += Math.max(0, group.wrongCount);
        current.maxWrongRate = Math.max(current.maxWrongRate, group.wrongRate);
        const actionIsPreferred = group.wrongCount > current.actionWrongCount
            || (group.wrongCount === current.actionWrongCount && group.wrongRate > current.actionWrongRate)
            || (
                group.wrongCount === current.actionWrongCount
                && group.wrongRate === current.actionWrongRate
                && group.recommendedAction.localeCompare(current.recommendedAction, "ko") < 0
            );
        if (actionIsPreferred) {
            current.recommendedAction = group.recommendedAction.trim();
            current.actionWrongCount = group.wrongCount;
            current.actionWrongRate = group.wrongRate;
        }
    }

    return Array.from(evidenceByTitle.values())
        .sort((left, right) => (
            right.examIds.size - left.examIds.size
            || right.wrongCount - left.wrongCount
            || right.maxWrongRate - left.maxWrongRate
            || left.title.localeCompare(right.title, "ko")
            || left.kind.localeCompare(right.kind)
        ))
        .slice(0, HEADLINE_WEAKNESS_EVIDENCE_LIMIT)
        .map(group => ({
            kind: group.kind,
            title: group.title,
            examIds: Array.from(group.examIds).sort((left, right) => left.localeCompare(right)),
            wrongCount: group.wrongCount,
            maxWrongRate: group.maxWrongRate,
            recommendedAction: group.recommendedAction,
        }));
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

    const matchedAttempts = completedAttemptsOnly(attempts)
        .filter(attempt => attemptMatchesStudentProfile(attempt, student))
        .sort((a, b) => activityTime(b) - activityTime(a));
    const resolvedScoreByAttempt = new Map(matchedAttempts.map(attempt => [
        attempt,
        resolveAttemptScore(attempt, examById.get(attempt.examId)),
    ]));
    const baseMatchedAttempts = baseAttemptsOnly(matchedAttempts);
    const retakeMatchedAttempts = retakeAttemptsOnly(matchedAttempts);
    const baseAttemptIds = new Set(baseMatchedAttempts.map(attempt => attempt.id));

    const attemptInsights = matchedAttempts.map(attempt => {
        const exam = examById.get(attempt.examId);
        const resolvedScore = resolvedScoreByAttempt.get(attempt)!;
        const results = exam ? getAttemptQuestionResults(exam, attempt) : [];
        const behavior = summarizeAttemptBehavior(attempt);
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
            scorePercent: hasGradableAttemptScore(resolvedScore) ? resolvedScore.scorePercent : null,
            elapsedTimeSec: behavior.elapsedTimeSec,
            totalTrackedTimeSec: behavior.totalTrackedTimeSec,
            averageQuestionTimeSec: behavior.averageTimeSec,
            wrongQuestionNumbers,
            unansweredQuestionNumbers,
            slowQuestionNumbers: behavior.slowQuestionNumbers,
            revisitedQuestionNumbers: behavior.revisitedQuestionNumbers,
            answerChangedQuestionNumbers: behavior.answerChangedQuestionNumbers,
            focusLossCount: behavior.focusLossCount,
            handwritingArchived: hasArchivedHandwriting(attempt),
            handwritingLabel: handwritingLabel(attempt),
            detailHref: `/teacher/attempt/${attempt.id}`,
            isRetake: !!attempt.retake,
            retakeQuestionCount: attempt.retake?.questionIds.length || 0,
        };
    });

    const scoreValues = attemptInsights
        .filter(attempt => baseAttemptIds.has(attempt.id))
        .map(attempt => attempt.scorePercent)
        .filter((score): score is number => score !== null && Number.isFinite(score));
    const averageScore = scoreValues.length > 0
        ? Math.round(scoreValues.reduce((sum, score) => sum + score, 0) / scoreValues.length)
        : null;
    const bestScore = scoreValues.length > 0 ? Math.max(...scoreValues) : null;
    const latestScore = scoreValues[0] ?? null;
    const previousScore = scoreValues[1] ?? latestScore;

    const attemptsByExam = new Map<string, Attempt[]>();
    for (const attempt of baseMatchedAttempts) {
        if (!examById.has(attempt.examId)) continue;
        attemptsByExam.set(attempt.examId, [...(attemptsByExam.get(attempt.examId) || []), attempt]);
    }

    const weaknessGroups: StudentProfileWeaknessInsight[] = [];
    const mostMissedQuestions: StudentProfileMissedQuestionInsight[] = [];
    const baseQuestionResults: QuestionResult[] = [];
    let wrongQuestionCount = 0;
    let unansweredQuestionCount = 0;

    for (const [examId, examAttempts] of attemptsByExam.entries()) {
        const exam = examById.get(examId);
        if (!exam) continue;
        const results = examAttempts.flatMap(attempt => getAttemptQuestionResults(exam, attempt));
        baseQuestionResults.push(...results);
        wrongQuestionCount += results.filter(result => result.status === "wrong" || result.isWrong).length;
        unansweredQuestionCount += results.filter(result => result.status === "unanswered" || result.isUnanswered).length;
        mostMissedQuestions.push(...buildMostMissedQuestionStats(exam, examAttempts, weaknessLimit).map(stat => ({
            key: `${exam.id}:${stat.questionId}`,
            examId: exam.id,
            examTitle: exam.title,
            questionId: stat.questionId,
            questionNumber: stat.questionNumber,
            label: stat.label,
            concept: stat.concept,
            wrongCount: stat.wrongCount,
            totalCount: stat.totalCount,
            wrongRate: stat.wrongRate,
            averageTimeSec: stat.averageTimeSec,
        })));

        const sourceAttempt = examAttempts[0];
        for (const recommendation of buildLearningRecommendations(exam, examAttempts, {
            scope: "student",
            attempt: sourceAttempt,
            kinds: weaknessKinds,
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

    const headlineWeaknessGroups = buildHeadlineWeaknessEvidence(weaknessGroups);
    const rankedWeaknessGroups = [...weaknessGroups]
        .sort((a, b) => {
            if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
            if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
            if (b.unansweredCount !== a.unansweredCount) return b.unansweredCount - a.unansweredCount;
            if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
            return a.title.localeCompare(b.title, "ko");
        })
        .slice(0, weaknessLimit);
    const sortedMostMissedQuestions = mostMissedQuestions
        .sort((a, b) => {
            if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
            if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
            if ((b.averageTimeSec || 0) !== (a.averageTimeSec || 0)) return (b.averageTimeSec || 0) - (a.averageTimeSec || 0);
            return a.questionNumber - b.questionNumber;
        })
        .slice(0, weaknessLimit);
    const tagStats = buildQuestionResultTagStats(baseQuestionResults, "label").slice(0, weaknessLimit);
    const elapsedTimes = matchedAttempts.map(attemptElapsedTimeSec).filter(value => value > 0);
    const questionTimes = matchedAttempts
        .flatMap(attempt => attempt.questionTimings || [])
        .map(timing => Math.max(0, timing.totalTimeSec))
        .filter(value => value > 0);
    const totalTrackedTimeSec = questionTimes.reduce((sum, value) => sum + value, 0);
    const focusLossCount = matchedAttempts.reduce((sum, attempt) => (
        sum + resolveAwayCount(attempt)
    ), 0);

    return {
        attempts: attemptInsights.slice(0, recentLimit),
        averageScore,
        bestScore,
        latestScore,
        trendDelta: latestScore === null || previousScore === null ? null : latestScore - previousScore,
        averageElapsedTimeSec: roundedAverage(elapsedTimes),
        averageQuestionTimeSec: roundedAverage(questionTimes),
        totalTrackedTimeSec,
        focusLossCount,
        wrongQuestionCount,
        unansweredQuestionCount,
        handwritingArchiveCount: attemptInsights.filter(attempt => attempt.handwritingArchived).length,
        baseAttemptCount: baseMatchedAttempts.length,
        retakeAttemptCount: retakeMatchedAttempts.length,
        weaknessGroups: rankedWeaknessGroups,
        headlineWeaknessGroups,
        mostMissedQuestions: sortedMostMissedQuestions,
        tagStats,
    };
}
