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

export function buildRosterStudentPerformance(
    student: RosterStudent,
    attempts: Attempt[],
    examById: Map<string, Exam>,
    now = Date.now(),
): RosterStudentPerformance {
    const matchedAttempts = attempts
        .filter(attempt => attemptMatchesStudentProfile(attempt, student))
        .sort((a, b) => activityTime(b) - activityTime(a));
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

export function buildRosterPerformanceMap(
    students: RosterStudent[],
    attempts: Attempt[],
    examById: Map<string, Exam>,
    now = Date.now(),
): Map<string, RosterStudentPerformance> {
    return new Map(students.map(student => [
        student.id,
        buildRosterStudentPerformance(student, attempts, examById, now),
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
    return groups.map(group => {
        const inGroup = students.filter(student => rosterGroupMatchesStudent(group, student));
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
