import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import { baseAttemptsOnly, resolveAttemptScore, retakeAttemptsOnly } from "@/lib/attemptScores";
import {
    attemptElapsedTimeSec,
    buildMostMissedQuestionStats,
    buildLearningRecommendations,
    buildQuestionResultTagStats,
    getAttemptQuestionResults,
    studentScopeKeyForAttempt,
    type LearningRecommendationSeverity,
    type QuestionResultTagStat,
    type QuestionResultGroupKind,
} from "@/lib/premiumAnalytics";
import { attemptMatchesStudentProfile } from "@/utils/storage";

const DEFAULT_WEAKNESS_KINDS: QuestionResultGroupKind[] = ["concept", "mistakeType", "unit"];

export interface GroupProfileWeaknessInsight {
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

export interface GroupExamInsight {
    examId: string;
    examTitle: string;
    attemptCount: number;
    studentCount: number;
    averageScore: number;
    averageElapsedTimeSec: number;
    averageQuestionTimeSec: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    topWeakness?: GroupProfileWeaknessInsight;
}

export interface GroupStudentRiskInsight {
    key: string;
    name: string;
    attemptCount: number;
    averageScore: number;
    latestScore: number;
    trendDelta: number;
}

export interface GroupMissedQuestionInsight {
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

export type GroupTagInsight = QuestionResultTagStat;

export interface GroupProfileInsight {
    groupId: string;
    groupName: string;
    rosterStudentCount: number;
    attemptCount: number;
    retakeAttemptCount: number;
    examCount: number;
    activeStudentCount: number;
    averageScore: number;
    averageElapsedTimeSec: number;
    averageQuestionTimeSec: number;
    totalTrackedTimeSec: number;
    focusLossCount: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    handwritingArchiveCount: number;
    handwritingArchiveRate: number;
    exams: GroupExamInsight[];
    weaknessGroups: GroupProfileWeaknessInsight[];
    mostMissedQuestions: GroupMissedQuestionInsight[];
    tagStats: GroupTagInsight[];
    studentsNeedingAttention: GroupStudentRiskInsight[];
}

export interface GroupProfileInsightOptions {
    examLimit?: number;
    weaknessLimit?: number;
    riskLimit?: number;
    weaknessKinds?: QuestionResultGroupKind[];
}

function activityTime(attempt: Attempt): number {
    return Date.parse(attempt.finishedAt || attempt.startedAt || "") || 0;
}

function studentBelongsToGroup(student: RosterStudent, group: RosterGroup): boolean {
    return rosterGroupMatchesStudent(group, student);
}

function matchesGroupSnapshot(attempt: Attempt, group: RosterGroup): boolean {
    const keys = new Set([group.id, group.name].filter(Boolean));
    const groupRegion = group.region?.trim() || "";
    const attemptRegion = attempt.regionName?.trim() || attempt.regionId?.trim() || "";
    if (groupRegion && attemptRegion && groupRegion !== attemptRegion) return false;

    return (!!attempt.groupId && keys.has(attempt.groupId))
        || (!!attempt.groupName && keys.has(attempt.groupName));
}

function matchedRosterStudent(attempt: Attempt, rosterStudents: RosterStudent[]): RosterStudent | undefined {
    return rosterStudents.find(student => attemptMatchesStudentProfile(attempt, student));
}

function normalizeAttemptForGroup(
    attempt: Attempt,
    group: RosterGroup,
    rosterStudents: RosterStudent[],
): Attempt {
    const student = matchedRosterStudent(attempt, rosterStudents);
    const nextStudentId = student?.id || attempt.studentId;
    const nextStudentName = student?.name || attempt.studentName;
    const nextGroupId = attempt.groupId || group.id;
    const nextGroupName = attempt.groupName || group.name;

    if (
        nextStudentId === attempt.studentId
        && nextStudentName === attempt.studentName
        && nextGroupId === attempt.groupId
        && nextGroupName === attempt.groupName
    ) {
        return attempt;
    }

    return {
        ...attempt,
        studentId: nextStudentId,
        studentName: nextStudentName,
        groupId: nextGroupId,
        groupName: nextGroupName,
    };
}

function matchesGroup(attempt: Attempt, group: RosterGroup, rosterStudents: RosterStudent[]): boolean {
    const student = matchedRosterStudent(attempt, rosterStudents);
    return (!!student && studentBelongsToGroup(student, group)) || matchesGroupSnapshot(attempt, group);
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function sortWeaknessGroups(groups: GroupProfileWeaknessInsight[]): GroupProfileWeaknessInsight[] {
    const kindRank: Record<QuestionResultGroupKind, number> = {
        concept: 0,
        mistakeType: 1,
        unit: 2,
        source: 3,
        skill: 4,
        difficulty: 5,
        label: 6,
    };

    return [...groups].sort((a, b) => {
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        if (b.unansweredCount !== a.unansweredCount) return b.unansweredCount - a.unansweredCount;
        if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
        return a.title.localeCompare(b.title, "ko");
    });
}

function buildWeaknessInsights(
    exam: Exam,
    attempts: Attempt[],
    weaknessKinds: QuestionResultGroupKind[],
): GroupProfileWeaknessInsight[] {
    const sourceAttempt = attempts[0];
    return sortWeaknessGroups(buildLearningRecommendations(exam, attempts, {
        scope: "class",
        attempt: sourceAttempt,
        kinds: weaknessKinds,
    }).map(recommendation => ({
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
    })));
}

export function buildGroupProfileInsight(
    group: RosterGroup,
    students: RosterStudent[],
    attempts: Attempt[],
    examById: Map<string, Exam>,
    options: GroupProfileInsightOptions = {},
): GroupProfileInsight {
    const examLimit = Math.max(1, options.examLimit ?? 6);
    const weaknessLimit = Math.max(1, options.weaknessLimit ?? 6);
    const riskLimit = Math.max(1, options.riskLimit ?? 5);
    const weaknessKinds = options.weaknessKinds?.length ? options.weaknessKinds : DEFAULT_WEAKNESS_KINDS;

    const rosterStudents = students.filter(student => studentBelongsToGroup(student, group));
    const groupAttempts = attempts
        .filter(attempt => matchesGroup(attempt, group, rosterStudents))
        .map(attempt => normalizeAttemptForGroup(attempt, group, rosterStudents))
        .sort((a, b) => activityTime(b) - activityTime(a));
    const baseGroupAttempts = baseAttemptsOnly(groupAttempts);
    const retakeGroupAttempts = retakeAttemptsOnly(groupAttempts);
    const scores = baseGroupAttempts.map(attempt => resolveAttemptScore(attempt, examById.get(attempt.examId)).scorePercent);
    const activeStudentKeys = new Set(baseGroupAttempts.map(studentScopeKeyForAttempt).filter(Boolean));

    const attemptsByExam = new Map<string, Attempt[]>();
    for (const attempt of baseGroupAttempts) {
        if (!examById.has(attempt.examId)) continue;
        attemptsByExam.set(attempt.examId, [...(attemptsByExam.get(attempt.examId) || []), attempt]);
    }

    const weaknessGroups: GroupProfileWeaknessInsight[] = [];
    const mostMissedQuestions: GroupMissedQuestionInsight[] = [];
    const baseQuestionResults: QuestionResult[] = [];
    const exams: GroupExamInsight[] = [];
    let wrongQuestionCount = 0;
    let unansweredQuestionCount = 0;

    for (const [examId, examAttempts] of attemptsByExam.entries()) {
        const exam = examById.get(examId);
        if (!exam) continue;
        const results = examAttempts.flatMap(attempt => getAttemptQuestionResults(exam, attempt));
        const examScores = examAttempts.map(attempt => resolveAttemptScore(attempt, exam).scorePercent);
        const examElapsedTimes = examAttempts.map(attemptElapsedTimeSec).filter(value => value > 0);
        const examQuestionTimes = examAttempts
            .flatMap(attempt => attempt.questionTimings || [])
            .map(timing => Math.max(0, timing.totalTimeSec))
            .filter(value => value > 0);
        const examWeaknesses = buildWeaknessInsights(exam, examAttempts, weaknessKinds);
        const examWrong = results.filter(result => result.status === "wrong" || result.isWrong).length;
        const examUnanswered = results.filter(result => result.status === "unanswered" || result.isUnanswered).length;
        const studentKeys = new Set(examAttempts.map(studentScopeKeyForAttempt).filter(Boolean));

        baseQuestionResults.push(...results);
        wrongQuestionCount += examWrong;
        unansweredQuestionCount += examUnanswered;
        weaknessGroups.push(...examWeaknesses);
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
        exams.push({
            examId,
            examTitle: exam.title,
            attemptCount: examAttempts.length,
            studentCount: studentKeys.size,
            averageScore: average(examScores),
            averageElapsedTimeSec: average(examElapsedTimes),
            averageQuestionTimeSec: average(examQuestionTimes),
            wrongQuestionCount: examWrong,
            unansweredQuestionCount: examUnanswered,
            topWeakness: examWeaknesses[0],
        });
    }

    const attemptsByStudent = new Map<string, Attempt[]>();
    for (const attempt of baseGroupAttempts) {
        const key = studentScopeKeyForAttempt(attempt);
        if (!key) continue;
        attemptsByStudent.set(key, [...(attemptsByStudent.get(key) || []), attempt]);
    }

    const studentsNeedingAttention = Array.from(attemptsByStudent.entries())
        .map(([key, studentAttempts]) => {
            const ordered = [...studentAttempts].sort((a, b) => activityTime(b) - activityTime(a));
            const studentScores = ordered.map(attempt => resolveAttemptScore(attempt, examById.get(attempt.examId)).scorePercent);
            const latestScore = studentScores[0] ?? 0;
            const previousScore = studentScores[1] ?? latestScore;
            return {
                key,
                name: ordered[0]?.studentName || key,
                attemptCount: ordered.length,
                averageScore: average(studentScores),
                latestScore,
                trendDelta: latestScore - previousScore,
            };
        })
        .filter(student => student.averageScore < 70 || student.latestScore < 70 || student.trendDelta <= -8)
        .sort((a, b) => {
            if (a.latestScore !== b.latestScore) return a.latestScore - b.latestScore;
            return a.averageScore - b.averageScore;
        })
        .slice(0, riskLimit);
    const elapsedTimes = baseGroupAttempts.map(attemptElapsedTimeSec).filter(value => value > 0);
    const questionTimes = baseGroupAttempts
        .flatMap(attempt => attempt.questionTimings || [])
        .map(timing => Math.max(0, timing.totalTimeSec))
        .filter(value => value > 0);
    const totalTrackedTimeSec = questionTimes.reduce((sum, value) => sum + value, 0);
    const focusLossCount = baseGroupAttempts.reduce((sum, attempt) => (
        sum + (attempt.focusLossEvents?.length || attempt.tabFociLostCount || 0)
    ), 0);
    const handwritingArchiveCount = baseGroupAttempts.filter(attempt => (
        !!attempt.handwritingArchived && !!(attempt.handwriting?.strokesRef || attempt.drawingsRef)
    )).length;
    const sortedMostMissedQuestions = mostMissedQuestions
        .sort((a, b) => {
            if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
            if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
            if ((b.averageTimeSec || 0) !== (a.averageTimeSec || 0)) return (b.averageTimeSec || 0) - (a.averageTimeSec || 0);
            return a.questionNumber - b.questionNumber;
        })
        .slice(0, weaknessLimit);
    const tagStats = buildQuestionResultTagStats(baseQuestionResults, "label").slice(0, weaknessLimit);

    return {
        groupId: group.id,
        groupName: group.name,
        rosterStudentCount: rosterStudents.length,
        attemptCount: baseGroupAttempts.length,
        retakeAttemptCount: retakeGroupAttempts.length,
        examCount: attemptsByExam.size,
        activeStudentCount: activeStudentKeys.size,
        averageScore: average(scores),
        averageElapsedTimeSec: average(elapsedTimes),
        averageQuestionTimeSec: average(questionTimes),
        totalTrackedTimeSec,
        focusLossCount,
        wrongQuestionCount,
        unansweredQuestionCount,
        handwritingArchiveCount,
        handwritingArchiveRate: baseGroupAttempts.length > 0 ? Math.round((handwritingArchiveCount / baseGroupAttempts.length) * 100) : 0,
        exams: exams
            .sort((a, b) => {
                const aLatest = Math.max(...(attemptsByExam.get(a.examId) || []).map(activityTime));
                const bLatest = Math.max(...(attemptsByExam.get(b.examId) || []).map(activityTime));
                return bLatest - aLatest;
            })
            .slice(0, examLimit),
        weaknessGroups: sortWeaknessGroups(weaknessGroups).slice(0, weaknessLimit),
        mostMissedQuestions: sortedMostMissedQuestions,
        tagStats,
        studentsNeedingAttention,
    };
}
