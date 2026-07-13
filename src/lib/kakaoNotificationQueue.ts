import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import { buildClassExamWeaknessMatrix, buildLearningRecommendations, formatParticipationRateLabel } from "@/lib/premiumAnalytics";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { formatRegionScopedLabel } from "@/lib/dashboardSelection";
import { attemptMatchesStudentProfile } from "@/utils/storage";

export type KakaoNotificationCandidateKind = "missing_exam" | "retake_recommendation" | "class_retake_recommendation";

export interface KakaoNotificationCandidate {
    id: string;
    kind: KakaoNotificationCandidateKind;
    channel: "kakao";
    status: "candidate";
    title: string;
    message: string;
    href: string;
    examId: string;
    examTitle: string;
    targetCount: number;
    studentIds: string[];
    studentNames: string[];
    groupNames: string[];
    regionNames: string[];
    reason: string;
}

export interface KakaoNotificationQueueSummary {
    candidates: KakaoNotificationCandidate[];
    totalCount: number;
    missingExamCount: number;
    retakeRecommendationCount: number;
    classRetakeRecommendationCount: number;
    targetStudentCount: number;
}

interface QueueParams {
    exams: Exam[];
    attempts: Attempt[];
    students: RosterStudent[];
    groups: RosterGroup[];
    now?: Date;
    limit?: number;
}

function clean(value: string | undefined): string {
    return value?.trim() || "";
}

function examHasStarted(exam: Exam, now: Date): boolean {
    if (!exam.startAt) return true;
    const start = Date.parse(exam.startAt);
    return Number.isNaN(start) || start <= now.getTime();
}

function groupKeysForExam(exam: Exam): Set<string> {
    if (exam.accessConfig?.type !== "group") return new Set();
    return new Set((exam.accessConfig.groupIds || []).map(clean).filter(Boolean));
}

function groupKeys(group: RosterGroup): Set<string> {
    return new Set([group.id, group.name].map(clean).filter(Boolean));
}

function studentGroupKeys(student: RosterStudent): Set<string> {
    const scopedPrefix = student.id.includes("::") ? clean(student.id.split("::")[0]) : "";
    return new Set([student.group, scopedPrefix].map(clean).filter(Boolean));
}

function groupNameForKey(key: string, groups: RosterGroup[]): string {
    const group = groups.find(item => item.id === key || item.name === key);
    return group?.name || key;
}

function regionForStudent(student: RosterStudent, groups: RosterGroup[]): string {
    const explicit = clean(student.region);
    if (explicit) return explicit;
    const group = groups.find(item => item.name === student.group || item.id === student.group);
    return clean(group?.region);
}

function selectedGroupKeySetsForExam(exam: Exam, groups: RosterGroup[]): Set<string>[] {
    const selected = groupKeysForExam(exam);
    if (selected.size === 0) return [];

    return [...selected].flatMap(groupKey => {
        const group = groups.find(item => item.id === groupKey || item.name === groupKey);
        return group ? [] : [new Set([groupKey])];
    });
}

function selectedGroupsForExam(exam: Exam, groups: RosterGroup[]): RosterGroup[] {
    const selected = groupKeysForExam(exam);
    if (selected.size === 0) return [];

    return [...selected]
        .map(groupKey => groups.find(item => item.id === groupKey || item.name === groupKey))
        .filter((group): group is RosterGroup => !!group);
}

function eligibleStudentsForExam(exam: Exam, students: RosterStudent[], groups: RosterGroup[]): RosterStudent[] {
    const selectedGroupKeySets = selectedGroupKeySetsForExam(exam, groups);
    const selectedGroups = selectedGroupsForExam(exam, groups);
    if (selectedGroupKeySets.length === 0 && selectedGroups.length === 0) return [];

    return students.filter(student => {
        if (selectedGroups.some(group => rosterGroupMatchesStudent(group, student))) return true;
        const keys = studentGroupKeys(student);
        return selectedGroupKeySets.some(selectedKeys => (
            [...keys].some(key => selectedKeys.has(key) || selectedKeys.has(groupNameForKey(key, groups)))
        ));
    });
}

function matchedRosterStudent(attempt: Attempt, students: RosterStudent[]): RosterStudent | undefined {
    return students.find(student => attemptMatchesStudentProfile(attempt, student));
}

function studentIdsForAttempts(attempts: Attempt[], students: RosterStudent[]): string[] {
    const ids = new Set<string>();
    for (const attempt of attempts) {
        const matched = matchedRosterStudent(attempt, students);
        const id = clean(matched?.id) || clean(attempt.studentId);
        if (id) ids.add(id);
    }
    return [...ids].sort();
}

function studentNamesForAttempts(attempts: Attempt[], students: RosterStudent[]): string[] {
    const names = new Set<string>();
    for (const attempt of attempts) {
        const matched = matchedRosterStudent(attempt, students);
        const name = clean(matched?.name) || clean(attempt.studentName);
        if (name) names.add(name);
    }
    return [...names].sort((a, b) => a.localeCompare(b, "ko"));
}

function submittedStudentIdsForExam(exam: Exam, attempts: Attempt[], students: RosterStudent[]): Set<string> {
    const submitted = new Set<string>();
    for (const attempt of attempts) {
        if (attempt.examId !== exam.id || attempt.retake) continue;
        const matched = matchedRosterStudent(attempt, students);
        const id = clean(matched?.id) || clean(attempt.studentId);
        if (id) submitted.add(id);
    }
    return submitted;
}

function groupMatchesStudent(groupKey: string, groupName: string, student: RosterStudent, groups: RosterGroup[]): boolean {
    const group = groups.find(item => item.id === groupKey || item.name === groupKey || item.id === groupName || item.name === groupName);
    if (group) return rosterGroupMatchesStudent(group, student);
    const keys = studentGroupKeys(student);
    const targetKeys = group ? groupKeys(group) : new Set([groupKey, groupName].map(clean).filter(Boolean));
    return [...keys].some(key => targetKeys.has(key));
}

function attemptsForClassRow(exam: Exam, attempts: Attempt[], rowGroupKey: string, rowGroupName: string, students: RosterStudent[], groups: RosterGroup[]): Attempt[] {
    const rowGroup = groups.find(group => group.id === rowGroupKey || group.name === rowGroupKey || group.id === rowGroupName || group.name === rowGroupName);
    const rowRegion = clean(rowGroup?.region);
    return attempts.filter(attempt => {
        if (attempt.examId !== exam.id || attempt.retake) return false;
        const matched = matchedRosterStudent(attempt, students);
        if (matched && groupMatchesStudent(rowGroupKey, rowGroupName, matched, groups)) return true;
        const attemptRegion = clean(attempt.regionName) || clean(attempt.regionId);
        if (rowRegion && attemptRegion && rowRegion !== attemptRegion) return false;
        return clean(attempt.groupId) === rowGroupKey
            || clean(attempt.groupName) === rowGroupKey
            || clean(attempt.groupId) === rowGroupName
            || clean(attempt.groupName) === rowGroupName;
    });
}

/**
 * Roster-based absentee computation for a single exam: eligible students minus
 * those who have submitted a (non-retake) attempt. Shared by the kakao missing-
 * exam candidate and the live monitoring page so both agree on who is missing.
 */
export function missingStudentsForExam(
    exam: Exam,
    attempts: Attempt[],
    students: RosterStudent[],
    groups: RosterGroup[],
): RosterStudent[] {
    const eligible = eligibleStudentsForExam(exam, students, groups);
    if (eligible.length === 0) return [];

    const submitted = submittedStudentIdsForExam(exam, attempts, students);
    return eligible.filter(student => !submitted.has(student.id));
}

function missingExamCandidate(
    exam: Exam,
    attempts: Attempt[],
    students: RosterStudent[],
    groups: RosterGroup[],
    now: Date,
): KakaoNotificationCandidate | null {
    if (exam.archived || !examHasStarted(exam, now)) return null;

    const missing = missingStudentsForExam(exam, attempts, students, groups);
    if (missing.length === 0) return null;

    const groupNames = Array.from(new Set(missing.map(student => student.group).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
    const regionNames = Array.from(new Set(missing.map(student => regionForStudent(student, groups)).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
    const groupLabels = Array.from(new Set(
        missing
            .map(student => formatRegionScopedLabel(student.group, regionForStudent(student, groups)))
            .filter(Boolean)
    )).sort((a, b) => a.localeCompare(b, "ko"));
    const ended = exam.endAt ? Date.parse(exam.endAt) <= now.getTime() : false;

    return {
        id: `kakao:missing:${exam.id}`,
        kind: "missing_exam",
        channel: "kakao",
        status: "candidate",
        title: ended ? "카카오 미응시 결과 확인 후보" : "카카오 미응시 독려 후보",
        message: `${exam.title} 미응시 ${missing.length}명 · ${groupLabels.slice(0, 3).join(", ") || "대상 반"}`,
        href: `/teacher/exam/${exam.id}`,
        examId: exam.id,
        examTitle: exam.title,
        targetCount: missing.length,
        studentIds: missing.map(student => student.id),
        studentNames: missing.map(student => student.name),
        groupNames,
        regionNames,
        reason: ended ? "응시 기간 종료 후 미제출 학생" : "응시 시작 후 아직 제출하지 않은 학생",
    };
}

function retakeRecommendationCandidate(exam: Exam, attempts: Attempt[], students: RosterStudent[]): KakaoNotificationCandidate | null {
    const baseAttempts = attempts.filter(attempt => attempt.examId === exam.id && !attempt.retake);
    if (exam.archived || baseAttempts.length === 0) return null;

    const recommendation = buildLearningRecommendations(exam, baseAttempts, {
        scope: "exam",
        kinds: ["concept", "mistakeType"],
        limit: 1,
    })[0];
    if (!recommendation || recommendation.retakeQuestionIds.length === 0) return null;

    const studentIds = studentIdsForAttempts(baseAttempts, students);
    const studentNames = studentNamesForAttempts(baseAttempts, students);
    const groupNames = Array.from(new Set(baseAttempts.map(attempt => attempt.groupName || attempt.groupId || "").filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
    const regionNames = Array.from(new Set(baseAttempts.map(attempt => attempt.regionName || attempt.regionId || "").filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));

    return {
        id: `kakao:retake:${exam.id}:${recommendation.key}`,
        kind: "retake_recommendation",
        channel: "kakao",
        status: "candidate",
        title: "카카오 재시험 안내 후보",
        message: `${exam.title} · ${recommendation.title} ${recommendation.retakeQuestionIds.length}문항 재시험 후보`,
        href: buildRetakeHref(exam.id, recommendation.sourceAttemptId, recommendation.retakeQuestionIds, recommendation.retakeMode, {
            labels: recommendation.retakeLabels,
            concepts: recommendation.retakeConcepts,
        }),
        examId: exam.id,
        examTitle: exam.title,
        targetCount: studentIds.length || baseAttempts.length,
        studentIds,
        studentNames,
        groupNames,
        regionNames,
        reason: recommendation.reason,
    };
}

function classRetakeRecommendationCandidates(
    exam: Exam,
    attempts: Attempt[],
    students: RosterStudent[],
    groups: RosterGroup[],
): KakaoNotificationCandidate[] {
    if (exam.archived) return [];
    const baseAttempts = attempts.filter(attempt => attempt.examId === exam.id && !attempt.retake);
    if (baseAttempts.length === 0) return [];

    return buildClassExamWeaknessMatrix(exam, baseAttempts, {
        rosterGroups: groups,
        rosterStudents: students,
        kinds: ["concept", "mistakeType"],
        recommendationLimit: 1,
        classLimit: 4,
    }).flatMap(row => {
        const recommendation = row.recommendations[0];
        if (!recommendation || recommendation.retakeQuestionIds.length === 0 || row.attemptCount === 0) return [];

        const rowAttempts = attemptsForClassRow(exam, baseAttempts, row.groupKey, row.groupName, students, groups);
        const studentIds = studentIdsForAttempts(rowAttempts, students);
        const studentNames = studentNamesForAttempts(rowAttempts, students);
        const groupNames = [row.groupName].filter(Boolean);
        const regionNames = Array.from(new Set([
            row.regionName,
            ...rowAttempts.map(attempt => attempt.regionName || attempt.regionId || ""),
            ...students
                .filter(student => studentIds.includes(student.id))
                .map(student => regionForStudent(student, groups)),
        ].map(clean).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko"));
        const groupLabel = formatRegionScopedLabel(row.groupName, row.regionName || regionNames[0]);

        return [{
            id: `kakao:class-retake:${exam.id}:${row.groupKey}:${recommendation.key}`,
            kind: "class_retake_recommendation" as const,
            channel: "kakao" as const,
            status: "candidate" as const,
            title: "카카오 반별 재시험 안내 후보",
            message: `${exam.title} · ${groupLabel} ${recommendation.title} ${recommendation.retakeQuestionIds.length}문항`,
            href: buildRetakeHref(exam.id, recommendation.sourceAttemptId, recommendation.retakeQuestionIds, recommendation.retakeMode, {
                labels: recommendation.retakeLabels,
                concepts: recommendation.retakeConcepts,
            }),
            examId: exam.id,
            examTitle: exam.title,
            targetCount: studentIds.length || row.studentCount || row.attemptCount,
            studentIds,
            studentNames,
            groupNames,
            regionNames,
            reason: `${groupLabel} 참여 ${formatParticipationRateLabel(row.participationRate)} · 오답 압력 ${row.wrongRate}% · ${recommendation.reason}`,
        }];
    });
}

export function buildKakaoNotificationCandidates(params: QueueParams): KakaoNotificationQueueSummary {
    const now = params.now || new Date();
    const limit = Math.max(1, params.limit ?? 12);
    const candidates: KakaoNotificationCandidate[] = [];

    for (const exam of params.exams) {
        const missing = missingExamCandidate(exam, params.attempts, params.students, params.groups, now);
        if (missing) candidates.push(missing);

        const retake = retakeRecommendationCandidate(exam, params.attempts, params.students);
        if (retake) candidates.push(retake);

        candidates.push(...classRetakeRecommendationCandidates(exam, params.attempts, params.students, params.groups));
    }

    const sorted = candidates
        .sort((a, b) => {
            if (b.targetCount !== a.targetCount) return b.targetCount - a.targetCount;
            const kindRank: Record<KakaoNotificationCandidateKind, number> = {
                missing_exam: 0,
                class_retake_recommendation: 1,
                retake_recommendation: 2,
            };
            if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
            return a.examTitle.localeCompare(b.examTitle, "ko");
        })
        .slice(0, limit);
    const targetStudentIds = new Set(sorted.flatMap(candidate => candidate.studentIds));

    return {
        candidates: sorted,
        totalCount: sorted.length,
        missingExamCount: sorted.filter(candidate => candidate.kind === "missing_exam").length,
        retakeRecommendationCount: sorted.filter(candidate => candidate.kind === "retake_recommendation").length,
        classRetakeRecommendationCount: sorted.filter(candidate => candidate.kind === "class_retake_recommendation").length,
        targetStudentCount: targetStudentIds.size,
    };
}
