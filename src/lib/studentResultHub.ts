import type { Attempt } from "@/types/omr";
import { safeScorePercent } from "@/lib/scoreUtils";

export const STUDENT_RESULT_VIEWS = ["answers", "handwriting", "report", "analytics"] as const;

export type StudentResultView = typeof STUDENT_RESULT_VIEWS[number];

export interface StudentAttemptSeriesItem {
    attempt: Attempt;
    kind: "original" | "retake";
    ordinal: number;
    scorePercent: number;
    scoreDelta: number | null;
}

function normalized(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function matchingValues(left: Array<string | undefined>, right: Array<string | undefined>): boolean {
    const leftValues = new Set(left.map(normalized).filter((value): value is string => Boolean(value)));
    return right.some(value => {
        const candidate = normalized(value);
        return candidate !== null && leftValues.has(candidate);
    });
}

function timestamp(attempt: Attempt): number {
    const value = Date.parse(attempt.finishedAt);
    return Number.isFinite(value) ? value : 0;
}

export function parseStudentResultView(value?: string | null): StudentResultView {
    return STUDENT_RESULT_VIEWS.includes(value as StudentResultView) ? value as StudentResultView : "answers";
}

export function buildStudentResultHref(attemptId: string, view: StudentResultView): string {
    return `/teacher/attempt/${encodeURIComponent(attemptId)}?view=${view}`;
}

export function sameStudentAttempt(left: Attempt, right: Attempt): boolean {
    if (matchingValues([left.studentProfileId, left.studentId], [right.studentProfileId, right.studentId])) return true;

    const leftGuestId = normalized(left.guestId);
    const rightGuestId = normalized(right.guestId);
    if (leftGuestId && leftGuestId === rightGuestId) return true;

    const leftName = normalized(left.studentName);
    const rightName = normalized(right.studentName);
    return Boolean(
        leftName
        && leftName === rightName
        && matchingValues([left.groupId, left.groupName], [right.groupId, right.groupName]),
    );
}

export function buildStudentAttemptSeries(selectedAttempt: Attempt, attempts: Attempt[]): StudentAttemptSeriesItem[] {
    const relatedAttempts = attempts
        .filter(attempt => attempt.examId === selectedAttempt.examId && sameStudentAttempt(selectedAttempt, attempt))
        .sort((left, right) => {
            const kindDifference = Number(Boolean(left.retake)) - Number(Boolean(right.retake));
            if (kindDifference) return kindDifference;
            return timestamp(left) - timestamp(right) || left.id.localeCompare(right.id);
        });
    const scoreByAttemptId = new Map(relatedAttempts.map(attempt => [attempt.id, safeScorePercent(attempt.score, attempt.totalScore)]));
    let originalOrdinal = 0;
    let retakeOrdinal = 0;

    return relatedAttempts.map(attempt => {
        const kind = attempt.retake ? "retake" : "original";
        const scorePercent = safeScorePercent(attempt.score, attempt.totalScore);
        const sourceScore = attempt.retake ? scoreByAttemptId.get(attempt.retake.sourceAttemptId) : undefined;
        return {
            attempt,
            kind,
            ordinal: kind === "original" ? ++originalOrdinal : ++retakeOrdinal,
            scorePercent,
            scoreDelta: sourceScore === undefined ? null : Math.round((scorePercent - sourceScore) * 10) / 10,
        };
    });
}
