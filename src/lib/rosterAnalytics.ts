import type { Attempt, Exam } from "@/types/omr";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import { baseAttemptsOnly, resolveAttemptScore } from "@/lib/attemptScores";
import { attemptMatchesStudentProfile } from "@/utils/storage";

export interface RosterStudentPerformance {
    avgScore: number;
    examsTaken: number;
    lastActive: string;
    trend: RosterStudent["trend"];
    status: RosterStudent["status"];
    attempts: Attempt[];
}

function relativeActivityLabel(timestamp: number, now: number): string {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return "기록 없음";
    const diffMs = Math.max(0, now - timestamp);
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60) return minutes <= 5 ? "방금 전" : `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}일 전`;
    const months = Math.floor(days / 30);
    return `${months}개월 전`;
}

function activityTime(attempt: Attempt): number {
    return Date.parse(attempt.finishedAt || attempt.startedAt || "") || 0;
}

function trendFromScores(scoresNewestFirst: number[]): RosterStudent["trend"] {
    if (scoresNewestFirst.length < 2) return "flat";
    const delta = scoresNewestFirst[0] - scoresNewestFirst[1];
    if (delta >= 3) return "up";
    if (delta <= -3) return "down";
    return "flat";
}

function normalizedIdentity(value: string | undefined): string {
    return value?.trim() || "";
}

function performanceFromMatchedAttempts(
    student: RosterStudent,
    matched: Attempt[],
    examById: Map<string, Exam>,
    now: number,
): RosterStudentPerformance {
    const matchedAttempts = [...matched].sort((a, b) => activityTime(b) - activityTime(a));
    const baseAttempts = baseAttemptsOnly(matchedAttempts);

    if (matchedAttempts.length === 0) {
        return {
            avgScore: student.avgScore,
            examsTaken: student.examsTaken,
            lastActive: student.lastActive,
            trend: student.trend,
            status: student.status,
            attempts: [],
        };
    }

    const scores = baseAttempts.map(attempt => (
        resolveAttemptScore(attempt, examById.get(attempt.examId)).scorePercent
    ));
    const avgScore = scores.length > 0
        ? Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length)
        : student.avgScore;
    const latestTime = activityTime(matchedAttempts[0]);
    const activeWindowMs = 14 * 24 * 60 * 60 * 1000;

    return {
        avgScore,
        examsTaken: scores.length > 0 ? baseAttempts.length : student.examsTaken,
        lastActive: relativeActivityLabel(latestTime, now),
        trend: trendFromScores(scores),
        status: now - latestTime <= activeWindowMs ? "active" : "idle",
        attempts: matchedAttempts,
    };
}

export function buildRosterStudentPerformance(
    student: RosterStudent,
    attempts: Attempt[],
    examById: Map<string, Exam>,
    now = Date.now(),
): RosterStudentPerformance {
    const matchedAttempts = attempts
        .filter(attempt => attemptMatchesStudentProfile(attempt, student));
    return performanceFromMatchedAttempts(student, matchedAttempts, examById, now);
}

export function buildRosterPerformanceMap(
    students: RosterStudent[],
    attempts: Attempt[],
    examById: Map<string, Exam>,
    now = Date.now(),
): Map<string, RosterStudentPerformance> {
    // Index the roster once, then test each attempt only against plausible
    // id/name candidates. The former student.map(attempts.filter(...)) path
    // performed a full students × attempts scan on every roster render.
    const studentsById = new Map<string, RosterStudent>();
    for (const student of students) studentsById.set(student.id, student);

    const studentIdsByNormalizedId = new Map<string, Set<string>>();
    const studentIdsByName = new Map<string, Set<string>>();
    for (const student of studentsById.values()) {
        const normalizedId = normalizedIdentity(student.id);
        if (normalizedId) {
            const ids = studentIdsByNormalizedId.get(normalizedId) || new Set<string>();
            ids.add(student.id);
            studentIdsByNormalizedId.set(normalizedId, ids);
        }
        const name = normalizedIdentity(student.name);
        if (!name) continue;
        const ids = studentIdsByName.get(name) || new Set<string>();
        ids.add(student.id);
        studentIdsByName.set(name, ids);
    }

    const attemptsByStudentId = new Map<string, Attempt[]>();
    for (const id of studentsById.keys()) attemptsByStudentId.set(id, []);

    for (const attempt of attempts) {
        const stableIds = Array.from(new Set([
            normalizedIdentity(attempt.studentProfileId),
            normalizedIdentity(attempt.studentId),
        ].filter(Boolean)));
        if (stableIds.length > 0) {
            const exactRosterIds = new Set<string>();
            for (const stableId of stableIds) {
                for (const rosterId of studentIdsByNormalizedId.get(stableId) || []) {
                    exactRosterIds.add(rosterId);
                }
            }
            if (exactRosterIds.size === 1) {
                const [rosterId] = exactRosterIds;
                attemptsByStudentId.get(rosterId)?.push(attempt);
            }
            continue;
        }

        const name = normalizedIdentity(attempt.studentName);
        if (!name) continue;
        const matchedRosterIds: string[] = [];
        for (const id of studentIdsByName.get(name) || []) {
            const student = studentsById.get(id);
            if (student && attemptMatchesStudentProfile(attempt, student)) {
                matchedRosterIds.push(id);
            }
        }
        if (matchedRosterIds.length === 1) {
            attemptsByStudentId.get(matchedRosterIds[0])?.push(attempt);
        }
    }

    return new Map(Array.from(studentsById, ([id, student]) => [
        id,
        performanceFromMatchedAttempts(student, attemptsByStudentId.get(id) || [], examById, now),
    ]));
}

export function applyRosterPerformance(
    students: RosterStudent[],
    performanceByStudentId: Map<string, RosterStudentPerformance>,
): RosterStudent[] {
    return students.map(student => {
        const performance = performanceByStudentId.get(student.id);
        if (!performance) return student;
        return {
            ...student,
            avgScore: performance.avgScore,
            examsTaken: performance.examsTaken,
            lastActive: performance.lastActive,
            trend: performance.trend,
            status: performance.status,
        };
    });
}

export function recomputeRosterGroupsFromStudents(
    students: RosterStudent[],
    groups: RosterGroup[],
): RosterGroup[] {
    const studentsByGroupName = new Map<string, RosterStudent[]>();
    const studentsByGroupScope = new Map<string, RosterStudent[]>();
    const legacyStudents: RosterStudent[] = [];

    for (const student of students) {
        const groupName = student.group.trim();
        if (!groupName) {
            legacyStudents.push(student);
            continue;
        }

        const byName = studentsByGroupName.get(groupName) || [];
        byName.push(student);
        studentsByGroupName.set(groupName, byName);

        const region = student.region?.trim() || "";
        if (region) {
            const scopeKey = `${groupName}\u0000${region}`;
            const byScope = studentsByGroupScope.get(scopeKey) || [];
            byScope.push(student);
            studentsByGroupScope.set(scopeKey, byScope);
        }
    }

    return groups.map(group => {
        const groupName = group.name.trim();
        const groupRegion = group.region?.trim() || "";
        const indexed = groupRegion
            ? studentsByGroupScope.get(`${groupName}\u0000${groupRegion}`) || []
            : studentsByGroupName.get(groupName) || [];
        const inGroup = legacyStudents.length === 0
            ? indexed
            : [...indexed, ...legacyStudents.filter(student => rosterGroupMatchesStudent(group, student))];
        const scoredStudents = inGroup.filter(student => student.examsTaken > 0);
        const avgScore = scoredStudents.length > 0
            ? Math.round(scoredStudents.reduce((sum, student) => sum + student.avgScore, 0) / scoredStudents.length)
            : 0;
        return {
            ...group,
            count: inGroup.length,
            avgScore,
        };
    });
}
