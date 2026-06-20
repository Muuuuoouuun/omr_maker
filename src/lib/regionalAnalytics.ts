import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import { baseAttemptsOnly, resolveAttemptScore, retakeAttemptsOnly } from "@/lib/attemptScores";
import {
    buildLearningRecommendations,
    getAttemptQuestionResults,
    studentScopeKeyForAttempt,
    type LearningRecommendation,
    type LearningRecommendationSeverity,
    type QuestionResultGroupKind,
} from "@/lib/premiumAnalytics";
import { attemptMatchesStudentProfile } from "@/utils/storage";

export const DEFAULT_REGION_NAME = "미분류 지역";

export interface RegionalLearningScope {
    regionKey: string;
    regionName: string;
    studentCount: number;
    groupCount: number;
    attemptCount: number;
    retakeAttemptCount: number;
    examCount: number;
    averageScore: number;
    groupNames: string[];
}

export interface RegionalLearningScopeOptions {
    includeRetakes?: boolean;
}

export interface RegionalExamActionInsight {
    examId: string;
    examTitle: string;
    attemptCount: number;
    studentCount: number;
    averageScore: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    topRecommendation?: LearningRecommendation;
}

export interface RegionalStudentRiskInsight {
    key: string;
    name: string;
    groupName?: string;
    attemptCount: number;
    averageScore: number;
    latestScore: number;
    trendDelta: number;
    reason: string;
}

export interface RegionalActionPlan extends RegionalLearningScope {
    activeStudentCount: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    severity: LearningRecommendationSeverity;
    priorityScore: number;
    recommendedAction: string;
    exams: RegionalExamActionInsight[];
    recommendations: LearningRecommendation[];
    studentsNeedingAttention: RegionalStudentRiskInsight[];
}

export interface RegionalActionPlanOptions {
    regionLimit?: number;
    examLimit?: number;
    recommendationLimit?: number;
    riskLimit?: number;
    weaknessKinds?: QuestionResultGroupKind[];
    includeRetakes?: boolean;
}

interface RegionAccumulator {
    regionName: string;
    studentKeys: Set<string>;
    groupKeys: Set<string>;
    groupNames: Set<string>;
    examIds: Set<string>;
    scores: number[];
    attemptCount: number;
    retakeAttemptCount: number;
}

function clean(value: string | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}

export function regionKeyFor(value: string | undefined): string {
    const name = clean(value) || DEFAULT_REGION_NAME;
    return name.toLocaleLowerCase("ko-KR");
}

export function regionNameForStudent(student: Pick<RosterStudent, "region">): string {
    return clean(student.region) || DEFAULT_REGION_NAME;
}

export function regionNameForGroup(
    group: RosterGroup,
    students: RosterStudent[],
): string {
    const explicit = clean(group.region);
    if (explicit) return explicit;
    const matchingStudent = students.find(student => student.group === group.name);
    return matchingStudent ? regionNameForStudent(matchingStudent) : DEFAULT_REGION_NAME;
}

function groupMatchesAttempt(group: RosterGroup, attempt: Attempt): boolean {
    const groupRegion = clean(group.region);
    const attemptRegion = clean(attempt.regionName) || clean(attempt.regionId);
    if (groupRegion && attemptRegion && groupRegion !== attemptRegion) return false;

    return (!!attempt.groupId && attempt.groupId === group.id)
        || (!!attempt.groupName && attempt.groupName === group.name);
}

function groupMatchesStudent(group: RosterGroup, student: RosterStudent): boolean {
    return rosterGroupMatchesStudent(group, student);
}

function findRosterStudent(attempt: Attempt, students: RosterStudent[]): RosterStudent | undefined {
    return students.find(student => attemptMatchesStudentProfile(attempt, student));
}

function findRosterGroup(
    attempt: Attempt,
    student: RosterStudent | undefined,
    groups: RosterGroup[],
): RosterGroup | undefined {
    return (student ? groups.find(group => groupMatchesStudent(group, student)) : undefined)
        || groups.find(group => groupMatchesAttempt(group, attempt));
}

export function regionNameForAttempt(
    attempt: Attempt,
    students: RosterStudent[],
    groups: RosterGroup[],
): string {
    const explicit = clean(attempt.regionName) || clean(attempt.regionId);
    if (explicit) return explicit;

    const student = findRosterStudent(attempt, students);
    if (student?.region) return regionNameForStudent(student);

    const group = findRosterGroup(attempt, student, groups);
    return group ? regionNameForGroup(group, students) : DEFAULT_REGION_NAME;
}

export function attemptMatchesRegion(
    attempt: Attempt,
    regionKey: string,
    students: RosterStudent[],
    groups: RosterGroup[],
): boolean {
    return regionKeyFor(regionNameForAttempt(attempt, students, groups)) === regionKey;
}

export function filterAttemptsByRegion(
    attempts: Attempt[],
    regionKey: string,
    students: RosterStudent[],
    groups: RosterGroup[],
): Attempt[] {
    return attempts.filter(attempt => attemptMatchesRegion(attempt, regionKey, students, groups));
}

function ensureRegion(
    map: Map<string, RegionAccumulator>,
    regionName: string,
): RegionAccumulator {
    const safeName = clean(regionName) || DEFAULT_REGION_NAME;
    const key = regionKeyFor(safeName);
    const existing = map.get(key);
    if (existing) return existing;

    const created: RegionAccumulator = {
        regionName: safeName,
        studentKeys: new Set(),
        groupKeys: new Set(),
        groupNames: new Set(),
        examIds: new Set(),
        scores: [],
        attemptCount: 0,
        retakeAttemptCount: 0,
    };
    map.set(key, created);
    return created;
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function activityTime(attempt: Attempt): number {
    return Date.parse(attempt.finishedAt || attempt.startedAt || "") || 0;
}

function isWrongResult(result: { status: string; isWrong?: boolean }): boolean {
    return result.status === "wrong" || !!result.isWrong;
}

function isUnansweredResult(result: { status: string; isUnanswered?: boolean }): boolean {
    return result.status === "unanswered" || !!result.isUnanswered;
}

function sortRecommendations(items: LearningRecommendation[]): LearningRecommendation[] {
    return [...items].sort((a, b) => {
        if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        return a.title.localeCompare(b.title, "ko");
    });
}

function severityForRegion(params: {
    averageScore: number;
    wrongQuestionCount: number;
    studentsNeedingAttention: number;
    topRecommendation?: LearningRecommendation;
}): LearningRecommendationSeverity {
    if (params.averageScore > 0 && params.averageScore < 65) return "urgent";
    if (params.topRecommendation?.severity === "urgent") return "urgent";
    if (params.wrongQuestionCount >= 8 || params.studentsNeedingAttention >= 3) return "urgent";
    if (params.averageScore > 0 && params.averageScore < 78) return "review";
    if (params.topRecommendation?.severity === "review") return "review";
    if (params.wrongQuestionCount > 0 || params.studentsNeedingAttention > 0) return "review";
    return "watch";
}

function priorityForRegion(params: {
    averageScore: number;
    attemptCount: number;
    wrongQuestionCount: number;
    unansweredQuestionCount: number;
    studentsNeedingAttention: number;
    topRecommendation?: LearningRecommendation;
}): number {
    const scoreRisk = params.averageScore > 0 ? Math.max(0, 100 - params.averageScore) : 0;
    return Math.round(
        scoreRisk * 2
        + params.wrongQuestionCount * 5
        + params.unansweredQuestionCount * 3
        + params.studentsNeedingAttention * 8
        + params.attemptCount
        + (params.topRecommendation?.priorityScore || 0) / 10
    );
}

function actionForRegion(regionName: string, recommendation: LearningRecommendation | undefined, riskCount: number): string {
    if (recommendation) {
        return `${regionName} ${recommendation.basis} "${recommendation.title}" ${recommendation.retakeQuestionIds.length}문항 재추천`;
    }
    if (riskCount > 0) return `${regionName} 주의 학생 ${riskCount}명 개별 점검`;
    return `${regionName} 추가 조치 없음`;
}

function riskReason(latestScore: number, averageScore: number, trendDelta: number): string {
    if (latestScore < 60) return "최근 점수 60점 미만";
    if (averageScore < 70) return "평균 70점 미만";
    if (trendDelta <= -8) return "최근 점수 하락";
    return "점검 필요";
}

export function buildRegionalLearningScopes(params: {
    students: RosterStudent[];
    groups: RosterGroup[];
    attempts: Attempt[];
    exams: Exam[];
    options?: RegionalLearningScopeOptions;
}): RegionalLearningScope[] {
    const regions = new Map<string, RegionAccumulator>();
    const examById = new Map(params.exams.map(exam => [exam.id, exam]));
    const scopedAttempts = params.options?.includeRetakes
        ? params.attempts
        : baseAttemptsOnly(params.attempts);

    for (const group of params.groups) {
        const region = ensureRegion(regions, regionNameForGroup(group, params.students));
        region.groupKeys.add(group.name);
        region.groupNames.add(group.name);
    }

    for (const student of params.students) {
        const region = ensureRegion(regions, regionNameForStudent(student));
        region.studentKeys.add(student.id);
        if (student.group) region.groupKeys.add(student.group);
        region.groupNames.add(student.group);
    }

    for (const attempt of retakeAttemptsOnly(params.attempts)) {
        const region = ensureRegion(regions, regionNameForAttempt(attempt, params.students, params.groups));
        region.retakeAttemptCount += 1;
    }

    for (const attempt of scopedAttempts) {
        const student = findRosterStudent(attempt, params.students);
        const group = findRosterGroup(attempt, student, params.groups);
        const region = ensureRegion(regions, regionNameForAttempt(attempt, params.students, params.groups));
        const studentKey = student?.id || studentScopeKeyForAttempt(attempt);

        region.attemptCount += 1;
        if (studentKey) region.studentKeys.add(studentKey);
        if (attempt.examId) region.examIds.add(attempt.examId);
        if (group) {
            region.groupKeys.add(group.name);
            region.groupNames.add(group.name);
        } else if (attempt.groupName || attempt.groupId) {
            region.groupKeys.add(attempt.groupId || attempt.groupName || "");
            region.groupNames.add(attempt.groupName || attempt.groupId || "");
        }
        region.scores.push(resolveAttemptScore(attempt, examById.get(attempt.examId)).scorePercent);
    }

    return Array.from(regions.entries())
        .map(([regionKey, region]) => ({
            regionKey,
            regionName: region.regionName,
            studentCount: region.studentKeys.size,
            groupCount: region.groupKeys.size,
            attemptCount: region.attemptCount,
            retakeAttemptCount: region.retakeAttemptCount,
            examCount: region.examIds.size,
            averageScore: average(region.scores),
            groupNames: Array.from(region.groupNames)
                .filter(Boolean)
                .sort((a, b) => a.localeCompare(b, "ko")),
        }))
        .sort((a, b) => {
            if (b.attemptCount !== a.attemptCount) return b.attemptCount - a.attemptCount;
            if (b.studentCount !== a.studentCount) return b.studentCount - a.studentCount;
            return a.regionName.localeCompare(b.regionName, "ko");
        });
}

export function buildRegionalActionPlans(params: {
    students: RosterStudent[];
    groups: RosterGroup[];
    attempts: Attempt[];
    exams: Exam[];
    options?: RegionalActionPlanOptions;
}): RegionalActionPlan[] {
    const options = params.options || {};
    const regionLimit = Math.max(1, options.regionLimit ?? 8);
    const examLimit = Math.max(1, options.examLimit ?? 4);
    const recommendationLimit = Math.max(1, options.recommendationLimit ?? 4);
    const riskLimit = Math.max(1, options.riskLimit ?? 5);
    const examById = new Map(params.exams.map(exam => [exam.id, exam]));
    const scopes = buildRegionalLearningScopes(params);
    const scopedAttempts = options.includeRetakes
        ? params.attempts
        : baseAttemptsOnly(params.attempts);
    const attemptsByRegion = new Map<string, Attempt[]>();

    for (const attempt of scopedAttempts) {
        const regionName = regionNameForAttempt(attempt, params.students, params.groups);
        const regionKey = regionKeyFor(regionName);
        attemptsByRegion.set(regionKey, [...(attemptsByRegion.get(regionKey) || []), attempt]);
    }

    return scopes.map(scope => {
        const regionAttempts = (attemptsByRegion.get(scope.regionKey) || [])
            .sort((a, b) => activityTime(b) - activityTime(a));
        const activeStudentKeys = new Set(regionAttempts.map(studentScopeKeyForAttempt).filter(Boolean));
        const attemptsByExam = new Map<string, Attempt[]>();
        for (const attempt of regionAttempts) {
            if (!examById.has(attempt.examId)) continue;
            attemptsByExam.set(attempt.examId, [...(attemptsByExam.get(attempt.examId) || []), attempt]);
        }

        let wrongQuestionCount = 0;
        let unansweredQuestionCount = 0;
        const recommendations: LearningRecommendation[] = [];
        const exams: RegionalExamActionInsight[] = [];

        for (const [examId, examAttempts] of attemptsByExam.entries()) {
            const exam = examById.get(examId);
            if (!exam) continue;

            const results = examAttempts.flatMap(attempt => getAttemptQuestionResults(exam, attempt));
            const examWrongCount = results.filter(isWrongResult).length;
            const examUnansweredCount = results.filter(isUnansweredResult).length;
            const examScores = examAttempts.map(attempt => resolveAttemptScore(attempt, exam).scorePercent);
            const examRecommendations = buildLearningRecommendations(exam, examAttempts, {
                scope: "exam",
                kinds: options.weaknessKinds,
                includeRetakes: options.includeRetakes,
                limit: recommendationLimit,
            });
            const studentKeys = new Set(examAttempts.map(studentScopeKeyForAttempt).filter(Boolean));

            wrongQuestionCount += examWrongCount;
            unansweredQuestionCount += examUnansweredCount;
            recommendations.push(...examRecommendations);
            exams.push({
                examId,
                examTitle: exam.title,
                attemptCount: examAttempts.length,
                studentCount: studentKeys.size,
                averageScore: average(examScores),
                wrongQuestionCount: examWrongCount,
                unansweredQuestionCount: examUnansweredCount,
                topRecommendation: examRecommendations[0],
            });
        }

        const attemptsByStudent = new Map<string, Attempt[]>();
        for (const attempt of regionAttempts) {
            const key = studentScopeKeyForAttempt(attempt);
            if (!key) continue;
            attemptsByStudent.set(key, [...(attemptsByStudent.get(key) || []), attempt]);
        }

        const studentsNeedingAttention = Array.from(attemptsByStudent.entries())
            .map(([key, studentAttempts]) => {
                const ordered = [...studentAttempts].sort((a, b) => activityTime(b) - activityTime(a));
                const scores = ordered.map(attempt => resolveAttemptScore(attempt, examById.get(attempt.examId)).scorePercent);
                const latestScore = scores[0] ?? 0;
                const previousScore = scores[1] ?? latestScore;
                const averageScore = average(scores);
                return {
                    key,
                    name: ordered[0]?.studentName || key,
                    groupName: ordered[0]?.groupName,
                    attemptCount: ordered.length,
                    averageScore,
                    latestScore,
                    trendDelta: latestScore - previousScore,
                    reason: riskReason(latestScore, averageScore, latestScore - previousScore),
                };
            })
            .filter(student => student.latestScore < 70 || student.averageScore < 70 || student.trendDelta <= -8)
            .sort((a, b) => {
                if (a.latestScore !== b.latestScore) return a.latestScore - b.latestScore;
                if (a.averageScore !== b.averageScore) return a.averageScore - b.averageScore;
                return a.name.localeCompare(b.name, "ko");
            })
            .slice(0, riskLimit);

        const topRecommendations = sortRecommendations(recommendations).slice(0, recommendationLimit);
        const topRecommendation = topRecommendations[0];
        const severity = severityForRegion({
            averageScore: scope.averageScore,
            wrongQuestionCount,
            studentsNeedingAttention: studentsNeedingAttention.length,
            topRecommendation,
        });
        const priorityScore = priorityForRegion({
            averageScore: scope.averageScore,
            attemptCount: scope.attemptCount,
            wrongQuestionCount,
            unansweredQuestionCount,
            studentsNeedingAttention: studentsNeedingAttention.length,
            topRecommendation,
        });

        return {
            ...scope,
            activeStudentCount: activeStudentKeys.size,
            wrongQuestionCount,
            unansweredQuestionCount,
            severity,
            priorityScore,
            recommendedAction: actionForRegion(scope.regionName, topRecommendation, studentsNeedingAttention.length),
            exams: exams
                .sort((a, b) => {
                    const aLatest = Math.max(...(attemptsByExam.get(a.examId) || []).map(activityTime));
                    const bLatest = Math.max(...(attemptsByExam.get(b.examId) || []).map(activityTime));
                    return bLatest - aLatest;
                })
                .slice(0, examLimit),
            recommendations: topRecommendations,
            studentsNeedingAttention,
        };
    })
        .sort((a, b) => {
            if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
            if (b.attemptCount !== a.attemptCount) return b.attemptCount - a.attemptCount;
            return a.regionName.localeCompare(b.regionName, "ko");
        })
        .slice(0, regionLimit);
}
