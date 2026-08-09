import type { Attempt, Exam } from "@/types/omr";
import { buildCanonicalExamDefinitionManifest } from "@/lib/canonicalQuestionResultManifest";
import {
    buildCanonicalAttemptAnalyticsIndex,
    buildClassExamWeaknessMatrix,
    buildExamQuestionPointBiserial,
    buildExamQuestionResultStats,
    buildLearningRecommendations,
    buildRetakeQuestionIds,
    buildSimilarQuestionGroups,
    hasGradableAttemptScore,
    studentScopeKeyForAttempt,
    summarizeAttemptBehavior,
} from "@/lib/premiumAnalytics";
import {
    teacherCanonicalAnalyticsCollectionKey,
    teacherCanonicalAnalyticsEligibleAttempts,
    teacherCanonicalAnalyticsSummaryCollectionKey,
    TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES,
    TEACHER_ANALYTICS_SNAPSHOT_MAX_CLASSES,
    TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS,
    TEACHER_ANALYTICS_SNAPSHOT_MAX_RECOMMENDATIONS,
    TEACHER_ANALYTICS_SNAPSHOT_MAX_STUDENT_ROWS,
    type TeacherCanonicalAnalyticsSnapshot,
    type TeacherCanonicalAnalyticsSnapshotDiagnostics,
    type TeacherCanonicalAnalyticsSnapshotMap,
} from "@/lib/teacherCanonicalAnalyticsSnapshotContract";

const SNAPSHOT_ADVANCED_RESULT_BUDGET = 100_000;
export const TEACHER_CANONICAL_ANALYTICS_RICH_RESULT_LIMIT = SNAPSHOT_ADVANCED_RESULT_BUDGET;
// Per-student CSV rows are linear in attempts × submitted questions. Skip
// materializing them before they can exceed the bounded Flight DTO; profiles
// remain available through their separate on-demand server aggregate action.
const SNAPSHOT_STUDENT_RESULT_BUDGET = 50_000;

function unavailableSnapshot(
    examId: string,
    collectionKey: string,
    summaryCollectionKey: string,
    diagnostics: TeacherCanonicalAnalyticsSnapshotDiagnostics,
): TeacherCanonicalAnalyticsSnapshot {
    return {
        schemaVersion: 1,
        status: "unavailable",
        examId,
        collectionKey,
        summaryCollectionKey,
        diagnostics,
        advancedAggregatesComplete: false,
        studentAggregatesComplete: false,
        questionStats: [],
        pointBiserial: [],
        similarQuestionGroups: [],
        recommendations: [],
        classMatrix: [],
        csvQuestionCohorts: [],
        retakeEligibleCohortKeys: [],
        studentRows: [],
    };
}

/**
 * Over-capacity preflight result. Scalar attempt summaries remain available to
 * the dashboard, while every official per-question surface is explicitly
 * unavailable and no rich result collection is materialized.
 */
export function buildTeacherUnavailableAnalyticsSnapshotMap(
    attempts: readonly Attempt[],
): TeacherCanonicalAnalyticsSnapshotMap {
    const byExam = new Map<string, Attempt[]>();
    for (const attempt of attempts) {
        const bucket = byExam.get(attempt.examId) || [];
        bucket.push(attempt);
        byExam.set(attempt.examId, bucket);
    }
    return Object.fromEntries([...byExam.entries()].map(([examId, scopedAttempts]) => {
        const eligibleAttempts = teacherCanonicalAnalyticsEligibleAttempts(scopedAttempts);
        const canonicalQuestionResultCount = eligibleAttempts.reduce((total, attempt) => (
            total + Number(attempt.questionResultsQuestionCount || 0)
        ), 0);
        const diagnostics: TeacherCanonicalAnalyticsSnapshotDiagnostics = {
            attemptCount: eligibleAttempts.length,
            serverResolutionCount: eligibleAttempts.length,
            canonicalQuestionResultCount,
            clientResolutionCount: 0,
        };
        return [examId, unavailableSnapshot(
            examId,
            teacherCanonicalAnalyticsCollectionKey(examId, scopedAttempts),
            teacherCanonicalAnalyticsSummaryCollectionKey(examId, scopedAttempts),
            diagnostics,
        )];
    }));
}

function resultStatusLabel(status: string): string {
    if (status === "correct") return "O";
    if (status === "wrong") return "X";
    if (status === "unanswered") return "미응답";
    return "미채점";
}

function buildStudentRows(
    exam: Exam,
    attempts: readonly Attempt[],
    index: ReturnType<typeof buildCanonicalAttemptAnalyticsIndex>,
): TeacherCanonicalAnalyticsSnapshot["studentRows"] {
    return attempts.map(attempt => {
        const resolution = index.resolutionFor(attempt);
        const labelScores: Record<string, { earned: number; total: number }> = {};
        const labelOutcomes: Record<string, { correct: number; total: number }> = {};
        for (const result of resolution.questionResults) {
            const label = result.label || "일반";
            const current = labelScores[label] || { earned: 0, total: 0 };
            current.earned += result.earnedScore;
            current.total += result.score;
            labelScores[label] = current;
            if (result.status !== "ungraded") {
                const outcome = labelOutcomes[label] || { correct: 0, total: 0 };
                outcome.total += 1;
                if (result.status === "correct") outcome.correct += 1;
                labelOutcomes[label] = outcome;
            }
        }
        const retakeQuestionIds = buildRetakeQuestionIds(exam, attempt);
        return {
            attemptId: attempt.id,
            studentKey: studentScopeKeyForAttempt(attempt),
            studentName: attempt.studentName,
            groupName: attempt.groupName || null,
            regionName: attempt.regionName || attempt.regionId || null,
            totalScore: resolution.scoreSummary.earnedScore,
            scorePercentage: resolution.scoreSummary.scorePercent,
            hasPerformanceScore: hasGradableAttemptScore(resolution.scoreSummary),
            gradingSource: resolution.source,
            labelScores,
            labelOutcomes,
            behavior: summarizeAttemptBehavior(attempt),
            topWeakness: buildLearningRecommendations(exam, [attempt], {
                scope: "attempt",
                attempt,
                limit: 1,
            }, index)[0] || null,
            retakeQuestionIds,
            retakeCohorts: retakeQuestionIds.map(questionId => ({
                cohortKey: `${attempt.questionResultsDefinitionManifestHash}\u001f${questionId}`,
                definitionManifestHash: attempt.questionResultsDefinitionManifestHash!,
                questionId,
            })),
            questionCsvRows: [
                ["채점 근거", "제출 당시 저장 채점"],
                [],
                ["문항 번호", "라벨(장르)", "배점", "학생 선택", "정답", "정오"],
                ...resolution.questionResults
                    .slice()
                    .sort((left, right) => left.questionNumber - right.questionNumber || left.questionId - right.questionId)
                    .map(result => [
                        result.questionNumber,
                        result.label || "일반",
                        result.score,
                        result.selectedAnswer ?? "-",
                        result.correctAnswer ?? "-",
                        resultStatusLabel(result.status),
                    ]),
                [],
                ["장르별 통계"],
                ["장르", "획득 점수", "만점"],
                ...Object.entries(labelScores).map(([label, score]) => [label, score.earned, score.total]),
            ],
        };
    });
}

/** Server-only builder: verifies every attempt exactly once, then aggregates the shared index. */
export function buildTeacherCanonicalAnalyticsSnapshot(
    exam: Exam,
    attempts: readonly Attempt[],
): TeacherCanonicalAnalyticsSnapshot {
    const scopedAttempts = teacherCanonicalAnalyticsEligibleAttempts(
        attempts.filter(attempt => attempt.examId === exam.id),
    );
    const collectionKey = teacherCanonicalAnalyticsCollectionKey(exam.id, scopedAttempts);
    const summaryCollectionKey = teacherCanonicalAnalyticsSummaryCollectionKey(exam.id, scopedAttempts);
    const index = buildCanonicalAttemptAnalyticsIndex(exam, scopedAttempts);
    const diagnostics: TeacherCanonicalAnalyticsSnapshotDiagnostics = {
        attemptCount: scopedAttempts.length,
        serverResolutionCount: index.diagnostics.resolutionCount,
        canonicalQuestionResultCount: index.diagnostics.canonicalQuestionResultCount,
        clientResolutionCount: 0,
    };
    if (scopedAttempts.some(attempt => index.resolutionFor(attempt).source !== "canonical_submission")) {
        return unavailableSnapshot(exam.id, collectionKey, summaryCollectionKey, diagnostics);
    }
    const questionStats = buildExamQuestionResultStats(exam, scopedAttempts, index);
    if (questionStats.length > TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS) {
        return unavailableSnapshot(exam.id, collectionKey, summaryCollectionKey, diagnostics);
    }
    const advancedAggregatesComplete = index.diagnostics.canonicalQuestionResultCount <= SNAPSHOT_ADVANCED_RESULT_BUDGET;
    let currentDefinitionManifestHash: string | null = null;
    try {
        currentDefinitionManifestHash = buildCanonicalExamDefinitionManifest(exam).questionResultsDefinitionManifestHash;
    } catch {
        currentDefinitionManifestHash = null;
    }
    const studentAggregatesComplete = scopedAttempts.length <= TEACHER_ANALYTICS_SNAPSHOT_MAX_STUDENT_ROWS
        && index.diagnostics.canonicalQuestionResultCount <= SNAPSHOT_STUDENT_RESULT_BUDGET;
    const studentRows = studentAggregatesComplete
        ? buildStudentRows(exam, scopedAttempts, index)
        : [];
    const snapshot: TeacherCanonicalAnalyticsSnapshot = {
        schemaVersion: 1,
        status: "ready",
        examId: exam.id,
        collectionKey,
        summaryCollectionKey,
        diagnostics,
        advancedAggregatesComplete,
        studentAggregatesComplete,
        questionStats,
        pointBiserial: [...buildExamQuestionPointBiserial(exam, scopedAttempts, index).entries()],
        similarQuestionGroups: advancedAggregatesComplete
            ? buildSimilarQuestionGroups(exam, scopedAttempts, index).slice(0, TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS)
            : [],
        recommendations: advancedAggregatesComplete
            ? buildLearningRecommendations(exam, scopedAttempts, {
                scope: "exam",
                limit: TEACHER_ANALYTICS_SNAPSHOT_MAX_RECOMMENDATIONS,
            }, index)
            : [],
        classMatrix: advancedAggregatesComplete
            ? buildClassExamWeaknessMatrix(exam, scopedAttempts, {
                classLimit: TEACHER_ANALYTICS_SNAPSHOT_MAX_CLASSES,
                recommendationLimit: 5,
            }, index)
            : [],
        csvQuestionCohorts: questionStats,
        retakeEligibleCohortKeys: currentDefinitionManifestHash
            ? questionStats.filter(stat => stat.definitionManifestHash === currentDefinitionManifestHash
                && exam.questions.some(question => question.id === stat.questionId)).map(stat => stat.cohortKey)
            : [],
        studentRows,
    };
    const serialized = JSON.stringify(snapshot);
    if (new TextEncoder().encode(serialized).byteLength <= TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES) {
        return JSON.parse(serialized) as TeacherCanonicalAnalyticsSnapshot;
    }
    const bounded = { ...snapshot, studentAggregatesComplete: false, studentRows: [] };
    const boundedSerialized = JSON.stringify(bounded);
    return new TextEncoder().encode(boundedSerialized).byteLength <= TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES
        ? JSON.parse(boundedSerialized) as TeacherCanonicalAnalyticsSnapshot
        : unavailableSnapshot(exam.id, collectionKey, summaryCollectionKey, diagnostics);
}

export function buildTeacherCanonicalAnalyticsSnapshotMap(
    exams: readonly Exam[],
    attempts: readonly Attempt[],
): TeacherCanonicalAnalyticsSnapshotMap {
    const byExam = new Map<string, Attempt[]>();
    for (const attempt of attempts) {
        const bucket = byExam.get(attempt.examId) || [];
        bucket.push(attempt);
        byExam.set(attempt.examId, bucket);
    }
    const examById = new Map(exams.map(exam => [exam.id, exam]));
    return Object.fromEntries([...byExam.entries()].flatMap(([examId, scopedAttempts]) => {
        const exam = examById.get(examId);
        return exam ? [[examId, buildTeacherCanonicalAnalyticsSnapshot(exam, scopedAttempts)]] : [];
    }));
}
