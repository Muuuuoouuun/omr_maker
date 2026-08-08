import type { Attempt, Exam } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import { resolveAttemptScore, type ResolvedAttemptScore } from "@/lib/attemptScores";
import { hasGradableAttemptScore, safeScorePercent } from "@/lib/scoreUtils";
import { attemptMatchesStudentProfile } from "@/utils/storage";

export const STUDENT_RESULT_VIEWS = ["answers", "handwriting", "report", "analytics"] as const;

export type StudentResultView = typeof STUDENT_RESULT_VIEWS[number];

export interface StudentAttemptSeriesItem {
    attempt: Attempt;
    kind: "original" | "retake";
    ordinal: number;
    scorePercent: number | null;
    scoreDelta: number | null;
    scoreSummary: ResolvedAttemptScore;
    comparisonScore: { totalScore: number; scorePercent: number };
}

export type StudentRetakeScoreDelta =
    | { status: "source-missing" }
    | { status: "score-unavailable" }
    | {
        status: "comparable";
        sourceScorePercent: number;
        currentScorePercent: number;
        delta: number;
    };

export function buildStudentRetakeScoreDelta(
    current: { totalScore: number; scorePercent: number },
    source: { totalScore: number; scorePercent: number } | null,
): StudentRetakeScoreDelta {
    if (!source) return { status: "source-missing" };
    if (!hasGradableAttemptScore(current) || !hasGradableAttemptScore(source)) {
        return { status: "score-unavailable" };
    }
    return {
        status: "comparable",
        sourceScorePercent: source.scorePercent,
        currentScorePercent: current.scorePercent,
        delta: current.scorePercent - source.scorePercent,
    };
}

function normalized(value: string | undefined): string | null {
    const trimmed = value?.trim();
    return trimmed ? trimmed : null;
}

function nonEmptyValues(values: Array<string | undefined>): string[] {
    return values.map(normalized).filter((value): value is string => Boolean(value));
}

function matchingValues(left: Array<string | undefined>, right: Array<string | undefined>): boolean {
    const leftValues = new Set(nonEmptyValues(left));
    return right.some(value => {
        const candidate = normalized(value);
        return candidate !== null && leftValues.has(candidate);
    });
}

function authoritativeStableId(attempt: Attempt): string | null {
    return normalized(attempt.studentProfileId) || normalized(attempt.studentId);
}

function organizationsConflict(left: Attempt, right: Attempt): boolean {
    const leftOrganizationId = normalized(left.organizationId);
    const rightOrganizationId = normalized(right.organizationId);
    return Boolean(leftOrganizationId && rightOrganizationId && leftOrganizationId !== rightOrganizationId);
}

function matchesOrganizationScope(organizationId: string | undefined, selectedOrganizationId: string | undefined): boolean {
    const selectedOrganization = normalized(selectedOrganizationId);
    const candidateOrganization = normalized(organizationId);
    if (!selectedOrganization) return !candidateOrganization;
    return !candidateOrganization || candidateOrganization === selectedOrganization;
}

function examRecency(exam: Exam): number {
    return Date.parse(exam.updatedAt || exam.createdAt) || 0;
}

function examRevision(exam: Exam): number {
    return Number.isSafeInteger(exam.revision) ? exam.revision! : -1;
}

function stableSemanticKey(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(stableSemanticKey).join(",")}]`;
    if (value && typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, item]) => `${JSON.stringify(key)}:${stableSemanticKey(item)}`);
        return `{${entries.join(",")}}`;
    }
    return JSON.stringify(value) ?? String(value);
}

export function buildCumulativeExamMap(
    exams: readonly Exam[],
    selectedOrganizationId?: string,
): Map<string, Exam> {
    const selectedOrganization = normalized(selectedOrganizationId);
    const scoped = new Map<string, Exam>();
    for (const exam of exams) {
        const examId = normalized(exam.id);
        if (!examId || !matchesOrganizationScope(exam.organizationId, selectedOrganizationId)) continue;
        const current = scoped.get(examId);
        if (!current) {
            scoped.set(examId, exam);
            continue;
        }
        const currentExact = Boolean(selectedOrganization && normalized(current.organizationId) === selectedOrganization);
        const candidateExact = Boolean(selectedOrganization && normalized(exam.organizationId) === selectedOrganization);
        const candidatePreferred = Number(candidateExact) > Number(currentExact)
            || (
                candidateExact === currentExact
                && (
                    examRevision(exam) > examRevision(current)
                    || (
                        examRevision(exam) === examRevision(current)
                        && (
                            examRecency(exam) > examRecency(current)
                            || (
                                examRecency(exam) === examRecency(current)
                                && (
                                    exam.title.localeCompare(current.title, "ko") < 0
                                    || (
                                        exam.title === current.title
                                        && stableSemanticKey(exam).localeCompare(stableSemanticKey(current)) < 0
                                    )
                                )
                            )
                        )
                    )
                )
            );
        if (candidatePreferred) scoped.set(examId, exam);
    }
    return scoped;
}

function guardedLegacyCompatibility(left: Attempt, right: Attempt): boolean {
    const leftGuestId = normalized(left.guestId);
    const rightGuestId = normalized(right.guestId);
    if (leftGuestId || rightGuestId) {
        return Boolean(leftGuestId && rightGuestId && leftGuestId === rightGuestId);
    }

    const leftName = normalized(left.studentName);
    const rightName = normalized(right.studentName);
    return Boolean(
        leftName
        && leftName === rightName
        && matchingValues([left.groupId, left.groupName], [right.groupId, right.groupName]),
    );
}

function timestamp(attempt: Attempt): number {
    const value = Date.parse(attempt.finishedAt);
    return Number.isFinite(value) ? value : 0;
}

export function mergeSelectedAttemptIntoPeers(selectedAttempt: Attempt, peerAttempts: Attempt[]): Attempt[] {
    return [
        ...peerAttempts.filter(attempt => attempt.id !== selectedAttempt.id),
        selectedAttempt,
    ];
}

export function resolveStudentResultComparisonScore(
    attempt: Attempt,
    canonicalScore: { totalScore: number; scorePercent: number },
): { totalScore: number; scorePercent: number } {
    const storedScore = {
        totalScore: attempt.totalScore,
        scorePercent: safeScorePercent(attempt.score, attempt.totalScore),
    };
    return hasGradableAttemptScore(storedScore) ? storedScore : canonicalScore;
}

export function parseStudentResultView(value?: string | null): StudentResultView {
    return STUDENT_RESULT_VIEWS.includes(value as StudentResultView) ? value as StudentResultView : "answers";
}

export function buildStudentResultHref(attemptId: string, view: StudentResultView): string {
    return `/teacher/attempt/${encodeURIComponent(attemptId)}?view=${view}`;
}

export function matchRosterStudentForAttempt(
    attempt: Attempt,
    students: RosterStudent[],
): RosterStudent | null {
    const profileId = normalized(attempt.studentProfileId);
    if (profileId) return students.find(student => normalized(student.id) === profileId) || null;

    const studentId = normalized(attempt.studentId);
    if (studentId) return students.find(student => normalized(student.id) === studentId) || null;

    const legacyCandidates = students.filter(student => attemptMatchesStudentProfile(attempt, student));
    return legacyCandidates.length === 1 ? legacyCandidates[0] : null;
}

export function markUnresolvedGrowthAttempt(attempt: Attempt): Attempt {
    return {
        ...attempt,
        studentName: "",
        studentProfileId: undefined,
        studentId: undefined,
    };
}

export function filterCumulativeAttemptsForStudent(
    selectedAttempt: Attempt,
    attempts: Attempt[],
    students: RosterStudent[],
    resolvedSelectedStudent?: RosterStudent | null,
    selectedOrganizationId?: string,
): Attempt[] {
    const matchedSelectedStudent = matchRosterStudentForAttempt(selectedAttempt, students);
    const selectedStudent = resolvedSelectedStudent === undefined
        ? matchedSelectedStudent
        : matchedSelectedStudent
            && normalized(matchedSelectedStudent.id) === normalized(resolvedSelectedStudent?.id)
            ? resolvedSelectedStudent
            : null;
    const selectedAttemptId = normalized(selectedAttempt.id);
    const selectedStableId = authoritativeStableId(selectedAttempt);

    return attempts.filter(candidate => {
        if (selectedOrganizationId) {
            if (!matchesOrganizationScope(candidate.organizationId, selectedOrganizationId)) return false;
        } else if (organizationsConflict(selectedAttempt, candidate)) {
            return false;
        }

        const candidateAttemptId = normalized(candidate.id);
        if (selectedAttemptId && selectedAttemptId === candidateAttemptId) return true;

        const candidateStableId = authoritativeStableId(candidate);
        if (selectedStableId && candidateStableId) {
            return selectedStableId === candidateStableId;
        }

        if (!selectedStudent || !guardedLegacyCompatibility(selectedAttempt, candidate)) return false;
        const candidateStudent = matchRosterStudentForAttempt(candidate, students);
        return Boolean(candidateStudent && normalized(candidateStudent.id) === normalized(selectedStudent.id));
    });
}

export function sameStudentAttempt(left: Attempt, right: Attempt): boolean {
    if (organizationsConflict(left, right)) return false;

    const leftAttemptId = normalized(left.id);
    const rightAttemptId = normalized(right.id);
    if (leftAttemptId && leftAttemptId === rightAttemptId) return true;

    const leftStableId = authoritativeStableId(left);
    const rightStableId = authoritativeStableId(right);
    if (leftStableId && rightStableId) return leftStableId === rightStableId;
    if (leftStableId || rightStableId) return false;

    return guardedLegacyCompatibility(left, right);
}

export function buildStudentAttemptSeries(
    selectedAttempt: Attempt,
    attempts: Attempt[],
    examById: ReadonlyMap<string, Exam> = new Map(),
): StudentAttemptSeriesItem[] {
    const relatedAttempts = attempts
        .filter(attempt => attempt.examId === selectedAttempt.examId && sameStudentAttempt(selectedAttempt, attempt))
        .sort((left, right) => {
            const kindDifference = Number(Boolean(left.retake)) - Number(Boolean(right.retake));
            if (kindDifference) return kindDifference;
            return timestamp(left) - timestamp(right) || left.id.localeCompare(right.id);
        });
    const scoreSummaryByAttemptId = new Map(relatedAttempts.map(attempt => [
        attempt.id,
        resolveAttemptScore(attempt, examById.get(attempt.examId)),
    ]));
    const comparisonScoreByAttemptId = new Map(relatedAttempts.map(attempt => [
        attempt.id,
        resolveStudentResultComparisonScore(attempt, scoreSummaryByAttemptId.get(attempt.id)!),
    ]));
    let originalOrdinal = 0;
    let retakeOrdinal = 0;

    return relatedAttempts.map(attempt => {
        const kind = attempt.retake ? "retake" : "original";
        const scoreSummary = scoreSummaryByAttemptId.get(attempt.id)!;
        const comparisonScore = comparisonScoreByAttemptId.get(attempt.id)!;
        const scorePercent = hasGradableAttemptScore(scoreSummary)
            ? scoreSummary.scorePercent
            : null;
        const sourceComparisonScore = attempt.retake ? comparisonScoreByAttemptId.get(attempt.retake.sourceAttemptId) : undefined;
        const sourceScore = sourceComparisonScore && hasGradableAttemptScore(sourceComparisonScore)
            ? sourceComparisonScore.scorePercent
            : null;
        return {
            attempt,
            kind,
            ordinal: kind === "original" ? ++originalOrdinal : ++retakeOrdinal,
            scorePercent,
            scoreSummary,
            comparisonScore,
            scoreDelta: !hasGradableAttemptScore(comparisonScore) || sourceScore == null
                ? null
                : Math.round((comparisonScore.scorePercent - sourceScore) * 10) / 10,
        };
    });
}
