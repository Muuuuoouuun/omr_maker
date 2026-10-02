import type { Attempt } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { DEFAULT_REGION_NAME, regionKeyFor } from "@/lib/regionIdentity";
import { safeScorePercent } from "@/lib/scoreUtils";
import { attemptMatchesStudentProfile } from "@/utils/storage";

export interface StudentAnalyticsRegionalScope {
    regionKey: string;
    regionName: string;
    studentCount: number;
    groupCount: number;
    attemptCount: number;
    retakeAttemptCount: number;
    examCount: number;
    averageScore: number | null;
    groupNames: string[];
}

function clean(value: string | undefined): string {
    return typeof value === "string" ? value.trim() : "";
}

export function studentAnalyticsStudentKey(attempt: Pick<Attempt,
    "studentId" | "studentName" | "groupId" | "groupName" | "regionId" | "regionName"
>): string {
    const stable = clean(attempt.studentId);
    if (stable) return stable;
    const name = clean(attempt.studentName);
    const stableGroup = clean(attempt.groupId);
    const group = stableGroup || clean(attempt.groupName);
    const region = clean(attempt.regionId) || clean(attempt.regionName);
    if (!name) return "";
    if (stableGroup) return `${stableGroup}::${name}`;
    if (group) return region ? `${region}::${group}::${name}` : `${group}::${name}`;
    return region ? `${region}::${name}` : name;
}

function rosterStudentFor(attempt: Attempt, students: readonly RosterStudent[]): RosterStudent | undefined {
    return students.find(student => attemptMatchesStudentProfile(attempt, student));
}

function rosterGroupFor(
    attempt: Attempt,
    student: RosterStudent | undefined,
    groups: readonly RosterGroup[],
): RosterGroup | undefined {
    return groups.find(group => (
        (student && (student.group === group.id || student.group === group.name))
        || (!!attempt.groupId && attempt.groupId === group.id)
        || (!!attempt.groupName && attempt.groupName === group.name)
    ));
}

export function studentAnalyticsRegionName(
    attempt: Attempt,
    students: readonly RosterStudent[],
    groups: readonly RosterGroup[],
): string {
    const explicit = clean(attempt.regionName) || clean(attempt.regionId);
    if (explicit) return explicit;
    const student = rosterStudentFor(attempt, students);
    if (clean(student?.region)) return clean(student?.region);
    const group = rosterGroupFor(attempt, student, groups);
    if (clean(group?.region)) return clean(group?.region);
    return DEFAULT_REGION_NAME;
}

export function filterStudentAnalyticsAttemptsByRegion(
    attempts: readonly Attempt[],
    regionKey: string,
    students: readonly RosterStudent[],
    groups: readonly RosterGroup[],
): Attempt[] {
    return attempts.filter(attempt => (
        regionKeyFor(studentAnalyticsRegionName(attempt, students, groups)) === regionKey
    ));
}

export function buildStudentAnalyticsRegionalScopes(params: {
    students: readonly RosterStudent[];
    groups: readonly RosterGroup[];
    attempts: readonly Attempt[];
}): StudentAnalyticsRegionalScope[] {
    type Accumulator = {
        name: string;
        studentKeys: Set<string>;
        groupKeys: Set<string>;
        groupNames: Set<string>;
        examIds: Set<string>;
        scores: number[];
        attemptCount: number;
        retakeAttemptCount: number;
    };
    const scopes = new Map<string, Accumulator>();
    const ensure = (nameValue: string): Accumulator => {
        const name = clean(nameValue) || DEFAULT_REGION_NAME;
        const key = regionKeyFor(name);
        const existing = scopes.get(key);
        if (existing) return existing;
        const created: Accumulator = {
            name,
            studentKeys: new Set(),
            groupKeys: new Set(),
            groupNames: new Set(),
            examIds: new Set(),
            scores: [],
            attemptCount: 0,
            retakeAttemptCount: 0,
        };
        scopes.set(key, created);
        return created;
    };

    for (const group of params.groups) {
        const scope = ensure(clean(group.region) || DEFAULT_REGION_NAME);
        scope.groupKeys.add(group.id || group.name);
        scope.groupNames.add(group.name);
    }
    for (const student of params.students) {
        const scope = ensure(clean(student.region) || DEFAULT_REGION_NAME);
        scope.studentKeys.add(student.id);
        if (student.group) {
            scope.groupKeys.add(student.group);
            scope.groupNames.add(student.group);
        }
    }
    for (const attempt of params.attempts.filter(item => item.status === "completed")) {
        const scope = ensure(studentAnalyticsRegionName(attempt, params.students, params.groups));
        if (attempt.retake) {
            scope.retakeAttemptCount += 1;
            continue;
        }
        const student = rosterStudentFor(attempt, params.students);
        const group = rosterGroupFor(attempt, student, params.groups);
        scope.attemptCount += 1;
        scope.studentKeys.add(student?.id || studentAnalyticsStudentKey(attempt));
        scope.examIds.add(attempt.examId);
        if (group) {
            scope.groupKeys.add(group.id || group.name);
            scope.groupNames.add(group.name);
        } else if (attempt.groupId || attempt.groupName) {
            scope.groupKeys.add(attempt.groupId || attempt.groupName || "");
            scope.groupNames.add(attempt.groupName || attempt.groupId || "");
        }
        if (Number.isFinite(attempt.totalScore) && attempt.totalScore > 0) {
            scope.scores.push(safeScorePercent(attempt.score, attempt.totalScore));
        }
    }

    return [...scopes.entries()].map(([regionKey, scope]) => ({
        regionKey,
        regionName: scope.name,
        studentCount: scope.studentKeys.size,
        groupCount: scope.groupKeys.size,
        attemptCount: scope.attemptCount,
        retakeAttemptCount: scope.retakeAttemptCount,
        examCount: scope.examIds.size,
        averageScore: scope.scores.length > 0
            ? Math.round(scope.scores.reduce((sum, score) => sum + score, 0) / scope.scores.length)
            : null,
        groupNames: [...scope.groupNames].filter(Boolean).sort((left, right) => left.localeCompare(right, "ko")),
    })).sort((left, right) => right.attemptCount - left.attemptCount || left.regionName.localeCompare(right.regionName, "ko"));
}
