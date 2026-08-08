import type { Attempt, Exam } from "@/types/omr";
import { resolveAttemptScore } from "@/lib/attemptScores";

export type GrowthDataStatus = "ready" | "partial" | "stale";

export interface StudentGrowthRow {
    examId: string;
    examTitle: string;
    finishedAt: string;
    studentScore: number;
    classAverage: number;
    gap: number;
    rank: number | null;
    participantCount: number;
    isLatest: boolean;
}

export interface StudentGrowthReportModel {
    status: GrowthDataStatus;
    rows: StudentGrowthRow[];
    latestScore: number | null;
    averageGap: number | null;
    currentRank: number | null;
    rankDelta: number | null;
    trend: "up" | "down" | "flat" | "insufficient";
}

export interface BuildStudentGrowthReportInput {
    selectedStudentId: string;
    selectedClassKey: string;
    dataStatus: GrowthDataStatus;
    attempts: readonly Attempt[];
    exams: readonly Exam[];
}

function stableKey(value: string | undefined): string {
    return value?.trim() ?? "";
}

function normalizedName(value: string | undefined): string {
    return stableKey(value).toLocaleLowerCase("ko-KR");
}

export function growthClassKeyForAttempt(
    attempt: Pick<Attempt, "classId" | "groupId" | "regionId" | "regionName" | "groupName">,
): string {
    const classId = stableKey(attempt.classId);
    if (classId) return classId;
    const groupId = stableKey(attempt.groupId);
    if (groupId) return groupId;
    const region = stableKey(attempt.regionId) || normalizedName(attempt.regionName);
    return `${region}::${normalizedName(attempt.groupName)}`;
}

function attemptMatchesClass(attempt: Attempt, selectedClassKey: string): boolean {
    const selectedStableKey = stableKey(selectedClassKey);
    const classKey = growthClassKeyForAttempt(attempt);
    if (stableKey(attempt.classId) || stableKey(attempt.groupId)) return classKey === selectedStableKey;
    return classKey === selectedStableKey || normalizedName(classKey) === normalizedName(selectedClassKey);
}

function attemptMatchesStudent(attempt: Attempt, selectedStudentId: string): boolean {
    const selectedStableKey = stableKey(selectedStudentId);
    if (stableKey(attempt.studentProfileId)) return stableKey(attempt.studentProfileId) === selectedStableKey;
    if (stableKey(attempt.studentId)) return stableKey(attempt.studentId) === selectedStableKey;
    return normalizedName(attempt.studentName) === normalizedName(selectedStudentId);
}

function participantKey(attempt: Attempt): string {
    if (stableKey(attempt.studentProfileId)) return `id:${stableKey(attempt.studentProfileId)}`;
    if (stableKey(attempt.studentId)) return `id:${stableKey(attempt.studentId)}`;
    return `name:${normalizedName(attempt.studentName)}`;
}

function finishedTime(attempt: Attempt): number {
    return Date.parse(attempt.finishedAt) || 0;
}

function isPreferredRepresentative(candidate: Attempt, current: Attempt): boolean {
    return finishedTime(candidate) > finishedTime(current)
        || (finishedTime(candidate) === finishedTime(current) && candidate.id.localeCompare(current.id) < 0);
}

function resolvedScorePercent(attempt: Attempt, exam?: Exam): number | null {
    const resolved = resolveAttemptScore(attempt, exam);
    if (!Number.isFinite(resolved.scorePercent)) return null;
    if (
        resolved.source === "storedScore"
        && (!Number.isFinite(attempt.score) || !Number.isFinite(attempt.totalScore))
    ) {
        return null;
    }
    return resolved.scorePercent;
}

function roundToOneDecimal(value: number): number {
    return Math.round(value * 10) / 10;
}

function isFinalAttempt(attempt: Attempt): boolean {
    return attempt.status !== "in_progress";
}

export function buildStudentGrowthReport({
    selectedStudentId,
    selectedClassKey,
    dataStatus,
    attempts,
    exams,
}: BuildStudentGrowthReportInput): StudentGrowthReportModel {
    const examById = new Map(exams.map(exam => [exam.id, exam]));
    const scoreByAttempt = new Map<Attempt, number>();
    const scopedAttempts = attempts.filter(attempt => {
        if (attempt.retake || !isFinalAttempt(attempt) || !attemptMatchesClass(attempt, selectedClassKey)) {
            return false;
        }
        const score = resolvedScorePercent(attempt, examById.get(attempt.examId));
        if (score == null) return false;
        scoreByAttempt.set(attempt, score);
        return true;
    });
    const representativeByStudentExam = new Map<string, Attempt>();
    for (const attempt of scopedAttempts) {
        const key = `${attempt.examId}\u0000${participantKey(attempt)}`;
        const current = representativeByStudentExam.get(key);
        if (!current || isPreferredRepresentative(attempt, current)) {
            representativeByStudentExam.set(key, attempt);
        }
    }
    const representativeAttempts = Array.from(representativeByStudentExam.values());
    const selectedAttempts = representativeAttempts
        .filter(attempt => attemptMatchesStudent(attempt, selectedStudentId))
        .sort((left, right) => (
            finishedTime(left) - finishedTime(right)
            || left.id.localeCompare(right.id)
        ));
    const rows = selectedAttempts.map((selectedAttempt, index): StudentGrowthRow => {
        const participants = representativeAttempts.filter(attempt => attempt.examId === selectedAttempt.examId);
        const scores = participants.map(attempt => scoreByAttempt.get(attempt) as number);
        const studentScore = scoreByAttempt.get(selectedAttempt) as number;
        const classAverage = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
        const higherScoreCount = scores.filter(score => score > studentScore).length;
        return {
            examId: selectedAttempt.examId,
            examTitle: examById.get(selectedAttempt.examId)?.title || selectedAttempt.examTitle,
            finishedAt: selectedAttempt.finishedAt,
            studentScore,
            classAverage,
            gap: studentScore - classAverage,
            rank: participants.length < 2 ? null : 1 + higherScoreCount,
            participantCount: participants.length,
            isLatest: index === selectedAttempts.length - 1,
        };
    });
    const latestRow = rows.at(-1);
    const previousRow = rows.at(-2);
    const rankDelta = latestRow?.rank != null && previousRow?.rank != null
        ? previousRow.rank - latestRow.rank
        : null;
    const trend: StudentGrowthReportModel["trend"] = !latestRow || !previousRow
        ? "insufficient"
        : latestRow.studentScore - previousRow.studentScore > 1
            ? "up"
            : latestRow.studentScore - previousRow.studentScore < -1
                ? "down"
                : "flat";

    return {
        status: dataStatus,
        rows,
        latestScore: latestRow?.studentScore ?? null,
        averageGap: rows.length > 0
            ? roundToOneDecimal(rows.reduce((sum, row) => sum + row.gap, 0) / rows.length)
            : null,
        currentRank: latestRow?.rank ?? null,
        rankDelta,
        trend,
    };
}
