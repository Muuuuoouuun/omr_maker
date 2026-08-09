import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import { computePointBiserialCorrelation, type PointBiserialSample } from "@/lib/scoreDistribution";
import type {
    Attempt,
    Exam,
    FocusLossEvent,
    Question,
    QuestionResult,
    QuestionTiming,
} from "@/types/omr";
import {
    buildQuestionResults,
} from "@/lib/questionResultBuilder";
export { buildQuestionResults, getEffectiveExamQuestionsForAttempt } from "@/lib/questionResultBuilder";
import { resolveAwayCount } from "@/lib/examAwayTracker";
import { hasGradableAttemptScore } from "@/lib/scoreUtils";
import {
    buildCanonicalQuestionResultEvidence,
    hasCanonicalQuestionResultEvidenceAttestation,
} from "@/lib/canonicalQuestionResultManifest";
export { hasGradableAttemptScore } from "@/lib/scoreUtils";

export interface WeaknessGroup {
    key: string;
    title: string;
    basis: string;
    questionIds: number[];
    questionNumbers: number[];
    wrongCount: number;
    totalCount: number;
    wrongRate: number;
    labels: string[];
    concepts: string[];
    recommendedAction: string;
}

export interface SimilarQuestionGroup extends WeaknessGroup {
    attemptCount: number;
}

export interface AttemptBehaviorSummary {
    elapsedTimeSec: number;
    totalTrackedTimeSec: number;
    averageTimeSec: number;
    slowQuestionNumbers: number[];
    rushedQuestionNumbers: number[];
    revisitedQuestionNumbers: number[];
    answerChangedQuestionNumbers: number[];
    focusLossCount: number;
    focusLossQuestionNumbers: number[];
}

export type GroupKind = "source" | "concept" | "unit" | "label";
export type QuestionResultGroupKind = GroupKind | "skill" | "difficulty" | "mistakeType";

export interface QuestionResultScope {
    includeRetakes?: boolean;
    studentKey?: string;
    groupKey?: string;
}

export interface TypeWeaknessGroup {
    key: string;
    kind: QuestionResultGroupKind;
    title: string;
    basis: string;
    questionIds: number[];
    questionNumbers: number[];
    wrongCount: number;
    unansweredCount: number;
    /**
     * "불안정" signal: answered correctly but well over the time budget
     * (1.5× the question's expectedTimeSec, or 2× the scope average when no
     * expected time is tagged). Correct-but-slow concepts are shaky under
     * exam pressure even when the score looks fine.
     */
    slowCorrectCount: number;
    slowCorrectQuestionNumbers: number[];
    totalCount: number;
    wrongRate: number;
    attemptCount: number;
    studentCount: number;
    labels: string[];
    concepts: string[];
    recommendedQuestionIds: number[];
    recommendedAction: string;
}

export type LearningRecommendationScope = "attempt" | "student" | "class" | "exam";
export type LearningRecommendationSeverity = "watch" | "review" | "urgent";

export interface LearningRecommendationOptions {
    scope: LearningRecommendationScope;
    attempt?: Attempt;
    studentKey?: string;
    groupKey?: string;
    /** Inputs were already roster-classified; do not re-filter immutable row scope. */
    prefiltered?: boolean;
    kinds?: QuestionResultGroupKind[];
    includeRetakes?: boolean;
    /**
     * Surface "불안정 개념" — concepts answered correctly but repeatedly over
     * the time budget (≥2 slow-corrects) even with zero wrong answers. Off by
     * default so existing weakness consumers (profiles, kakao, regional) keep
     * their "weakness = wrong" semantics; opt in where slow signals help.
     */
    includeSlowCorrect?: boolean;
    limit?: number;
}

export interface LearningRecommendation extends TypeWeaknessGroup {
    scope: LearningRecommendationScope;
    severity: LearningRecommendationSeverity;
    priorityScore: number;
    reason: string;
    sourceAttemptId: string;
    retakeMode: "wrong" | "similar";
    retakeQuestionIds: number[];
    retakeLabels: string[];
    retakeConcepts: string[];
}

export interface ClassExamWeaknessMatrixOptions {
    kinds?: QuestionResultGroupKind[];
    recommendationLimit?: number;
    classLimit?: number;
    includeRetakes?: boolean;
    rosterGroups?: RosterGroup[];
    rosterStudents?: RosterStudent[];
}

export interface ClassExamWeaknessMatrixRow {
    groupKey: string;
    groupName: string;
    regionName?: string;
    attemptCount: number;
    studentCount: number;
    rosterStudentCount: number;
    submittedRosterStudentCount: number;
    missingStudentCount: number;
    missingStudentNames: string[];
    /** Roster-based turnout. `null` when no roster is linked (denominator unknown). */
    participationRate: number | null;
    performanceCount: number;
    averageScorePercent: number | null;
    wrongCount: number;
    totalCount: number;
    wrongRate: number;
    focusQuestionNumbers: number[];
    recommendations: LearningRecommendation[];
    retakeQuestionIds: number[];
}

export interface ExamQuestionResultStat {
    cohortKey: string;
    definitionManifestHash: string;
    questionId: number;
    questionNumber: number;
    label?: string;
    concept?: string;
    unit?: string;
    source?: string;
    expectedTimeSec?: number;
    score: number;
    correctAnswer?: number;
    difficulty?: QuestionResult["difficulty"];
    mistakeTypes?: string[];
    totalCount: number;
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    ungradedCount: number;
    correctRate: number;
    wrongRate: number;
    unansweredRate: number;
    optionCounts: Record<number, number>;
    topWrongOption?: {
        option: number;
        count: number;
        rate: number;
    };
    averageTimeSec?: number;
    timeOverExpectedRate?: number;
    averageVisitCount?: number;
    revisitRate: number;
    answerChangeCount: number;
    handwritingStrokeCount: number;
    studentCount: number;
    groupCount: number;
}

export interface QuestionResultTagStat {
    key: string;
    kind: QuestionResultGroupKind;
    title: string;
    basis: string;
    totalCount: number;
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    correctRate: number;
    wrongRate: number;
    averageTimeSec?: number;
    questionNumbers: number[];
    attemptCount: number;
    studentCount: number;
}

export interface AttemptScoreSummary {
    earnedScore: number;
    totalScore: number;
    scorePercent: number;
    gradedQuestionCount: number;
    ungradedQuestionCount: number;
}

export type AttemptGradingSource =
    | "canonical_submission"
    | "stored_totals_only"
    | "legacy_derived_current_exam"
    | "incomplete_or_invalid";

export interface AttemptGradingResolution {
    source: AttemptGradingSource;
    questionResults: QuestionResult[];
    scoreSummary: AttemptScoreSummary;
}

interface MutableTypeGroup {
    kind: QuestionResultGroupKind;
    title: string;
    basis: string;
    questionIds: Set<number>;
    questionNumbers: Set<number>;
    wrongCount: number;
    unansweredCount: number;
    slowCorrectCount: number;
    slowCorrectQuestionNumbers: Set<number>;
    totalCount: number;
    attemptIds: Set<string>;
    studentKeys: Set<string>;
    labels: Set<string>;
    concepts: Set<string>;
    recommendedQuestionIds: Set<number>;
}

interface MutableQuestionResultStat extends ExamQuestionResultStat {
    wrongOptionCounts: Record<number, number>;
    timeSumSec: number;
    timedCount: number;
    visitSum: number;
    visitTrackedCount: number;
    revisitedCount: number;
    studentKeys: Set<string>;
    groupKeys: Set<string>;
}

interface MutableQuestionResultTagStat {
    kind: QuestionResultGroupKind;
    title: string;
    basis: string;
    totalCount: number;
    correctCount: number;
    wrongCount: number;
    unansweredCount: number;
    timeSumSec: number;
    timedCount: number;
    questionNumbers: Set<number>;
    attemptIds: Set<string>;
    studentKeys: Set<string>;
}

const BASIS_BY_KIND: Record<GroupKind, string> = {
    source: "같은 지문/작품",
    concept: "같은 개념",
    unit: "같은 단원",
    label: "같은 라벨",
};

const RESULT_BASIS_BY_KIND: Record<QuestionResultGroupKind, string> = {
    ...BASIS_BY_KIND,
    skill: "같은 스킬",
    difficulty: "같은 난도",
    mistakeType: "같은 오답 원인",
};

function roundPercent(numerator: number, denominator: number): number {
    return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

/** Formats a roster turnout for display: `"명단 미연결"` when unknown (null), else `"NN%"`. */
export function formatParticipationRateLabel(rate: number | null): string {
    return rate === null ? "명단 미연결" : `${rate}%`;
}

function roundScore(value: number): number {
    return Math.round(value * 100) / 100;
}

function uniqueSorted(values: Array<string | undefined>): string[] {
    return Array.from(new Set(values.filter((value): value is string => !!value))).sort((a, b) => a.localeCompare(b, "ko"));
}

function sortedNumbers(values: Set<number>): number[] {
    return Array.from(values).sort((a, b) => a - b);
}

function groupValue(question: Question, kind: GroupKind): string | undefined {
    if (kind === "source") return question.tags?.source?.trim();
    if (kind === "concept") return question.tags?.concept?.trim() || question.label?.trim();
    if (kind === "unit") return question.tags?.unit?.trim();
    return question.label?.trim();
}

function submittedQuestionFromResult(result: QuestionResult): Question {
    return {
        id: result.questionId,
        number: result.questionNumber,
        label: result.label,
        score: result.score,
        answer: result.correctAnswer,
        tags: {
            subject: result.subject,
            unit: result.unit,
            concept: result.concept,
            skill: result.skill,
            difficulty: result.difficulty,
            cognitiveLevel: result.cognitiveLevel,
            source: result.source,
            expectedTimeSec: result.expectedTimeSec,
            mistakeTypes: result.mistakeTypes,
            prerequisites: result.prerequisites,
        },
        pdfLocation: result.pdfLocation,
        pdfRegion: result.pdfRegion,
        passagePdfRegions: result.passagePdfRegions,
    };
}

function groupKey(kind: QuestionResultGroupKind, title: string): string {
    return `${kind}:${title}`;
}

function normalizeIdentityKey(value: string | undefined): string {
    return value?.trim() || "";
}

function scopedGroupKey(value: string | undefined): string {
    const normalized = normalizeIdentityKey(value);
    const separator = normalized.indexOf("::");
    return separator > 0 ? normalizeIdentityKey(normalized.slice(0, separator)) : "";
}

function scopedStudentName(value: string | undefined): string {
    const normalized = normalizeIdentityKey(value);
    const separator = normalized.indexOf("::");
    return separator > 0 ? normalizeIdentityKey(normalized.slice(separator + 2)) : "";
}

function scopedLegacyStudentKey(
    studentName: string,
    groupId?: string,
    groupName?: string,
    regionId?: string,
    regionName?: string,
): string {
    const name = normalizeIdentityKey(studentName);
    const stableGroup = normalizeIdentityKey(groupId);
    const group = stableGroup || normalizeIdentityKey(groupName);
    const region = normalizeIdentityKey(regionId) || normalizeIdentityKey(regionName);
    if (!name) return "";
    if (stableGroup) return `${stableGroup}::${name}`;
    if (group) return region ? `${region}::${group}::${name}` : `${group}::${name}`;
    return region ? `${region}::${name}` : name;
}

export function studentScopeKeyForAttempt(attempt: Pick<Attempt, "studentId" | "studentName" | "groupId" | "groupName" | "regionId" | "regionName">): string {
    return normalizeIdentityKey(attempt.studentId)
        || scopedLegacyStudentKey(attempt.studentName, attempt.groupId, attempt.groupName, attempt.regionId, attempt.regionName);
}

function studentKeyForResult(result: QuestionResult): string {
    return normalizeIdentityKey(result.studentId)
        || scopedLegacyStudentKey(result.studentName, result.groupId, result.groupName, result.regionId, result.regionName);
}

function rosterGroupKeys(group: Pick<RosterGroup, "id" | "name">): Set<string> {
    return new Set([group.id, group.name].map(normalizeIdentityKey).filter(Boolean));
}

function rosterStudentGroupKeys(student: Pick<RosterStudent, "id" | "group">): Set<string> {
    return new Set([student.group, scopedGroupKey(student.id)].map(normalizeIdentityKey).filter(Boolean));
}

function rosterStudentBelongsToGroup(student: RosterStudent, group: Pick<RosterGroup, "id" | "name">): boolean {
    return rosterGroupMatchesStudent(group, student);
}

function attemptMatchesRosterGroup(attempt: Attempt, group: Pick<RosterGroup, "id" | "name" | "region">): boolean {
    const groupKeys = rosterGroupKeys(group);
    const groupRegion = normalizeIdentityKey(group.region);
    const attemptRegion = normalizeIdentityKey(attempt.regionName) || normalizeIdentityKey(attempt.regionId);
    if (groupRegion && attemptRegion && groupRegion !== attemptRegion) return false;

    return (!!attempt.groupId && groupKeys.has(attempt.groupId))
        || (!!attempt.groupName && groupKeys.has(attempt.groupName))
        || (!!scopedGroupKey(attempt.studentId) && groupKeys.has(scopedGroupKey(attempt.studentId)));
}

function attemptMatchesRosterStudent(attempt: Attempt, student: RosterStudent): boolean {
    const studentId = normalizeIdentityKey(student.id);
    const studentName = normalizeIdentityKey(student.name);
    const attemptStudentId = normalizeIdentityKey(attempt.studentId);
    if (studentId && attemptStudentId === studentId) return true;

    const attemptScopedName = scopedStudentName(attemptStudentId);
    const attemptName = normalizeIdentityKey(attempt.studentName) || attemptScopedName;
    if (!studentName || (attemptName !== studentName && attemptScopedName !== studentName)) {
        return false;
    }

    const studentRegion = normalizeIdentityKey(student.region);
    const attemptRegion = normalizeIdentityKey(attempt.regionName) || normalizeIdentityKey(attempt.regionId);
    if (studentRegion && attemptRegion && studentRegion !== attemptRegion) return false;

    const studentGroupKeys = rosterStudentGroupKeys(student);
    if (studentGroupKeys.size === 0) return true;

    const attemptGroupKeys = new Set(
        [attempt.groupId, attempt.groupName, scopedGroupKey(attempt.studentId)]
            .map(normalizeIdentityKey)
            .filter(Boolean)
    );
    if (attemptGroupKeys.size === 0) return false;

    return [...attemptGroupKeys].some(key => studentGroupKeys.has(key));
}

function findRosterStudentForAttempt(attempt: Attempt, students: RosterStudent[]): RosterStudent | undefined {
    return students.find(student => attemptMatchesRosterStudent(attempt, student));
}

function findRosterGroupForAttempt(
    attempt: Attempt,
    groups: RosterGroup[],
    student?: RosterStudent,
): RosterGroup | undefined {
    return (student ? groups.find(group => rosterStudentBelongsToGroup(student, group)) : undefined)
        || groups.find(group => attemptMatchesRosterGroup(attempt, group));
}

function rosterStudentsForGroup(group: Pick<RosterGroup, "id" | "name">, students: RosterStudent[]): RosterStudent[] {
    return students.filter(student => rosterStudentBelongsToGroup(student, group));
}

function resultMatchesStudentKey(result: QuestionResult, studentKey?: string): boolean {
    const requestedKey = normalizeIdentityKey(studentKey);
    if (!requestedKey) return true;

    const studentId = normalizeIdentityKey(result.studentId);
    if (studentId) return studentId === requestedKey;

    const hasGroup = !!(normalizeIdentityKey(result.groupId) || normalizeIdentityKey(result.groupName));
    if (studentKeyForResult(result) === requestedKey) return true;

    return !hasGroup && normalizeIdentityKey(result.studentName) === requestedKey;
}

function resultMatchesGroupKey(result: QuestionResult, groupKey?: string): boolean {
    const requestedKey = normalizeIdentityKey(groupKey);
    if (!requestedKey) return true;

    const groupId = normalizeIdentityKey(result.groupId);
    const groupName = normalizeIdentityKey(result.groupName);
    return groupId === requestedKey || groupName === requestedKey;
}

function resultMatchesScope(result: QuestionResult, scope: QuestionResultScope): boolean {
    return resultMatchesStudentKey(result, scope.studentKey)
        && resultMatchesGroupKey(result, scope.groupKey);
}

function isAnswered(selected: number | undefined): selected is number {
    return selected !== undefined && selected !== null && selected !== 0;
}

function isWrongOrUnansweredResult(result: Pick<QuestionResult, "status" | "isWrong" | "isUnanswered">): boolean {
    return result.isWrong || result.isUnanswered || result.status === "wrong" || result.status === "unanswered";
}

export function attemptElapsedTimeSec(attempt: Pick<Attempt, "startedAt" | "finishedAt">): number {
    const started = Date.parse(attempt.startedAt || "");
    const finished = Date.parse(attempt.finishedAt || "");
    if (!Number.isFinite(started) || !Number.isFinite(finished) || finished <= started) return 0;
    return Math.round((finished - started) / 1000);
}

function makeWeaknessGroup(
    kind: GroupKind,
    title: string,
    questions: Question[],
    wrongCount: number,
    totalCount: number,
): WeaknessGroup {
    const questionNumbers = questions.map(q => q.number).sort((a, b) => a - b);
    const basis = BASIS_BY_KIND[kind];
    return {
        key: groupKey(kind, title),
        title,
        basis,
        questionIds: questions.map(q => q.id).sort((a, b) => a - b),
        questionNumbers,
        wrongCount,
        totalCount,
        wrongRate: roundPercent(wrongCount, totalCount),
        labels: uniqueSorted(questions.map(q => q.label)),
        concepts: uniqueSorted(questions.map(q => q.tags?.concept)),
        recommendedAction: `${basis} ${questions.length}문항 재시험`,
    };
}

function sortGroups<T extends WeaknessGroup>(groups: T[]): T[] {
    return [...groups].sort((a, b) => {
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        const aFirst = a.questionNumbers[0] ?? Number.MAX_SAFE_INTEGER;
        const bFirst = b.questionNumbers[0] ?? Number.MAX_SAFE_INTEGER;
        if (aFirst !== bFirst) return aFirst - bFirst;
        return a.title.localeCompare(b.title, "ko");
    });
}

function resultGroupValues(result: QuestionResult, kind: QuestionResultGroupKind): string[] {
    if (kind === "source") return result.source ? [result.source] : [];
    if (kind === "concept") return result.concept || result.label ? [result.concept || result.label || "일반"] : ["일반"];
    if (kind === "unit") return result.unit ? [result.unit] : [];
    if (kind === "label") return [result.label || "일반"];
    if (kind === "skill") return result.skill ? [result.skill] : [];
    if (kind === "difficulty") return result.difficulty ? [result.difficulty] : [];
    return uniqueSorted(result.mistakeTypes || []);
}

const SLOW_CORRECT_EXPECTED_RATIO = 1.5;
const SLOW_CORRECT_AVERAGE_RATIO = 2;

/**
 * Correct answer that took well over budget — 1.5× the tagged expectedTimeSec,
 * or 2× the average tracked time of the result set when no expectation exists.
 */
function isSlowCorrectResult(result: QuestionResult, averageTimeSec: number): boolean {
    if (!(result.status === "correct" || result.isCorrect)) return false;
    if (typeof result.timeSec !== "number" || result.timeSec <= 0) return false;
    if (typeof result.expectedTimeSec === "number" && result.expectedTimeSec > 0) {
        return result.timeSec >= result.expectedTimeSec * SLOW_CORRECT_EXPECTED_RATIO;
    }
    return averageTimeSec > 0 && result.timeSec >= averageTimeSec * SLOW_CORRECT_AVERAGE_RATIO;
}

function averageTrackedTimeSec(results: QuestionResult[]): number {
    const timed = results.filter(result => typeof result.timeSec === "number" && result.timeSec > 0);
    if (timed.length === 0) return 0;
    return timed.reduce((sum, result) => sum + (result.timeSec || 0), 0) / timed.length;
}

function addTypeGroupValue(
    groups: Map<string, MutableTypeGroup>,
    result: QuestionResult,
    kind: QuestionResultGroupKind,
    title: string,
    slowCorrect: boolean,
) {
    const key = groupKey(kind, title);
    const basis = RESULT_BASIS_BY_KIND[kind];
    const missed = isWrongOrUnansweredResult(result);
    const existing = groups.get(key) || {
        kind,
        title,
        basis,
        questionIds: new Set<number>(),
        questionNumbers: new Set<number>(),
        wrongCount: 0,
        unansweredCount: 0,
        slowCorrectCount: 0,
        slowCorrectQuestionNumbers: new Set<number>(),
        totalCount: 0,
        attemptIds: new Set<string>(),
        studentKeys: new Set<string>(),
        labels: new Set<string>(),
        concepts: new Set<string>(),
        recommendedQuestionIds: new Set<number>(),
    };

    existing.questionIds.add(result.questionId);
    existing.questionNumbers.add(result.questionNumber);
    existing.totalCount += 1;
    existing.attemptIds.add(result.attemptId);
    existing.studentKeys.add(studentKeyForResult(result));
    if (result.label) existing.labels.add(result.label);
    if (result.concept) existing.concepts.add(result.concept);
    if (missed) {
        existing.wrongCount += 1;
        existing.recommendedQuestionIds.add(result.questionId);
    }
    if (result.status === "unanswered" || result.isUnanswered) {
        existing.unansweredCount += 1;
    }
    if (slowCorrect) {
        existing.slowCorrectCount += 1;
        existing.slowCorrectQuestionNumbers.add(result.questionNumber);
    }

    groups.set(key, existing);
}

function sortTypeGroups(groups: TypeWeaknessGroup[]): TypeWeaknessGroup[] {
    return [...groups].sort((a, b) => {
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        if (b.studentCount !== a.studentCount) return b.studentCount - a.studentCount;
        const aFirst = a.questionNumbers[0] ?? Number.MAX_SAFE_INTEGER;
        const bFirst = b.questionNumbers[0] ?? Number.MAX_SAFE_INTEGER;
        if (aFirst !== bFirst) return aFirst - bFirst;
        return a.title.localeCompare(b.title, "ko");
    });
}

function recommendationSeverity(group: TypeWeaknessGroup): LearningRecommendationSeverity {
    if (group.wrongRate >= 70 || group.wrongCount >= 4) return "urgent";
    if (group.wrongRate >= 40 || group.unansweredCount > 0 || group.wrongCount >= 2) return "review";
    // Mixed signal: an actual miss plus repeated slow-corrects means the
    // concept is unstable, not just an isolated slip.
    if (group.wrongCount >= 1 && group.slowCorrectCount >= 2) return "review";
    return "watch";
}

function recommendationPriority(group: TypeWeaknessGroup): number {
    return (
        group.wrongRate * 10
        + group.wrongCount * 8
        + group.studentCount * 3
        + group.unansweredCount * 5
        + group.slowCorrectCount * 4
        + group.attemptCount
    );
}

function sourceAttemptIdForRecommendation(
    exam: Exam,
    options: LearningRecommendationOptions,
): string {
    if (options.scope === "attempt" && options.attempt?.id) return options.attempt.id;
    if (options.scope === "student") return `student:${options.studentKey || (options.attempt ? studentScopeKeyForAttempt(options.attempt) : exam.id)}`;
    if (options.scope === "class") return `class:${options.groupKey || options.attempt?.groupId || options.attempt?.groupName || exam.id}`;
    return `exam:${exam.id}`;
}

function recommendationReason(group: TypeWeaknessGroup, scope: LearningRecommendationScope): string {
    const scopeLabel: Record<LearningRecommendationScope, string> = {
        attempt: "이번 제출",
        student: "선택 학생",
        class: "선택 반",
        exam: "시험 전체",
    };
    const unanswered = group.unansweredCount > 0 ? `, 미응답 ${group.unansweredCount}건 포함` : "";
    const spread = scope === "attempt"
        ? ""
        : ` · 학생 ${group.studentCount}명, 제출 ${group.attemptCount}건`;
    if (group.wrongCount === 0 && group.slowCorrectCount > 0) {
        // Slow-but-correct only: the score held up, the concept didn't.
        return `${scopeLabel[scope]}에서 ${group.basis} "${group.title}"은 정답이었지만 ${group.slowCorrectCount}문항이 기준 시간을 크게 넘겼습니다(불안정 개념)${spread}`;
    }
    const slow = group.slowCorrectCount > 0 ? `, 정답이지만 오래 걸린 문항 ${group.slowCorrectCount}건` : "";
    return `${scopeLabel[scope]}에서 ${group.basis} "${group.title}" 오답/미응답 ${group.wrongCount}/${group.totalCount}${unanswered}${slow}${spread}`;
}

function sortLearningRecommendations(recommendations: LearningRecommendation[]): LearningRecommendation[] {
    const kindRank: Record<QuestionResultGroupKind, number> = {
        concept: 0,
        source: 1,
        unit: 2,
        skill: 3,
        mistakeType: 4,
        difficulty: 5,
        label: 6,
    };

    return [...recommendations].sort((a, b) => {
        if (b.priorityScore !== a.priorityScore) return b.priorityScore - a.priorityScore;
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        if (kindRank[a.kind] !== kindRank[b.kind]) return kindRank[a.kind] - kindRank[b.kind];
        return a.title.localeCompare(b.title, "ko");
    });
}

function validStoredTotals(
    earnedScore: unknown,
    totalScore: unknown,
): { earnedScore: number; totalScore: number } | null {
    if (
        typeof earnedScore !== "number"
        || typeof totalScore !== "number"
        || !Number.isFinite(earnedScore)
        || !Number.isFinite(totalScore)
        || Object.is(earnedScore, -0)
        || Object.is(totalScore, -0)
        || earnedScore < 0
        || totalScore < 0
        || earnedScore > totalScore
        || (totalScore === 0 && earnedScore !== 0)
    ) return null;
    return { earnedScore: roundScore(earnedScore), totalScore: roundScore(totalScore) };
}

function isOptionalFiniteNonNegative(value: number | undefined): boolean {
    return value === undefined || (Number.isFinite(value) && value >= 0 && !Object.is(value, -0));
}

function isOptionalNonNegativeInteger(value: number | undefined): boolean {
    return value === undefined || (Number.isInteger(value) && value >= 0 && !Object.is(value, -0));
}

function isInternallyValidStoredResult(result: QuestionResult): boolean {
    if (!result || typeof result !== "object") return false;
    if (!(["correct", "wrong", "unanswered", "ungraded"] as const).includes(result.status)) return false;
    if (
        result.schemaVersion !== 1
        || !Number.isInteger(result.questionId)
        || result.questionId <= 0
        || !Number.isInteger(result.questionNumber)
        || result.questionNumber <= 0
        || !Number.isFinite(result.score)
        || result.score < 0
        || Object.is(result.score, -0)
        || !Number.isFinite(result.earnedScore)
        || result.earnedScore < 0
        || Object.is(result.earnedScore, -0)
        || result.earnedScore > result.score
        || !isOptionalFiniteNonNegative(result.timeSec)
        || !isOptionalNonNegativeInteger(result.visitCount)
        || !isOptionalNonNegativeInteger(result.revisitCount)
        || !isOptionalNonNegativeInteger(result.answerChangeCount)
        || !isOptionalNonNegativeInteger(result.handwritingStrokeCount)
        || !isOptionalNonNegativeInteger(result.handwritingPage)
    ) return false;
    if (
        result.selectedAnswer !== undefined
        && (!Number.isInteger(result.selectedAnswer) || result.selectedAnswer <= 0 || Object.is(result.selectedAnswer, -0))
    ) return false;
    if (
        result.isCorrect !== (result.status === "correct")
        || result.isWrong !== (result.status === "wrong")
        || result.isUnanswered !== (result.status === "unanswered")
    ) return false;
    if (result.status === "correct" && roundScore(result.earnedScore) !== roundScore(result.score)) return false;
    if (result.status !== "correct" && roundScore(result.earnedScore) !== 0) return false;
    if (result.status !== "ungraded" && result.score <= 0) return false;
    if ((result.status === "correct" || result.status === "wrong") && !isAnswered(result.selectedAnswer)) return false;
    if (result.status === "unanswered" && isAnswered(result.selectedAnswer)) return false;
    if (result.status !== "ungraded" && (
        !Number.isSafeInteger(result.correctAnswer) || Number(result.correctAnswer) <= 0
    )) return false;
    if (result.correctAnswer !== undefined) {
        if (!Number.isInteger(result.correctAnswer) || result.correctAnswer <= 0 || result.status === "ungraded") return false;
        if (result.status === "correct" && result.selectedAnswer !== result.correctAnswer) return false;
        if (result.status === "wrong" && result.selectedAnswer === result.correctAnswer) return false;
    }
    return true;
}

type GradingIdentityField =
    | "organizationId"
    | "classId"
    | "studentProfileId"
    | "studentId"
    | "groupId"
    | "groupName"
    | "regionId"
    | "regionName"
    | "identityType";

interface AttemptGradingSnapshot {
    attempt: Attempt;
    storedResults?: QuestionResult[];
    storedResultsInvalid: boolean;
    storedSource: Attempt["questionResultsSource"];
    storedSourceInvalid: boolean;
    retakeInvalid: boolean;
    rawScore: unknown;
    rawTotalScore: unknown;
    questionResultsQuestionCount: unknown;
    questionResultsDefinitionManifestHash: unknown;
    questionResultsFullEvidenceHash: unknown;
    evidenceAttested: boolean;
}

const MAX_CANONICAL_ATTEMPT_QUESTION_RESULTS = 500;

function snapshotAttemptGradingEvidence(attempt: Attempt): AttemptGradingSnapshot | null {
    try {
        const rawResults: unknown = attempt.questionResults;
        const rawSource: unknown = attempt.questionResultsSource;
        const rawRetake: unknown = attempt.retake;
        const rawAnswers: unknown = attempt.answers;
        const rawQuestionTimings: unknown = attempt.questionTimings;
        const rawQuestionDrawings: unknown = attempt.questionDrawings;
        const rawScore: unknown = attempt.score;
        const rawTotalScore: unknown = attempt.totalScore;
        const questionResultsQuestionCount: unknown = attempt.questionResultsQuestionCount;
        const questionResultsDefinitionManifestHash: unknown = attempt.questionResultsDefinitionManifestHash;
        const questionResultsFullEvidenceHash: unknown = attempt.questionResultsFullEvidenceHash;
        const evidenceAttested = Array.isArray(rawResults)
            && hasCanonicalQuestionResultEvidenceAttestation(attempt, rawResults);
        const storedResults = Array.isArray(rawResults) && rawResults.length <= MAX_CANONICAL_ATTEMPT_QUESTION_RESULTS
            ? rawResults.slice()
            : undefined;
        const rawRetakeQuestionIds = rawRetake && typeof rawRetake === "object" && !Array.isArray(rawRetake)
            ? (rawRetake as NonNullable<Attempt["retake"]>).questionIds
            : undefined;
        const retakeQuestionIdsValid = Array.isArray(rawRetakeQuestionIds)
            && rawRetakeQuestionIds.length <= MAX_CANONICAL_ATTEMPT_QUESTION_RESULTS;
        const retake = rawRetake && typeof rawRetake === "object" && !Array.isArray(rawRetake) && retakeQuestionIdsValid
            ? {
                ...(rawRetake as NonNullable<Attempt["retake"]>),
                questionIds: [...rawRetakeQuestionIds],
            }
            : undefined;
        const materialized: Attempt = {
            id: attempt.id,
            examId: attempt.examId,
            examTitle: attempt.examTitle,
            organizationId: attempt.organizationId,
            classId: attempt.classId,
            assignmentId: attempt.assignmentId,
            assignmentRevision: attempt.assignmentRevision,
            studentProfileId: attempt.studentProfileId,
            studentName: attempt.studentName,
            studentId: attempt.studentId,
            groupId: attempt.groupId,
            groupName: attempt.groupName,
            regionId: attempt.regionId,
            regionName: attempt.regionName,
            identityType: attempt.identityType,
            startedAt: attempt.startedAt,
            finishedAt: attempt.finishedAt,
            score: typeof rawScore === "number" ? rawScore : Number.NaN,
            totalScore: typeof rawTotalScore === "number" ? rawTotalScore : Number.NaN,
            answers: rawAnswers && typeof rawAnswers === "object" && !Array.isArray(rawAnswers)
                ? { ...(rawAnswers as Record<number, number>) }
                : {},
            status: attempt.status,
            questionResultsQuestionCount: typeof questionResultsQuestionCount === "number"
                ? questionResultsQuestionCount
                : undefined,
            questionResultsDefinitionManifestHash: typeof questionResultsDefinitionManifestHash === "string"
                ? questionResultsDefinitionManifestHash
                : undefined,
            questionResultsFullEvidenceHash: typeof questionResultsFullEvidenceHash === "string"
                ? questionResultsFullEvidenceHash
                : undefined,
            questionResults: storedResults,
            questionResultsSource: rawSource === "legacy_derived_current_exam" ? rawSource : undefined,
            questionTimings: Array.isArray(rawQuestionTimings)
                ? rawQuestionTimings.map(timing => ({ ...timing }))
                : undefined,
            questionDrawings: Array.isArray(rawQuestionDrawings)
                ? rawQuestionDrawings.map(drawing => ({ ...drawing }))
                : undefined,
            retake,
        };
        return {
            attempt: materialized,
            storedResults,
            storedResultsInvalid: rawResults !== undefined
                && (!Array.isArray(rawResults) || rawResults.length > MAX_CANONICAL_ATTEMPT_QUESTION_RESULTS),
            storedSource: rawSource === "legacy_derived_current_exam" ? rawSource : undefined,
            storedSourceInvalid: rawSource !== undefined && rawSource !== "legacy_derived_current_exam",
            retakeInvalid: rawRetake !== undefined
                && (!rawRetake
                    || typeof rawRetake !== "object"
                    || Array.isArray(rawRetake)
                    || !retakeQuestionIdsValid),
            rawScore,
            rawTotalScore,
            questionResultsQuestionCount,
            questionResultsDefinitionManifestHash,
            questionResultsFullEvidenceHash,
            evidenceAttested,
        };
    } catch {
        return null;
    }
}

function storedIdentityMatchesAttempt(result: QuestionResult, attempt: Attempt): boolean {
    if (
        result.attemptId !== attempt.id
        || result.examId !== attempt.examId
        || result.examTitle !== attempt.examTitle
        || result.studentName !== attempt.studentName
        || result.finishedAt !== attempt.finishedAt
    ) return false;
    const exactFields: GradingIdentityField[] = [
        "organizationId", "classId", "studentProfileId", "studentId", "identityType",
        "groupId", "groupName", "regionId", "regionName",
    ];
    if (!exactFields.every(field => result[field] === attempt[field])) return false;

    const assignmentId = attempt.assignmentId?.trim();
    if (assignmentId) {
        return Number.isInteger(attempt.assignmentRevision)
            && (attempt.assignmentRevision || 0) > 0
            && result.assignmentId === assignmentId
            && result.assignmentRevision === attempt.assignmentRevision;
    }
    return result.assignmentId === undefined && result.assignmentRevision === undefined;
}

function matchesAggregateWithinRowRounding(rowSum: number, aggregate: number, rowCount: number): boolean {
    return Math.abs(rowSum - roundScore(aggregate)) <= ((Math.max(0, rowCount) + 1) * 0.005) + 1e-9;
}

function hasCanonicalStoredResults(
    attempt: Attempt,
    storedResults: QuestionResult[],
    totals: { earnedScore: number; totalScore: number },
    trustServerVerified = false,
): boolean {
    if (storedResults.length === 0) return false;
    if (
        attempt.questionResultsQuestionCount !== storedResults.length
        || typeof attempt.questionResultsDefinitionManifestHash !== "string"
        || !/^sha256:[a-f0-9]{64}$/.test(attempt.questionResultsDefinitionManifestHash)
        || typeof attempt.questionResultsFullEvidenceHash !== "string"
        || !/^sha256:[a-f0-9]{64}$/.test(attempt.questionResultsFullEvidenceHash)
    ) return false;
    const seen = new Set<number>();
    for (const result of storedResults) {
        if (
            !result
            || typeof result !== "object"
            || !storedIdentityMatchesAttempt(result, attempt)
            || seen.has(result.questionId)
            || !isInternallyValidStoredResult(result)
        ) return false;
        seen.add(result.questionId);
    }
    if (attempt.retake) {
        const requested = attempt.retake.questionIds;
        const expected = new Set(requested);
        if (requested.length === 0 || expected.size !== requested.length || expected.size !== seen.size) return false;
        if (requested.some(questionId => !seen.has(questionId))) return false;
    }
    const gradable = storedResults.filter(result => result.status !== "ungraded");
    const earned = roundScore(gradable.reduce((sum, result) => sum + result.earnedScore, 0));
    const total = roundScore(gradable.reduce((sum, result) => sum + result.score, 0));
    if (!(matchesAggregateWithinRowRounding(earned, totals.earnedScore, gradable.length)
        && matchesAggregateWithinRowRounding(total, totals.totalScore, gradable.length))) return false;
    if (trustServerVerified) return true;
    let evidence;
    try {
        evidence = buildCanonicalQuestionResultEvidence(attempt, storedResults);
    } catch {
        return false;
    }
    return attempt.questionResultsQuestionCount === evidence.questionResultsQuestionCount
        && attempt.questionResultsDefinitionManifestHash === evidence.questionResultsDefinitionManifestHash
        && attempt.questionResultsFullEvidenceHash === evidence.questionResultsFullEvidenceHash;
}

function hasValidLegacyRepairResults(
    attempt: Attempt,
    storedResults: QuestionResult[],
    totals: { earnedScore: number; totalScore: number },
): boolean {
    const shadow: Attempt = {
        ...attempt,
        questionResultsQuestionCount: storedResults.length,
        questionResultsDefinitionManifestHash: "sha256:" + "0".repeat(64),
        questionResultsFullEvidenceHash: "sha256:" + "0".repeat(64),
    };
    let evidence;
    try {
        evidence = buildCanonicalQuestionResultEvidence(shadow, storedResults);
    } catch {
        return false;
    }
    shadow.questionResultsDefinitionManifestHash = evidence.questionResultsDefinitionManifestHash;
    shadow.questionResultsFullEvidenceHash = evidence.questionResultsFullEvidenceHash;
    return hasCanonicalStoredResults(shadow, storedResults, totals);
}

function canonicalResultForAttempt(attempt: Attempt, stored: QuestionResult): QuestionResult {
    // Every identity/display field is already exact and the full digest binds
    // the row. Reuse the immutable evidence reference instead of cloning a
    // million result objects for the maximum analytics collection.
    void attempt;
    return stored;
}

function resolveAttemptGradingInternal(
    exam: Exam,
    attempt: Attempt,
    trustServerVerified = false,
): AttemptGradingResolution {
    const snapshot = snapshotAttemptGradingEvidence(attempt);
    const totals = snapshot ? validStoredTotals(snapshot.rawScore, snapshot.rawTotalScore) : null;
    const invalid = (): AttemptGradingResolution => ({
        source: totals && totals.totalScore > 0 ? "stored_totals_only" : "incomplete_or_invalid",
        questionResults: [],
        scoreSummary: {
            earnedScore: totals?.earnedScore ?? 0,
            totalScore: totals?.totalScore ?? 0,
            scorePercent: roundPercent(totals?.earnedScore ?? 0, totals?.totalScore ?? 0),
            gradedQuestionCount: 0,
            ungradedQuestionCount: 0,
        },
    });
    if (
        !snapshot
        || snapshot.attempt.examId !== exam.id
        || snapshot.storedSourceInvalid
        || snapshot.retakeInvalid
    ) return invalid();
    if (snapshot.storedResultsInvalid) return invalid();
    if (snapshot.storedResults === undefined) {
        if (snapshot.attempt.retake) {
            const ids = snapshot.attempt.retake.questionIds;
            const unique = new Set(ids);
            const examIds = new Set(exam.questions.map(question => question.id));
            if (
                ids.length === 0
                || unique.size !== ids.length
                || ids.some(questionId => !examIds.has(questionId))
            ) return invalid();
        }
        const derived = buildQuestionResults(exam, snapshot.attempt);
        if (derived.length === 0 || derived.some(result => !isInternallyValidStoredResult(result))) return invalid();
        return {
            source: "legacy_derived_current_exam",
            questionResults: derived,
            scoreSummary: summarizeQuestionResults(derived, snapshot.attempt),
        };
    }
    if (!totals) return invalid();
    const validStoredResults = snapshot.storedSource === "legacy_derived_current_exam"
        ? hasValidLegacyRepairResults(snapshot.attempt, snapshot.storedResults, totals)
        : hasCanonicalStoredResults(
            snapshot.attempt,
            snapshot.storedResults,
            totals,
            trustServerVerified && snapshot.evidenceAttested,
        );
    if (!validStoredResults) return invalid();
    const results = snapshot.storedResults.map(result => canonicalResultForAttempt(snapshot.attempt, result));
    const rowSummary = summarizeQuestionResults(results);
    return {
        source: snapshot.storedSource === "legacy_derived_current_exam"
            ? "legacy_derived_current_exam"
            : "canonical_submission",
        questionResults: results,
        scoreSummary: {
            ...rowSummary,
            earnedScore: totals.earnedScore,
            totalScore: totals.totalScore,
            scorePercent: roundPercent(totals.earnedScore, totals.totalScore),
        },
    };
}

export function resolveAttemptGrading(exam: Exam, attempt: Attempt): AttemptGradingResolution {
    return resolveAttemptGradingInternal(exam, attempt, false);
}

/**
 * Builds the student review question set from immutable submitted evidence.
 * Current exam rows may contribute an explanation only; submitted numbering,
 * labels, scores, answer keys, tags, and deleted questions come from the
 * canonical grading rows so later exam edits cannot rewrite history.
 */
export function buildStudentReviewQuestionSnapshot(exam: Exam, attempt: Attempt): Question[] {
    const grading = resolveAttemptGrading(exam, attempt);
    if (grading.source === "legacy_derived_current_exam") {
        const retakeIds = attempt.retake?.questionIds?.length
            ? new Set(attempt.retake.questionIds)
            : null;
        return exam.questions.filter(question => !retakeIds || retakeIds.has(question.id));
    }
    if (grading.source !== "canonical_submission") return [];
    return grading.questionResults.map(result => {
        const largestChoice = Math.max(result.selectedAnswer || 0, result.correctAnswer || 0);
        return {
            id: result.questionId,
            number: result.questionNumber,
            ...(result.label ? { label: result.label } : {}),
            score: result.score,
            ...(result.correctAnswer ? { answer: result.correctAnswer } : {}),
            choices: largestChoice > 4 ? 5 : 4,
            tags: {
                ...(result.subject ? { subject: result.subject } : {}),
                ...(result.unit ? { unit: result.unit } : {}),
                ...(result.concept ? { concept: result.concept } : {}),
                ...(result.skill ? { skill: result.skill } : {}),
                ...(result.difficulty ? { difficulty: result.difficulty } : {}),
                ...(result.cognitiveLevel ? { cognitiveLevel: result.cognitiveLevel } : {}),
                ...(result.source ? { source: result.source } : {}),
                ...(typeof result.expectedTimeSec === "number" ? { expectedTimeSec: result.expectedTimeSec } : {}),
                ...(result.mistakeTypes ? { mistakeTypes: result.mistakeTypes } : {}),
                ...(result.prerequisites ? { prerequisites: result.prerequisites } : {}),
            },
            ...(result.pdfLocation ? { pdfLocation: result.pdfLocation } : {}),
            ...(result.pdfRegion ? { pdfRegion: result.pdfRegion } : {}),
            ...(result.passagePdfRegions ? { passagePdfRegions: result.passagePdfRegions } : {}),
        } satisfies Question;
    });
}

export function getAttemptQuestionResults(exam: Exam, attempt: Attempt): QuestionResult[] {
    const grading = resolveAttemptGrading(exam, attempt);
    return grading.source === "canonical_submission" ? grading.questionResults : [];
}

export interface CanonicalAttemptAnalyticsIndex {
    readonly examId: string;
    readonly collectionKey: string;
    readonly diagnostics: Readonly<{
        attemptCount: number;
        resolutionCount: number;
        canonicalQuestionResultCount: number;
    }>;
    resolutionFor(attempt: Attempt): AttemptGradingResolution;
    resultsFor(attempt: Attempt): readonly QuestionResult[];
}

/**
 * Request-scoped immutable grading precompute. It intentionally owns no global
 * cache: an index can only serve the exact attempt object collection and exact
 * evidence hashes/generations captured at construction time.
 */
export function buildCanonicalAttemptAnalyticsIndex(
    exam: Exam,
    attempts: readonly Attempt[],
): CanonicalAttemptAnalyticsIndex {
    const exactAttempts = new Set(attempts);
    const resolutions = new Map<Attempt, AttemptGradingResolution>();
    let canonicalQuestionResultCount = 0;
    for (const attempt of attempts) {
        const resolution = resolveAttemptGradingInternal(exam, attempt, true);
        resolutions.set(attempt, resolution);
        if (resolution.source === "canonical_submission") {
            canonicalQuestionResultCount += resolution.questionResults.length;
        }
    }
    const diagnostics = Object.freeze({
        attemptCount: attempts.length,
        resolutionCount: resolutions.size,
        canonicalQuestionResultCount,
    });
    const collectionKey = attempts.map(attempt => [
        attempt.id,
        attempt.assignmentId || "",
        attempt.assignmentRevision || 0,
        attempt.questionResultsQuestionCount || 0,
        attempt.questionResultsDefinitionManifestHash || "",
        attempt.questionResultsFullEvidenceHash || "",
    ].join("\u001f")).join("\u001e");
    return Object.freeze({
        examId: exam.id,
        collectionKey,
        diagnostics,
        resolutionFor(attempt: Attempt) {
            if (!exactAttempts.has(attempt)) return resolveAttemptGrading(exam, attempt);
            return resolutions.get(attempt) || resolveAttemptGrading(exam, attempt);
        },
        resultsFor(attempt: Attempt) {
            const resolution = exactAttempts.has(attempt)
                ? resolutions.get(attempt)
                : undefined;
            return resolution?.source === "canonical_submission" ? resolution.questionResults : [];
        },
    });
}

function gradingFor(
    exam: Exam,
    attempt: Attempt,
    index?: CanonicalAttemptAnalyticsIndex,
): AttemptGradingResolution {
    return index?.examId === exam.id ? index.resolutionFor(attempt) : resolveAttemptGrading(exam, attempt);
}

export function summarizeQuestionResults(
    results: QuestionResult[],
    fallback: Pick<Attempt, "score" | "totalScore"> = { score: 0, totalScore: 0 },
): AttemptScoreSummary {
    let earnedScore = 0;
    let totalScore = 0;
    let gradedQuestionCount = 0;
    let ungradedQuestionCount = 0;

    for (const result of results) {
        if (result.status === "ungraded") {
            ungradedQuestionCount += 1;
            continue;
        }
        gradedQuestionCount += 1;
        earnedScore += result.earnedScore;
        totalScore += result.score;
    }

    if (totalScore <= 0) {
        const validFallback = validStoredTotals(fallback.score, fallback.totalScore);
        const fallbackEarned = validFallback?.earnedScore ?? 0;
        const fallbackTotal = validFallback?.totalScore ?? 0;
        return {
            earnedScore: fallbackEarned,
            totalScore: fallbackTotal,
            scorePercent: roundPercent(fallbackEarned, fallbackTotal),
            gradedQuestionCount,
            ungradedQuestionCount,
        };
    }

    const roundedEarned = roundScore(earnedScore);
    const roundedTotal = roundScore(totalScore);
    return {
        earnedScore: roundedEarned,
        totalScore: roundedTotal,
        scorePercent: roundPercent(roundedEarned, roundedTotal),
        gradedQuestionCount,
        ungradedQuestionCount,
    };
}

export function summarizeAttemptScore(
    exam: Exam,
    attempt: Attempt,
    index?: CanonicalAttemptAnalyticsIndex,
): AttemptScoreSummary {
    return gradingFor(exam, attempt, index).scoreSummary;
}

export function summarizeCanonicalQuestionSubset(
    exam: Exam,
    attempt: Attempt,
    questionIds: number[],
): AttemptScoreSummary | null {
    if (!Array.isArray(questionIds) || questionIds.length === 0) return null;
    const unique = new Set(questionIds);
    if (unique.size !== questionIds.length) return null;
    const grading = resolveAttemptGrading(exam, attempt);
    if (grading.source !== "canonical_submission") return null;
    const byId = new Map(grading.questionResults.map(result => [result.questionId, result]));
    const scoped: QuestionResult[] = [];
    for (const id of questionIds) {
        const result = byId.get(id);
        if (!result) return null;
        scoped.push(result);
    }
    return summarizeQuestionResults(scoped);
}

export function collectQuestionResults(
    exam: Exam,
    attempts: Attempt[],
    scope: QuestionResultScope = {},
    index?: CanonicalAttemptAnalyticsIndex,
): QuestionResult[] {
    return attempts
        .filter(attempt => attempt.examId === exam.id)
        .filter(attempt => scope.includeRetakes || !attempt.retake)
        .flatMap(attempt => {
            const grading = gradingFor(exam, attempt, index);
            return grading.source === "canonical_submission" ? grading.questionResults : [];
        })
        .filter(result => resultMatchesScope(result, scope));
}

export function buildTypeWeaknessGroups(results: QuestionResult[], kind: QuestionResultGroupKind = "concept"): TypeWeaknessGroup[] {
    const groups = new Map<string, MutableTypeGroup>();
    const averageTimeSec = averageTrackedTimeSec(results);

    for (const result of results) {
        if (result.status === "ungraded") continue;
        const slowCorrect = isSlowCorrectResult(result, averageTimeSec);
        for (const title of resultGroupValues(result, kind)) {
            addTypeGroupValue(groups, result, kind, title, slowCorrect);
        }
    }

    return sortTypeGroups(Array.from(groups.entries()).map(([key, group]) => {
        const recommendedQuestionIds = sortedNumbers(group.recommendedQuestionIds);
        const recommendedCount = recommendedQuestionIds.length || group.questionIds.size;
        return {
            key,
            kind: group.kind,
            title: group.title,
            basis: group.basis,
            questionIds: sortedNumbers(group.questionIds),
            questionNumbers: sortedNumbers(group.questionNumbers),
            wrongCount: group.wrongCount,
            unansweredCount: group.unansweredCount,
            slowCorrectCount: group.slowCorrectCount,
            slowCorrectQuestionNumbers: sortedNumbers(group.slowCorrectQuestionNumbers),
            totalCount: group.totalCount,
            wrongRate: roundPercent(group.wrongCount, group.totalCount),
            attemptCount: group.attemptIds.size,
            studentCount: group.studentKeys.size,
            labels: Array.from(group.labels).sort((a, b) => a.localeCompare(b, "ko")),
            concepts: Array.from(group.concepts).sort((a, b) => a.localeCompare(b, "ko")),
            recommendedQuestionIds,
            recommendedAction: `${group.basis} ${recommendedCount}문항 재추천`,
        };
    }));
}

export function buildQuestionResultTagStats(
    results: QuestionResult[],
    kind: QuestionResultGroupKind = "label",
): QuestionResultTagStat[] {
    const groups = new Map<string, MutableQuestionResultTagStat>();

    for (const result of results) {
        if (result.status === "ungraded") continue;
        for (const title of resultGroupValues(result, kind)) {
            const key = groupKey(kind, title);
            const existing = groups.get(key) || {
                kind,
                title,
                basis: RESULT_BASIS_BY_KIND[kind],
                totalCount: 0,
                correctCount: 0,
                wrongCount: 0,
                unansweredCount: 0,
                timeSumSec: 0,
                timedCount: 0,
                questionNumbers: new Set<number>(),
                attemptIds: new Set<string>(),
                studentKeys: new Set<string>(),
            };

            existing.totalCount += 1;
            existing.questionNumbers.add(result.questionNumber);
            existing.attemptIds.add(result.attemptId);
            existing.studentKeys.add(studentKeyForResult(result));
            if (typeof result.timeSec === "number") {
                existing.timeSumSec += Math.max(0, result.timeSec);
                existing.timedCount += 1;
            }
            if (result.status === "correct" || result.isCorrect) {
                existing.correctCount += 1;
            } else if (result.status === "unanswered" || result.isUnanswered) {
                existing.unansweredCount += 1;
                existing.wrongCount += 1;
            } else if (result.status === "wrong" || result.isWrong) {
                existing.wrongCount += 1;
            }
            groups.set(key, existing);
        }
    }

    return Array.from(groups.entries()).map(([key, group]) => ({
        key,
        kind: group.kind,
        title: group.title,
        basis: group.basis,
        totalCount: group.totalCount,
        correctCount: group.correctCount,
        wrongCount: group.wrongCount,
        unansweredCount: group.unansweredCount,
        correctRate: roundPercent(group.correctCount, group.totalCount),
        wrongRate: roundPercent(group.wrongCount, group.totalCount),
        averageTimeSec: group.timedCount > 0 ? Math.round(group.timeSumSec / group.timedCount) : undefined,
        questionNumbers: sortedNumbers(group.questionNumbers),
        attemptCount: group.attemptIds.size,
        studentCount: group.studentKeys.size,
    })).sort((a, b) => {
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
        if (b.totalCount !== a.totalCount) return b.totalCount - a.totalCount;
        return a.title.localeCompare(b.title, "ko");
    });
}

export function buildStudentTypeWeaknessGroups(
    exam: Exam,
    attempts: Attempt[],
    studentKey: string,
    kind: QuestionResultGroupKind = "concept",
): TypeWeaknessGroup[] {
    return buildTypeWeaknessGroups(collectQuestionResults(exam, attempts, { studentKey }), kind);
}

export function buildClassTypeWeaknessGroups(
    exam: Exam,
    attempts: Attempt[],
    groupKey?: string,
    kind: QuestionResultGroupKind = "concept",
): TypeWeaknessGroup[] {
    return buildTypeWeaknessGroups(collectQuestionResults(exam, attempts, { groupKey }), kind);
}

export function buildLearningRecommendations(
    exam: Exam,
    attempts: Attempt[],
    options: LearningRecommendationOptions,
    index?: CanonicalAttemptAnalyticsIndex,
): LearningRecommendation[] {
    const kinds: QuestionResultGroupKind[] = options.kinds?.length ? options.kinds : ["concept", "mistakeType"];
    const sourceAttemptId = sourceAttemptIdForRecommendation(exam, options);
    const results = options.scope === "attempt" && options.attempt
        ? (() => {
            const grading = gradingFor(exam, options.attempt!, index);
            return grading.source === "canonical_submission" ? grading.questionResults : [];
        })()
        : collectQuestionResults(exam, attempts, {
            includeRetakes: options.includeRetakes,
            studentKey: options.scope === "student" ? options.studentKey : undefined,
            groupKey: !options.prefiltered && (options.scope === "class" || options.scope === "student")
                ? options.groupKey
                : undefined,
        }, index);

    const seen = new Set<string>();
    const recommendations: LearningRecommendation[] = [];

    const includeSlowCorrect = options.includeSlowCorrect === true;
    for (const kind of kinds) {
        // Wrong answers always qualify; slow-but-correct groups need at least
        // two occurrences before they surface (one slow question is noise), and
        // only when the caller opted in.
        for (const group of buildTypeWeaknessGroups(results, kind).filter(item => (
            item.wrongCount > 0 || (includeSlowCorrect && item.slowCorrectCount >= 2)
        ))) {
            const retakeQuestionIds = group.recommendedQuestionIds.length > 0
                ? group.recommendedQuestionIds
                : group.questionIds;
            const dedupeKey = `${kind}:${retakeQuestionIds.join(",")}:${group.title}`;
            if (seen.has(dedupeKey)) continue;
            seen.add(dedupeKey);

            const retakeConcepts = group.concepts.length > 0
                ? group.concepts
                : group.kind === "concept"
                    ? [group.title]
                    : [];

            recommendations.push({
                ...group,
                scope: options.scope,
                severity: recommendationSeverity(group),
                priorityScore: recommendationPriority(group),
                reason: recommendationReason(group, options.scope),
                sourceAttemptId,
                retakeMode: "similar",
                retakeQuestionIds,
                retakeLabels: group.labels,
                retakeConcepts,
                recommendedAction: `${group.basis} ${retakeQuestionIds.length}문항 재추천`,
            });
        }
    }

    const sorted = sortLearningRecommendations(recommendations);
    return typeof options.limit === "number" ? sorted.slice(0, Math.max(0, options.limit)) : sorted;
}

interface GroupedAttemptEntry {
    groupKey: string;
    groupName: string;
    regionName?: string;
    rosterStudents: RosterStudent[];
    attempts: Attempt[];
}

/**
 * Buckets attempts into roster-aware class groups. Shared by buildClassExamWeaknessMatrix
 * (per-class weakness/recommendation rows) and buildClassExamScoreGroups (per-class score
 * ranges) so both features agree on exactly which attempts belong to which class.
 */
function buildGroupedAttemptEntries(
    exam: Exam,
    attempts: Attempt[],
    options: Pick<ClassExamWeaknessMatrixOptions, "rosterGroups" | "rosterStudents" | "includeRetakes">,
): GroupedAttemptEntry[] {
    const rosterGroups = options.rosterGroups || [];
    const rosterStudents = options.rosterStudents || [];
    const groupedAttempts = new Map<string, GroupedAttemptEntry>();
    const includeRetakes = !!options.includeRetakes;

    const rosterGroupByKey = new Map<string, RosterGroup>();
    for (const group of rosterGroups) {
        for (const key of rosterGroupKeys(group)) {
            rosterGroupByKey.set(key, group);
        }
    }

    const ensureGroup = (
        groupKey: string,
        groupName: string,
        regionName?: string,
        seededRosterStudents: RosterStudent[] = [],
    ) => {
        const safeGroupKey = normalizeIdentityKey(groupKey);
        if (!safeGroupKey) return undefined;
        const existing = groupedAttempts.get(safeGroupKey);
        if (existing) {
            if (!existing.regionName && regionName) existing.regionName = regionName;
            if (existing.rosterStudents.length === 0 && seededRosterStudents.length > 0) {
                existing.rosterStudents = seededRosterStudents;
            }
            return existing;
        }

        const created = {
            groupKey: safeGroupKey,
            groupName: normalizeIdentityKey(groupName) || safeGroupKey,
            regionName,
            rosterStudents: seededRosterStudents,
            attempts: [],
        };
        groupedAttempts.set(safeGroupKey, created);
        return created;
    };

    if (exam.accessConfig?.type === "group") {
        for (const selectedGroupId of exam.accessConfig.groupIds || []) {
            const rosterGroup = rosterGroupByKey.get(normalizeIdentityKey(selectedGroupId));
            if (!rosterGroup) continue;
            ensureGroup(
                rosterGroup.id,
                rosterGroup.name,
                rosterGroup.region,
                rosterStudentsForGroup(rosterGroup, rosterStudents),
            );
        }
    }

    for (const attempt of attempts) {
        if (!includeRetakes && attempt.retake) continue;
        const rosterStudent = findRosterStudentForAttempt(attempt, rosterStudents);
        const rosterGroup = findRosterGroupForAttempt(attempt, rosterGroups, rosterStudent);
        const fallbackGroupKey = normalizeIdentityKey(attempt.groupId)
            || normalizeIdentityKey(attempt.groupName)
            || normalizeIdentityKey(rosterStudent?.group);
        const groupKey = rosterGroup?.id || fallbackGroupKey;
        if (!groupKey) continue;
        const groupName = rosterGroup?.name
            || normalizeIdentityKey(attempt.groupName)
            || normalizeIdentityKey(attempt.groupId)
            || normalizeIdentityKey(rosterStudent?.group)
            || groupKey;
        const groupRosterStudents = rosterGroup
            ? rosterStudentsForGroup(rosterGroup, rosterStudents)
            : rosterStudents.filter(student => normalizeIdentityKey(student.group) === groupName || normalizeIdentityKey(student.group) === groupKey);
        const current = ensureGroup(groupKey, groupName, rosterGroup?.region, groupRosterStudents);
        // Roster membership classifies the matrix row, but it must not rewrite
        // the immutable submission scope sealed by the evidence digest.
        current?.attempts.push(attempt);
    }

    return Array.from(groupedAttempts.values());
}

export interface ClassExamScoreGroup {
    groupKey: string;
    groupName: string;
    regionName?: string;
    /** Score percentages (0–100) for every counted attempt in this class. */
    scores: number[];
}

/**
 * Per-class score percentages for the selected exam, grouped the same way as
 * buildClassExamWeaknessMatrix. Feeds computeGroupScoreSummary (scoreDistribution.ts) for the
 * "반별 점수 비교" range-bar card — kept separate from the weakness matrix since it only needs
 * raw scores, not the recommendation/wrong-rate machinery.
 */
export function buildClassExamScoreGroups(
    exam: Exam,
    attempts: Attempt[],
    options: Pick<ClassExamWeaknessMatrixOptions, "rosterGroups" | "rosterStudents" | "includeRetakes"> = {},
    index?: CanonicalAttemptAnalyticsIndex,
): ClassExamScoreGroup[] {
    return buildGroupedAttemptEntries(exam, attempts, options).map(group => ({
        groupKey: group.groupKey,
        groupName: group.groupName,
        regionName: group.regionName,
        scores: group.attempts
            .map(attempt => summarizeAttemptScore(exam, attempt, index))
            .filter(hasGradableAttemptScore)
            .map(summary => summary.scorePercent),
    }));
}

export function buildClassExamWeaknessMatrix(
    exam: Exam,
    attempts: Attempt[],
    options: ClassExamWeaknessMatrixOptions = {},
    index?: CanonicalAttemptAnalyticsIndex,
): ClassExamWeaknessMatrixRow[] {
    const includeRetakes = !!options.includeRetakes;
    const groupedEntries = buildGroupedAttemptEntries(exam, attempts, options);

    const rows = groupedEntries.map(group => {
        const results = collectQuestionResults(exam, group.attempts, { includeRetakes }, index);
        const gradableResults = results.filter(result => result.status !== "ungraded");
        const wrongResults = gradableResults.filter(isWrongOrUnansweredResult);
        const studentKeys = new Set(results.map(studentKeyForResult).filter(Boolean));
        const submittedRosterStudents = group.rosterStudents.filter(student => (
            group.attempts.some(attempt => attemptMatchesRosterStudent(attempt, student))
        ));
        const missingStudents = group.rosterStudents.filter(student => (
            !submittedRosterStudents.some(submitted => submitted.id === student.id)
        ));
        const rosterStudentCount = group.rosterStudents.length;
        const submittedRosterStudentCount = rosterStudentCount > 0
            ? submittedRosterStudents.length
            : studentKeys.size;
        const performanceScores = group.attempts
            .map(attempt => summarizeAttemptScore(exam, attempt, index))
            .filter(hasGradableAttemptScore)
            .map(summary => summary.scorePercent);
        const averageScorePercent = performanceScores.length > 0
            ? Math.round(performanceScores.reduce((sum, score) => sum + score, 0) / performanceScores.length)
            : null;
        const questionStats = buildExamQuestionResultStats(exam, group.attempts, index)
            .filter(stat => stat.wrongCount > 0)
            .sort((a, b) => {
                if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
                if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
                return a.questionNumber - b.questionNumber;
            });
        const recommendations = buildLearningRecommendations(exam, group.attempts, {
            scope: "class",
            groupKey: group.groupKey,
            prefiltered: true,
            kinds: options.kinds || ["concept", "mistakeType"],
            limit: options.recommendationLimit ?? 3,
            includeRetakes,
        }, index);
        const retakeQuestionIds = Array.from(new Set(recommendations.flatMap(item => item.retakeQuestionIds))).sort((a, b) => a - b);

        return {
            groupKey: group.groupKey,
            groupName: group.groupName,
            regionName: group.regionName,
            attemptCount: group.attempts.length,
            studentCount: studentKeys.size,
            rosterStudentCount,
            submittedRosterStudentCount,
            missingStudentCount: missingStudents.length,
            missingStudentNames: missingStudents.map(student => student.name).slice(0, 5),
            // Without a linked roster the denominator (enrolled students) is unknown, so
            // turnout is genuinely uncomputable — report null instead of a misleading 100%.
            participationRate: rosterStudentCount > 0
                ? roundPercent(submittedRosterStudentCount, rosterStudentCount)
                : null,
            performanceCount: performanceScores.length,
            averageScorePercent,
            wrongCount: wrongResults.length,
            totalCount: gradableResults.length,
            wrongRate: roundPercent(wrongResults.length, gradableResults.length),
            focusQuestionNumbers: questionStats.slice(0, 5).map(stat => stat.questionNumber),
            recommendations,
            retakeQuestionIds,
        };
    });

    const sortedRows = rows.sort((a, b) => {
        if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
        // Unknown turnout (null) sorts last for this criterion so it is not flagged as low attendance.
        const aParticipation = a.participationRate ?? 101;
        const bParticipation = b.participationRate ?? 101;
        if (aParticipation !== bParticipation) return aParticipation - bParticipation;
        const aAverage = a.averageScorePercent ?? Number.POSITIVE_INFINITY;
        const bAverage = b.averageScorePercent ?? Number.POSITIVE_INFINITY;
        if (aAverage !== bAverage) return aAverage - bAverage;
        if (b.attemptCount !== a.attemptCount) return b.attemptCount - a.attemptCount;
        return a.groupName.localeCompare(b.groupName, "ko");
    });

    return typeof options.classLimit === "number" ? sortedRows.slice(0, Math.max(0, options.classLimit)) : sortedRows;
}

export function buildExamQuestionResultStats(
    exam: Exam,
    attempts: Attempt[],
    index?: CanonicalAttemptAnalyticsIndex,
): ExamQuestionResultStat[] {
    const byQuestion = new Map<string, MutableQuestionResultStat>();
    // Stream the shared verified index once. Materializing a million wrapper
    // objects here made the server Flight snapshot path both slower and much
    // more memory hungry at the supported 2,000 x 500 boundary.
    for (const attempt of attempts) {
        if (attempt.examId !== exam.id || attempt.retake) continue;
        const grading = gradingFor(exam, attempt, index);
        const definitionManifestHash = attempt.questionResultsDefinitionManifestHash;
        if (grading.source !== "canonical_submission" || !definitionManifestHash) continue;
        for (const result of grading.questionResults) {
            const cohortKey = `${definitionManifestHash}\u001f${result.questionId}`;
            let stat = byQuestion.get(cohortKey);
            if (!stat) {
                stat = {
                    cohortKey,
                    definitionManifestHash,
                    questionId: result.questionId,
                    questionNumber: result.questionNumber,
                    label: result.label,
                    concept: result.concept,
                    unit: result.unit,
                    source: result.source,
                    expectedTimeSec: result.expectedTimeSec,
                    score: result.score,
                    correctAnswer: result.correctAnswer,
                    difficulty: result.difficulty,
                    mistakeTypes: result.mistakeTypes,
                    totalCount: 0,
                    correctCount: 0,
                    wrongCount: 0,
                    unansweredCount: 0,
                    ungradedCount: 0,
                    correctRate: 0,
                    wrongRate: 0,
                    unansweredRate: 0,
                    optionCounts: {},
                    wrongOptionCounts: {},
                    handwritingStrokeCount: 0,
                    studentCount: 0,
                    groupCount: 0,
                    timeSumSec: 0,
                    timedCount: 0,
                    visitSum: 0,
                    visitTrackedCount: 0,
                    revisitedCount: 0,
                    revisitRate: 0,
                    answerChangeCount: 0,
                    studentKeys: new Set<string>(),
                    groupKeys: new Set<string>(),
                };
                byQuestion.set(cohortKey, stat);
            }

            stat.studentKeys.add(studentKeyForResult(result));
            if (result.groupId || result.groupName) {
                stat.groupKeys.add(result.groupId || result.groupName || "");
            }
            if (typeof result.timeSec === "number") {
                stat.timeSumSec += Math.max(0, result.timeSec);
                stat.timedCount += 1;
            }
            if (typeof result.visitCount === "number") {
                stat.visitSum += Math.max(0, result.visitCount);
                stat.visitTrackedCount += 1;
            }
            if ((result.revisitCount || 0) > 0 || (result.visitCount || 0) > 1) {
                stat.revisitedCount += 1;
            }
            if (typeof result.answerChangeCount === "number") {
                stat.answerChangeCount += Math.max(0, result.answerChangeCount);
            }
            if (typeof result.handwritingStrokeCount === "number") {
                stat.handwritingStrokeCount += Math.max(0, result.handwritingStrokeCount);
            }
            if (isAnswered(result.selectedAnswer)) {
                stat.optionCounts[result.selectedAnswer] = (stat.optionCounts[result.selectedAnswer] || 0) + 1;
            }

            if (result.status === "ungraded") {
                stat.ungradedCount += 1;
                continue;
            }

            stat.totalCount += 1;
            if (result.status === "correct" || result.isCorrect) {
                stat.correctCount += 1;
            } else if (result.status === "unanswered" || result.isUnanswered) {
                stat.unansweredCount += 1;
                stat.wrongCount += 1;
            } else if (result.status === "wrong" || result.isWrong) {
                stat.wrongCount += 1;
                if (isAnswered(result.selectedAnswer)) {
                    stat.wrongOptionCounts[result.selectedAnswer] = (stat.wrongOptionCounts[result.selectedAnswer] || 0) + 1;
                }
            }
        }
    }

    return Array.from(byQuestion.values()).map(stat => {
        const wrongOptionEntries = Object.entries(stat.wrongOptionCounts)
            .map(([option, count]) => ({ option: Number(option), count }))
            .sort((a, b) => b.count - a.count);
        const topWrongOption = wrongOptionEntries[0];
        const averageTimeSec = stat.timedCount > 0 ? Math.round(stat.timeSumSec / stat.timedCount) : undefined;
        const averageVisitCount = stat.visitTrackedCount > 0 ? Math.round((stat.visitSum / stat.visitTrackedCount) * 10) / 10 : undefined;

        return {
            cohortKey: stat.cohortKey,
            definitionManifestHash: stat.definitionManifestHash,
            questionId: stat.questionId,
            questionNumber: stat.questionNumber,
            label: stat.label,
            concept: stat.concept,
            unit: stat.unit,
            source: stat.source,
            expectedTimeSec: stat.expectedTimeSec,
            score: stat.score,
            correctAnswer: stat.correctAnswer,
            difficulty: stat.difficulty,
            mistakeTypes: stat.mistakeTypes,
            totalCount: stat.totalCount,
            correctCount: stat.correctCount,
            wrongCount: stat.wrongCount,
            unansweredCount: stat.unansweredCount,
            ungradedCount: stat.ungradedCount,
            correctRate: roundPercent(stat.correctCount, stat.totalCount),
            wrongRate: roundPercent(stat.wrongCount, stat.totalCount),
            unansweredRate: roundPercent(stat.unansweredCount, stat.totalCount),
            optionCounts: stat.optionCounts,
            topWrongOption: topWrongOption
                ? { ...topWrongOption, rate: roundPercent(topWrongOption.count, stat.totalCount) }
                : undefined,
            averageTimeSec,
            timeOverExpectedRate: averageTimeSec && stat.expectedTimeSec
                ? roundPercent(averageTimeSec, stat.expectedTimeSec)
                : undefined,
            averageVisitCount,
            // Divide revisits by all graded responses (not only timed ones) so the rate
            // reflects "share of responses that were revisited" and can never exceed 100%.
            revisitRate: roundPercent(stat.revisitedCount, stat.totalCount),
            answerChangeCount: stat.answerChangeCount,
            handwritingStrokeCount: stat.handwritingStrokeCount,
            studentCount: stat.studentKeys.size,
            groupCount: stat.groupKeys.size,
        };
    }).sort((a, b) => a.questionNumber - b.questionNumber
        || a.definitionManifestHash.localeCompare(b.definitionManifestHash));
}

/**
 * Minimum respondents required before a per-question discrimination index is statistically
 * meaningful. Below this the correlation is noise (or undefined for n=1), so callers should
 * render "-" instead of a noisy number.
 */
export const DISCRIMINATION_MIN_RESPONDENTS = 5;

/**
 * Per-question point-biserial correlation between correctness (0/1) and total attempt score —
 * the single discrimination index used by the question-detail table, the 오답률 Top3 cards,
 * teaching insights, and the CSV export. (The legacy upper/lower-third D index was removed
 * in favor of this; psychometric convention flags r < .20 as poor discrimination.)
 * DISCRIMINATION_MIN_RESPONDENTS is the reliability floor, applied per question (a question
 * answered by fewer respondents than the exam total — e.g. a retake subset — is gated
 * independently) rather than once for the whole exam.
 */
export function buildExamQuestionPointBiserial(
    exam: Exam,
    attempts: Attempt[],
    index?: CanonicalAttemptAnalyticsIndex,
): Map<string, number | null> {
    const pointBiserials = new Map<string, number | null>();

    const canonicalAttempts: Array<{
        scorePercent: number;
        resultByCohortKey: Map<string, QuestionResult>;
    }> = [];
    for (const attempt of attempts) {
        if (attempt.examId !== exam.id || attempt.retake) continue;
        const grading = gradingFor(exam, attempt, index);
        if (grading.source !== "canonical_submission") continue;
        canonicalAttempts.push({
            scorePercent: grading.scoreSummary.scorePercent,
            resultByCohortKey: new Map(grading.questionResults.map(result => [
                `${attempt.questionResultsDefinitionManifestHash}\u001f${result.questionId}`,
                result,
            ])),
        });
    }

    const submittedQuestionIds = new Set<string>();
    for (const attempt of canonicalAttempts) {
        for (const questionId of attempt.resultByCohortKey.keys()) submittedQuestionIds.add(questionId);
    }
    for (const questionId of submittedQuestionIds) {
        const samples: PointBiserialSample[] = [];
        for (const attempt of canonicalAttempts) {
            const result = attempt.resultByCohortKey.get(questionId);
            if (!result || result.status === "ungraded") continue;
            samples.push({
                correct: result.status === "correct" || !!result.isCorrect,
                score: attempt.scorePercent,
            });
        }
        pointBiserials.set(questionId, computePointBiserialCorrelation(samples, DISCRIMINATION_MIN_RESPONDENTS));
    }

    return pointBiserials;
}

export function buildMostMissedQuestionStats(
    exam: Exam,
    attempts: Attempt[],
    limit = 5,
    index?: CanonicalAttemptAnalyticsIndex,
): ExamQuestionResultStat[] {
    return buildExamQuestionResultStats(exam, attempts, index)
        .filter(stat => stat.totalCount > 0 && stat.wrongCount > 0)
        .sort((a, b) => {
            if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
            if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
            if ((b.averageTimeSec || 0) !== (a.averageTimeSec || 0)) return (b.averageTimeSec || 0) - (a.averageTimeSec || 0);
            return a.questionNumber - b.questionNumber;
        })
        .slice(0, Math.max(0, limit));
}

export function buildRetakeQuestionIds(exam: Exam, attempt: Attempt): number[] {
    return getAttemptQuestionResults(exam, attempt)
        .filter(isWrongOrUnansweredResult)
        .map(result => result.questionId)
        .sort((a, b) => a - b);
}

export function buildStudentWeaknessGroups(exam: Exam, attempt: Attempt): WeaknessGroup[] {
    const submittedResults = getAttemptQuestionResults(exam, attempt);
    const submittedQuestions = submittedResults.map(submittedQuestionFromResult);
    const wrongQuestions = submittedResults
        .filter(isWrongOrUnansweredResult)
        .map(submittedQuestionFromResult);
    const consumed = new Set<number>();
    const groups: WeaknessGroup[] = [];

    const addGroupsForKind = (kind: GroupKind, requireRepeatedInExam = false) => {
        const byValue = new Map<string, Question[]>();
        for (const question of wrongQuestions) {
            if (consumed.has(question.id)) continue;
            const value = groupValue(question, kind);
            if (!value) continue;
            if (requireRepeatedInExam) {
                const sameInExam = submittedQuestions.filter(item => groupValue(item, kind) === value).length;
                if (sameInExam < 2) continue;
            }
            byValue.set(value, [...(byValue.get(value) || []), question]);
        }

        for (const [value, questions] of byValue.entries()) {
            questions.forEach(question => consumed.add(question.id));
            groups.push(makeWeaknessGroup(kind, value, questions, questions.length, questions.length));
        }
    };

    addGroupsForKind("source", true);
    addGroupsForKind("concept");
    addGroupsForKind("unit");
    addGroupsForKind("label");

    return sortGroups(groups);
}

export function buildSimilarQuestionGroups(
    exam: Exam,
    attempts: Attempt[],
    index?: CanonicalAttemptAnalyticsIndex,
): SimilarQuestionGroup[] {
    const grouped = new Map<string, {
        kind: GroupKind;
        title: string;
        questions: Map<number, Question>;
        attemptIds: Set<string>;
        wrongCount: number;
        totalCount: number;
    }>();
    for (const attempt of attempts) {
        if (attempt.retake) continue;
        const grading = gradingFor(exam, attempt, index);
        if (grading.source !== "canonical_submission") continue;
        for (const result of grading.questionResults) {
            const question = submittedQuestionFromResult(result);
            const source = groupValue(question, "source");
            const concept = groupValue(question, "concept");
            const unit = groupValue(question, "unit");
            const label = groupValue(question, "label");
            const title = source || concept || unit || label;
            if (!title) continue;
            const kind: GroupKind = source ? "source" : concept ? "concept" : unit ? "unit" : "label";
            const key = groupKey(kind, title);
            const group = grouped.get(key) || {
                kind,
                title,
                questions: new Map<number, Question>(),
                attemptIds: new Set<string>(),
                wrongCount: 0,
                totalCount: 0,
            };
            group.questions.set(question.id, question);
            group.attemptIds.add(attempt.id);
            if (result.status !== "ungraded") {
                group.totalCount += 1;
                if (isWrongOrUnansweredResult(result)) group.wrongCount += 1;
            }
            grouped.set(key, group);
        }
    }

    return sortGroups(Array.from(grouped.values()).map(group => ({
        ...makeWeaknessGroup(
            group.kind,
            group.title,
            Array.from(group.questions.values()),
            group.wrongCount,
            group.totalCount,
        ),
        attemptCount: group.attemptIds.size,
    })));
}

function uniqueQuestionNumbers(events: FocusLossEvent[]): number[] {
    return Array.from(new Set(
        events
            .map(event => event.questionNumber)
            .filter((value): value is number => typeof value === "number")
    )).sort((a, b) => a - b);
}

export function summarizeAttemptBehavior(attempt: Attempt): AttemptBehaviorSummary {
    const timings: QuestionTiming[] = attempt.questionTimings || [];
    const totalTrackedTimeSec = timings.reduce((sum, timing) => sum + Math.max(0, timing.totalTimeSec), 0);
    const averageTimeSec = timings.length > 0 ? Math.round(totalTrackedTimeSec / timings.length) : 0;
    const slowThreshold = averageTimeSec > 0 ? averageTimeSec * 1.5 : Number.POSITIVE_INFINITY;
    const rushedThreshold = averageTimeSec > 0 ? averageTimeSec * 0.4 : Number.NEGATIVE_INFINITY;
    const focusLossEvents = attempt.focusLossEvents || [];

    return {
        elapsedTimeSec: attemptElapsedTimeSec(attempt),
        totalTrackedTimeSec,
        averageTimeSec,
        slowQuestionNumbers: timings
            .filter(timing => timing.totalTimeSec >= slowThreshold)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        rushedQuestionNumbers: timings
            .filter(timing => timing.totalTimeSec <= rushedThreshold)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        revisitedQuestionNumbers: timings
            .filter(timing => timing.revisitCount > 0 || timing.visitCount > 1)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        answerChangedQuestionNumbers: timings
            .filter(timing => timing.answerChangeCount > 0)
            .map(timing => timing.questionNumber)
            .sort((a, b) => a - b),
        focusLossCount: resolveAwayCount(attempt),
        focusLossQuestionNumbers: uniqueQuestionNumbers(focusLossEvents),
    };
}
