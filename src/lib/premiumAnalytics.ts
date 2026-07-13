import { questionWeight } from "@/types/omr";
import { canonicalQuestionIdFor } from "@/lib/questionBank";
import type { RosterGroup, RosterStudent } from "@/lib/rosterStorage";
import { rosterGroupMatchesStudent } from "@/lib/rosterStorage";
import type {
    Attempt,
    Exam,
    FocusLossEvent,
    Question,
    QuestionDrawingSummary,
    QuestionResult,
    QuestionResultStatus,
    QuestionTiming,
} from "@/types/omr";

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
    averageScorePercent: number;
    wrongCount: number;
    totalCount: number;
    wrongRate: number;
    focusQuestionNumbers: number[];
    recommendations: LearningRecommendation[];
    retakeQuestionIds: number[];
}

export interface ExamQuestionResultStat {
    questionId: number;
    questionNumber: number;
    label?: string;
    concept?: string;
    unit?: string;
    source?: string;
    expectedTimeSec?: number;
    score: number;
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

function normalizeAttemptForMatrixGroup(attempt: Attempt, group: Pick<RosterGroup, "id" | "name">, student?: RosterStudent): Attempt {
    const nextStudentId = student?.id || attempt.studentId;
    const nextStudentName = student?.name || attempt.studentName;
    const nextGroupId = normalizeIdentityKey(group.id) || attempt.groupId;
    const nextGroupName = normalizeIdentityKey(group.name) || attempt.groupName;

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

function resolveQuestionStatus(question: Question, selectedAnswer: number | undefined): QuestionResultStatus {
    if (question.answer === undefined || question.answer === null) return "ungraded";
    if (!isAnswered(selectedAnswer)) return "unanswered";
    return selectedAnswer === question.answer ? "correct" : "wrong";
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

function getDrawingForQuestion(questionDrawings: QuestionDrawingSummary[] | undefined, questionId: number): QuestionDrawingSummary | undefined {
    return questionDrawings?.find(drawing => drawing.questionId === questionId);
}

function getTimingForQuestion(questionTimings: QuestionTiming[] | undefined, questionId: number): QuestionTiming | undefined {
    return questionTimings?.find(timing => timing.questionId === questionId);
}

export function getEffectiveExamQuestionsForAttempt(exam: Exam, attempt: Pick<Attempt, "retake">): Question[] {
    const retakeQuestionIds = attempt.retake?.questionIds;
    if (!retakeQuestionIds?.length) return exam.questions;

    const activeIds = new Set(retakeQuestionIds);
    const activeQuestions = exam.questions.filter(question => activeIds.has(question.id));
    return activeQuestions.length > 0 ? activeQuestions : exam.questions;
}

export function buildQuestionResults(exam: Exam, attempt: Attempt): QuestionResult[] {
    const questions = getEffectiveExamQuestionsForAttempt(exam, attempt);
    const totalQuestions = questions.length;

    return questions.map(question => {
        const selectedAnswer = attempt.answers[question.id];
        const status = resolveQuestionStatus(question, selectedAnswer);
        const score = roundScore(questionWeight(question, totalQuestions));
        const timing = getTimingForQuestion(attempt.questionTimings, question.id);
        const drawing = getDrawingForQuestion(attempt.questionDrawings, question.id);
        const pdfPage = question.pdfRegion?.page || question.pdfLocation?.page;
        const answered = isAnswered(selectedAnswer);
        const correct = status === "correct";
        const wrong = status === "wrong";
        const unanswered = status === "unanswered";

        return {
            schemaVersion: 1,
            attemptId: attempt.id,
            examId: attempt.examId || exam.id,
            examTitle: attempt.examTitle || exam.title,
            studentName: attempt.studentName,
            studentId: attempt.studentId,
            groupId: attempt.groupId,
            groupName: attempt.groupName,
            regionId: attempt.regionId,
            regionName: attempt.regionName,
            identityType: attempt.identityType,
            questionId: question.id,
            questionNumber: question.number,
            canonicalQuestionId: canonicalQuestionIdFor(exam.id, question.id),
            label: question.label,
            score,
            earnedScore: correct ? score : 0,
            selectedAnswer: answered ? selectedAnswer : undefined,
            correctAnswer: question.answer,
            status,
            isCorrect: correct,
            isWrong: wrong,
            isUnanswered: unanswered,
            subject: question.tags?.subject,
            unit: question.tags?.unit,
            concept: question.tags?.concept,
            skill: question.tags?.skill,
            source: question.tags?.source,
            difficulty: question.tags?.difficulty,
            cognitiveLevel: question.tags?.cognitiveLevel,
            mistakeTypes: question.tags?.mistakeTypes ? [...question.tags.mistakeTypes] : undefined,
            prerequisites: question.tags?.prerequisites ? [...question.tags.prerequisites] : undefined,
            expectedTimeSec: question.tags?.expectedTimeSec,
            pdfPage,
            pdfLocation: question.pdfLocation,
            pdfRegion: question.pdfRegion,
            timeSec: timing?.totalTimeSec,
            visitCount: timing?.visitCount,
            revisitCount: timing?.revisitCount,
            answerChangeCount: timing?.answerChangeCount,
            handwritingStrokeCount: drawing?.strokeCount,
            handwritingPage: drawing?.page,
            retakeSourceAttemptId: attempt.retake?.sourceAttemptId,
            retakeMode: attempt.retake?.mode,
            answeredAt: timing?.lastAnsweredAt,
            finishedAt: attempt.finishedAt,
        };
    });
}

export function getAttemptQuestionResults(exam: Exam, attempt: Attempt): QuestionResult[] {
    const effectiveQuestions = getEffectiveExamQuestionsForAttempt(exam, attempt);
    const examQuestionIds = new Set(effectiveQuestions.map(question => question.id));
    const storedResults = (attempt.questionResults || [])
        .filter(result => result.examId === exam.id && examQuestionIds.has(result.questionId));
    const derivedResults = buildQuestionResults(exam, attempt);

    if (storedResults.length === 0) {
        return derivedResults;
    }

    const storedByQuestionId = new Map(storedResults.map(result => [result.questionId, result]));
    return derivedResults.map(baseResult => {
        const storedResult = storedByQuestionId.get(baseResult.questionId);
        if (!storedResult) return baseResult;

        const status = baseResult.status;

        return {
            ...storedResult,
            ...baseResult,
            schemaVersion: 1,
            attemptId: attempt.id,
            examId: attempt.examId || exam.id,
            examTitle: attempt.examTitle || exam.title,
            studentName: attempt.studentName,
            studentId: attempt.studentId || storedResult.studentId,
            groupId: attempt.groupId || storedResult.groupId,
            groupName: attempt.groupName || storedResult.groupName,
            regionId: attempt.regionId || storedResult.regionId,
            regionName: attempt.regionName || storedResult.regionName,
            identityType: attempt.identityType || storedResult.identityType,
            questionId: baseResult.questionId,
            questionNumber: baseResult.questionNumber,
            canonicalQuestionId: baseResult.canonicalQuestionId,
            label: baseResult.label,
            score: baseResult.score,
            earnedScore: baseResult.earnedScore,
            selectedAnswer: baseResult.selectedAnswer,
            correctAnswer: baseResult.correctAnswer,
            status,
            isCorrect: status === "correct",
            isWrong: status === "wrong",
            isUnanswered: status === "unanswered",
            subject: baseResult.subject,
            unit: baseResult.unit,
            concept: baseResult.concept,
            skill: baseResult.skill,
            source: baseResult.source,
            difficulty: baseResult.difficulty,
            cognitiveLevel: baseResult.cognitiveLevel,
            mistakeTypes: baseResult.mistakeTypes,
            prerequisites: baseResult.prerequisites,
            expectedTimeSec: baseResult.expectedTimeSec,
            pdfPage: baseResult.pdfPage,
            pdfLocation: baseResult.pdfLocation,
            pdfRegion: baseResult.pdfRegion,
            timeSec: storedResult.timeSec ?? baseResult.timeSec,
            visitCount: storedResult.visitCount ?? baseResult.visitCount,
            revisitCount: storedResult.revisitCount ?? baseResult.revisitCount,
            answerChangeCount: storedResult.answerChangeCount ?? baseResult.answerChangeCount,
            handwritingStrokeCount: storedResult.handwritingStrokeCount ?? baseResult.handwritingStrokeCount,
            handwritingPage: storedResult.handwritingPage ?? baseResult.handwritingPage,
            retakeSourceAttemptId: baseResult.retakeSourceAttemptId ?? storedResult.retakeSourceAttemptId,
            retakeMode: baseResult.retakeMode ?? storedResult.retakeMode,
            answeredAt: storedResult.answeredAt ?? baseResult.answeredAt,
            finishedAt: attempt.finishedAt || storedResult.finishedAt || baseResult.finishedAt,
        };
    });
}

export function summarizeAttemptScore(exam: Exam, attempt: Attempt): AttemptScoreSummary {
    const results = getAttemptQuestionResults(exam, attempt);
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
        const fallbackEarned = roundScore(attempt.score || 0);
        const fallbackTotal = roundScore(attempt.totalScore || 0);
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

export function collectQuestionResults(exam: Exam, attempts: Attempt[], scope: QuestionResultScope = {}): QuestionResult[] {
    return attempts
        .filter(attempt => attempt.examId === exam.id)
        .filter(attempt => scope.includeRetakes || !attempt.retake)
        .flatMap(attempt => getAttemptQuestionResults(exam, attempt))
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

export function buildExamTypeWeaknessGroups(
    exam: Exam,
    attempts: Attempt[],
    kind: QuestionResultGroupKind = "concept",
): TypeWeaknessGroup[] {
    return buildTypeWeaknessGroups(collectQuestionResults(exam, attempts), kind);
}

export function buildLearningRecommendations(
    exam: Exam,
    attempts: Attempt[],
    options: LearningRecommendationOptions,
): LearningRecommendation[] {
    const kinds: QuestionResultGroupKind[] = options.kinds?.length ? options.kinds : ["concept", "mistakeType"];
    const sourceAttemptId = sourceAttemptIdForRecommendation(exam, options);
    const results = options.scope === "attempt" && options.attempt
        ? getAttemptQuestionResults(exam, options.attempt)
        : collectQuestionResults(exam, attempts, {
            includeRetakes: options.includeRetakes,
            studentKey: options.scope === "student" ? options.studentKey : undefined,
            groupKey: options.scope === "class" || options.scope === "student" ? options.groupKey : undefined,
        });

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

export function buildClassExamWeaknessMatrix(
    exam: Exam,
    attempts: Attempt[],
    options: ClassExamWeaknessMatrixOptions = {},
): ClassExamWeaknessMatrixRow[] {
    const rosterGroups = options.rosterGroups || [];
    const rosterStudents = options.rosterStudents || [];
    const groupedAttempts = new Map<string, {
        groupKey: string;
        groupName: string;
        regionName?: string;
        rosterStudents: RosterStudent[];
        attempts: Attempt[];
    }>();
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
        current?.attempts.push(
            rosterGroup
                ? normalizeAttemptForMatrixGroup(attempt, rosterGroup, rosterStudent)
                : attempt
        );
    }

    const rows = Array.from(groupedAttempts.values()).map(group => {
        const results = collectQuestionResults(exam, group.attempts, { includeRetakes });
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
        const averageScorePercent = group.attempts.length > 0
            ? Math.round(group.attempts.reduce((sum, attempt) => sum + summarizeAttemptScore(exam, attempt).scorePercent, 0) / group.attempts.length)
            : 0;
        const questionStats = buildExamQuestionResultStats(exam, group.attempts)
            .filter(stat => stat.wrongCount > 0)
            .sort((a, b) => {
                if (b.wrongRate !== a.wrongRate) return b.wrongRate - a.wrongRate;
                if (b.wrongCount !== a.wrongCount) return b.wrongCount - a.wrongCount;
                return a.questionNumber - b.questionNumber;
            });
        const recommendations = buildLearningRecommendations(exam, group.attempts, {
            scope: "class",
            groupKey: group.groupKey,
            kinds: options.kinds || ["concept", "mistakeType"],
            limit: options.recommendationLimit ?? 3,
            includeRetakes,
        });
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
        if (a.averageScorePercent !== b.averageScorePercent) return a.averageScorePercent - b.averageScorePercent;
        if (b.attemptCount !== a.attemptCount) return b.attemptCount - a.attemptCount;
        return a.groupName.localeCompare(b.groupName, "ko");
    });

    return typeof options.classLimit === "number" ? sortedRows.slice(0, Math.max(0, options.classLimit)) : sortedRows;
}

export function buildExamQuestionResultStats(exam: Exam, attempts: Attempt[]): ExamQuestionResultStat[] {
    const byQuestion = new Map<number, MutableQuestionResultStat>();
    for (const question of exam.questions) {
        byQuestion.set(question.id, {
            questionId: question.id,
            questionNumber: question.number,
            label: question.label,
            concept: question.tags?.concept,
            unit: question.tags?.unit,
            source: question.tags?.source,
            expectedTimeSec: question.tags?.expectedTimeSec,
            score: roundScore(questionWeight(question, exam.questions.length)),
            totalCount: 0,
            correctCount: 0,
            wrongCount: 0,
            unansweredCount: 0,
            ungradedCount: 0,
            correctRate: 0,
            wrongRate: 0,
            unansweredRate: 0,
            optionCounts: {},
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
        });
    }

    for (const result of collectQuestionResults(exam, attempts)) {
        const stat = byQuestion.get(result.questionId);
        if (!stat) continue;

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
        }
    }

    return Array.from(byQuestion.values()).map(stat => {
        const wrongOptionEntries = Object.entries(stat.optionCounts)
            .map(([option, count]) => ({ option: Number(option), count }))
            .filter(item => {
                const question = exam.questions.find(q => q.id === stat.questionId);
                return item.option !== question?.answer;
            })
            .sort((a, b) => b.count - a.count);
        const topWrongOption = wrongOptionEntries[0];
        const averageTimeSec = stat.timedCount > 0 ? Math.round(stat.timeSumSec / stat.timedCount) : undefined;
        const averageVisitCount = stat.visitTrackedCount > 0 ? Math.round((stat.visitSum / stat.visitTrackedCount) * 10) / 10 : undefined;

        return {
            questionId: stat.questionId,
            questionNumber: stat.questionNumber,
            label: stat.label,
            concept: stat.concept,
            unit: stat.unit,
            source: stat.source,
            expectedTimeSec: stat.expectedTimeSec,
            score: stat.score,
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
    }).sort((a, b) => a.questionNumber - b.questionNumber);
}

/**
 * Minimum respondents required before the upper/lower-third discrimination index is
 * statistically meaningful. Below this the two groups overlap (or are identical for n=1),
 * so callers should render "-" instead of a noisy number.
 */
export const DISCRIMINATION_MIN_RESPONDENTS = 5;

/**
 * Per-question discrimination index (upper-third correct rate − lower-third correct rate),
 * or null when there are too few respondents to be reliable. Matches the inline computation
 * used by the exam analytics table so the CSV export and the UI never disagree.
 */
export function buildExamQuestionDiscriminations(exam: Exam, attempts: Attempt[]): Map<number, number | null> {
    const discriminations = new Map<number, number | null>();
    if (attempts.length < DISCRIMINATION_MIN_RESPONDENTS) {
        for (const question of exam.questions) discriminations.set(question.id, null);
        return discriminations;
    }

    const resultsByAttemptId = new Map(attempts.map(attempt => [
        attempt.id,
        new Map(getAttemptQuestionResults(exam, attempt).map(result => [result.questionId, result])),
    ]));
    const sortedByScore = [...attempts].sort((a, b) => (
        summarizeAttemptScore(exam, b).scorePercent - summarizeAttemptScore(exam, a).scorePercent
    ));
    const splitSize = Math.max(1, Math.ceil(sortedByScore.length / 3));
    const upperGroup = sortedByScore.slice(0, splitSize);
    const lowerGroup = sortedByScore.slice(-splitSize);
    const rateForGroup = (group: Attempt[], questionId: number): number => {
        let total = 0;
        let correct = 0;
        for (const attempt of group) {
            const result = resultsByAttemptId.get(attempt.id)?.get(questionId);
            if (!result || result.status === "ungraded") continue;
            total += 1;
            if (result.status === "correct" || result.isCorrect) correct += 1;
        }
        return total > 0 ? Math.round((correct / total) * 100) : 0;
    };

    for (const question of exam.questions) {
        discriminations.set(question.id, rateForGroup(upperGroup, question.id) - rateForGroup(lowerGroup, question.id));
    }
    return discriminations;
}

export function buildMostMissedQuestionStats(exam: Exam, attempts: Attempt[], limit = 5): ExamQuestionResultStat[] {
    return buildExamQuestionResultStats(exam, attempts)
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
    const questionById = new Map(exam.questions.map(question => [question.id, question]));
    const wrongQuestions = getAttemptQuestionResults(exam, attempt)
        .filter(isWrongOrUnansweredResult)
        .map(result => questionById.get(result.questionId))
        .filter((question): question is Question => !!question);
    const consumed = new Set<number>();
    const groups: WeaknessGroup[] = [];

    const addGroupsForKind = (kind: GroupKind, requireRepeatedInExam = false) => {
        const byValue = new Map<string, Question[]>();
        for (const question of wrongQuestions) {
            if (consumed.has(question.id)) continue;
            const value = groupValue(question, kind);
            if (!value) continue;
            if (requireRepeatedInExam) {
                const sameInExam = exam.questions.filter(item => groupValue(item, kind) === value).length;
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

export function buildSimilarQuestionGroups(exam: Exam, attempts: Attempt[]): SimilarQuestionGroup[] {
    const bySource = new Map<string, Question[]>();
    for (const question of exam.questions) {
        const title = groupValue(question, "source")
            || groupValue(question, "concept")
            || groupValue(question, "unit")
            || groupValue(question, "label");
        if (!title) continue;
        const kind: GroupKind = groupValue(question, "source") ? "source"
            : groupValue(question, "concept") ? "concept"
                : groupValue(question, "unit") ? "unit"
                    : "label";
        const key = groupKey(kind, title);
        bySource.set(key, [...(bySource.get(key) || []), question]);
    }

    const groups: SimilarQuestionGroup[] = [];
    for (const [key, questions] of bySource.entries()) {
        const [kindRaw, ...titleParts] = key.split(":");
        const kind = kindRaw as GroupKind;
        const title = titleParts.join(":");
        let wrongCount = 0;
        let totalCount = 0;

        for (const attempt of attempts) {
            const resultByQuestionId = new Map(getAttemptQuestionResults(exam, attempt).map(result => [result.questionId, result]));
            for (const question of questions) {
                const result = resultByQuestionId.get(question.id);
                if (!result || result.status === "ungraded") continue;
                totalCount++;
                if (isWrongOrUnansweredResult(result)) wrongCount++;
            }
        }

        groups.push({
            ...makeWeaknessGroup(kind, title, questions, wrongCount, totalCount),
            attemptCount: attempts.length,
        });
    }

    return sortGroups(groups);
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
        focusLossCount: focusLossEvents.length || attempt.tabFociLostCount || 0,
        focusLossQuestionNumbers: uniqueQuestionNumbers(focusLossEvents),
    };
}
