import type { Attempt } from "@/types/omr";
import type {
    AttemptBehaviorSummary,
    AttemptGradingSource,
    ClassExamWeaknessMatrixRow,
    ExamQuestionResultStat,
    LearningRecommendation,
    SimilarQuestionGroup,
} from "@/lib/premiumAnalytics";
import { sha256HexUtf8 } from "@/lib/sha256";

export const TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
export const TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS = 500;
export const TEACHER_ANALYTICS_SNAPSHOT_MAX_CLASSES = 100;
export const TEACHER_ANALYTICS_SNAPSHOT_MAX_RECOMMENDATIONS = 100;
export const TEACHER_ANALYTICS_SNAPSHOT_MAX_STUDENT_ROWS = 2_000;

export interface TeacherCanonicalAnalyticsSnapshotDiagnostics {
    attemptCount: number;
    serverResolutionCount: number;
    canonicalQuestionResultCount: number;
    clientResolutionCount: 0;
}

export interface TeacherCanonicalAnalyticsSnapshot {
    schemaVersion: 1;
    status: "ready" | "unavailable";
    examId: string;
    collectionKey: string;
    summaryCollectionKey: string;
    diagnostics: TeacherCanonicalAnalyticsSnapshotDiagnostics;
    /** False means optional recommendation/class cuts were omitted, never approximated. */
    advancedAggregatesComplete: boolean;
    /** False means the bounded per-student/individual-CSV projection was omitted, never approximated. */
    studentAggregatesComplete: boolean;
    questionStats: ExamQuestionResultStat[];
    pointBiserial: Array<readonly [cohortKey: string, value: number | null]>;
    similarQuestionGroups: SimilarQuestionGroup[];
    recommendations: LearningRecommendation[];
    classMatrix: ClassExamWeaknessMatrixRow[];
    /** Official aggregate CSV cohorts from immutable submitted question rows. */
    csvQuestionCohorts: ExamQuestionResultStat[];
    /** Cohorts whose complete submitted definition still equals the authoritative current exam. */
    retakeEligibleCohortKeys: string[];
    studentRows: TeacherCanonicalStudentAnalyticsRow[];
}

export interface TeacherCanonicalStudentAnalyticsRow {
    attemptId: string;
    studentKey: string;
    studentName: string;
    groupName: string | null;
    regionName: string | null;
    totalScore: number;
    scorePercentage: number;
    hasPerformanceScore: boolean;
    gradingSource: AttemptGradingSource;
    labelScores: Record<string, { earned: number; total: number }>;
    labelOutcomes: Record<string, { correct: number; total: number }>;
    behavior: AttemptBehaviorSummary;
    topWeakness: LearningRecommendation | null;
    retakeQuestionIds: number[];
    retakeCohorts: Array<{
        cohortKey: string;
        definitionManifestHash: string;
        questionId: number;
    }>;
    questionCsvRows: Array<Array<string | number>>;
}

export type TeacherCanonicalAnalyticsSnapshotMap = Record<string, TeacherCanonicalAnalyticsSnapshot>;

export function teacherCanonicalAnalyticsEligibleAttempts(
    attempts: readonly Attempt[],
): Attempt[] {
    return attempts.filter(attempt => attempt.status === "completed" && !attempt.retake);
}

export function teacherCanonicalQuestionCohortCsvRows(
    snapshot: TeacherCanonicalAnalyticsSnapshot,
): Array<Array<string | number>> {
    if (snapshot.status !== "ready") return [];
    return [
        ["제출 정의", "문항 ID", "제출 당시 번호", "제출 당시 라벨", "배점", "응답", "정답", "오답", "미응답", "정답률"],
        ...snapshot.csvQuestionCohorts.map(stat => [
            stat.definitionManifestHash,
            stat.questionId,
            stat.questionNumber,
            stat.label || "일반",
            stat.score,
            stat.totalCount,
            stat.correctCount,
            stat.wrongCount,
            stat.unansweredCount,
            stat.correctRate,
        ]),
    ];
}

export function exactTeacherCanonicalRetakeCohorts(
    snapshot: TeacherCanonicalAnalyticsSnapshot,
    questionIds: readonly number[],
): string[] | null {
    if (snapshot.status !== "ready") return null;
    const eligible = new Set(snapshot.retakeEligibleCohortKeys);
    const result: string[] = [];
    for (const questionId of [...new Set(questionIds)].sort((left, right) => left - right)) {
        const matches = snapshot.questionStats.filter(stat => stat.questionId === questionId && eligible.has(stat.cohortKey));
        if (matches.length !== 1) return null;
        result.push(matches[0].cohortKey);
    }
    return result.length > 0 ? result : null;
}

/**
 * Official retakes are accepted by the student gateway only as the complete
 * wrong/unanswered set for one exact source attempt. Recommendation subsets,
 * synthetic exam sources, custom mode, and similar mode are display-only.
 */
export function exactTeacherCanonicalWrongRetakeCohorts(
    snapshot: TeacherCanonicalAnalyticsSnapshot,
    sourceAttemptId: string,
    questionIds: readonly number[],
): string[] | null {
    if (snapshot.status !== "ready" || !sourceAttemptId.trim()) return null;
    const requested = [...new Set(questionIds)].sort((left, right) => left - right);
    const row = snapshot.studentRows.find(student => student.attemptId === sourceAttemptId);
    if (!row || requested.length === 0
        || requested.length !== row.retakeQuestionIds.length
        || requested.some((questionId, index) => questionId !== row.retakeQuestionIds[index])
        || row.retakeCohorts.length !== requested.length) return null;
    const eligible = new Set(snapshot.retakeEligibleCohortKeys);
    const byQuestionId = new Map(row.retakeCohorts.map(cohort => [cohort.questionId, cohort.cohortKey]));
    const cohortKeys = requested.map(questionId => byQuestionId.get(questionId) || "");
    return cohortKeys.every(cohortKey => cohortKey && eligible.has(cohortKey)) ? cohortKeys : null;
}

export function teacherCanonicalAnalyticsCollectionKey(
    examId: string,
    attempts: readonly Attempt[],
): string {
    const identity = teacherCanonicalAnalyticsEligibleAttempts(attempts).map(attempt => [
        attempt.id,
        attempt.examId,
        attempt.assignmentId || "",
        attempt.assignmentRevision || 0,
        attempt.questionResultsQuestionCount || 0,
        attempt.questionResultsDefinitionManifestHash || "",
        attempt.questionResultsFullEvidenceHash || "",
    ].join("\u001f")).join("\u001e");
    return `sha256:${sha256HexUtf8(`omr:teacher-canonical-analytics-collection:v1\n${examId}\n${identity}`)}`;
}

export function teacherCanonicalAnalyticsSummaryCollectionKey(
    examId: string,
    attempts: readonly Attempt[],
): string {
    const identity = teacherCanonicalAnalyticsEligibleAttempts(attempts).map(attempt => [
        attempt.id,
        attempt.examId,
        attempt.assignmentId || "",
        attempt.assignmentRevision || 0,
        attempt.finishedAt,
        attempt.status,
        attempt.score,
        attempt.totalScore,
    ].join("\u001f")).join("\u001e");
    return `sha256:${sha256HexUtf8(`omr:teacher-canonical-analytics-summary-collection:v1\n${examId}\n${identity}`)}`;
}

/** Flight/client validation does not import or call the grading verifier/index. */
export function currentTeacherCanonicalAnalyticsSnapshot(
    value: unknown,
    examId: string,
    attempts: readonly Attempt[],
): TeacherCanonicalAnalyticsSnapshot | null {
    try {
        const eligibleAttempts = teacherCanonicalAnalyticsEligibleAttempts(attempts);
        const snapshot = exactSnapshotRecord(value);
        if (!snapshot) return null;
        if (
            snapshot.schemaVersion !== 1
            || (snapshot.status !== "ready" && snapshot.status !== "unavailable")
            || snapshot.examId !== examId
            || snapshot.summaryCollectionKey !== teacherCanonicalAnalyticsSummaryCollectionKey(examId, attempts)
            || !/^sha256:[a-f0-9]{64}$/.test(snapshot.collectionKey)
            || (attempts.every(attempt => typeof attempt.questionResultsDefinitionManifestHash === "string"
                && typeof attempt.questionResultsFullEvidenceHash === "string")
                && snapshot.collectionKey !== teacherCanonicalAnalyticsCollectionKey(examId, attempts))
            || !snapshot.diagnostics
            || snapshot.diagnostics.attemptCount !== eligibleAttempts.length
            || snapshot.diagnostics.serverResolutionCount !== eligibleAttempts.length
            || snapshot.diagnostics.clientResolutionCount !== 0
            || typeof snapshot.advancedAggregatesComplete !== "boolean"
            || typeof snapshot.studentAggregatesComplete !== "boolean"
            || !Array.isArray(snapshot.questionStats)
            || snapshot.questionStats.length > TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS
            || !Array.isArray(snapshot.pointBiserial)
            || !Array.isArray(snapshot.similarQuestionGroups)
            || !Array.isArray(snapshot.recommendations)
            || snapshot.recommendations.length > TEACHER_ANALYTICS_SNAPSHOT_MAX_RECOMMENDATIONS
            || !Array.isArray(snapshot.classMatrix)
            || snapshot.classMatrix.length > TEACHER_ANALYTICS_SNAPSHOT_MAX_CLASSES
            || !Array.isArray(snapshot.csvQuestionCohorts)
            || !Array.isArray(snapshot.retakeEligibleCohortKeys)
            || !Array.isArray(snapshot.studentRows)
            || snapshot.studentRows.length > TEACHER_ANALYTICS_SNAPSHOT_MAX_STUDENT_ROWS
            || new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > TEACHER_ANALYTICS_SNAPSHOT_MAX_BYTES
        ) return null;
        if (!validSnapshotNestedSchema(snapshot)) return null;
        return snapshot;
    } catch {
        return null;
    }
}

const ROOT_KEYS = [
    "advancedAggregatesComplete", "classMatrix", "collectionKey", "csvQuestionCohorts",
    "diagnostics", "examId", "pointBiserial", "questionStats", "recommendations", "summaryCollectionKey",
    "retakeEligibleCohortKeys", "schemaVersion", "similarQuestionGroups", "status", "studentAggregatesComplete", "studentRows",
] as const;

function ownDataRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null || Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor) || !descriptor.enumerable) return null;
    }
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    const keys = Object.keys(record).sort();
    const allowed = [...required, ...optional];
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && keys.every(key => allowed.includes(key))
        && keys.length >= required.length;
}

function exactSnapshotRecord(value: unknown): TeacherCanonicalAnalyticsSnapshot | null {
    const record = ownDataRecord(value);
    return record && exactKeys(record, ROOT_KEYS) ? record as unknown as TeacherCanonicalAnalyticsSnapshot : null;
}

function finite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function boundedString(value: unknown, max = 10_000): value is string {
    return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function denseArray(value: unknown, max: number): value is unknown[] {
    if (!Array.isArray(value) || value.length > max) return false;
    for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    }
    return Reflect.ownKeys(value).every(key => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)));
}

const QUESTION_STAT_REQUIRED = [
    "answerChangeCount", "cohortKey", "correctCount", "correctRate", "definitionManifestHash",
    "groupCount", "handwritingStrokeCount", "optionCounts", "questionId", "questionNumber",
    "revisitRate", "score", "studentCount", "totalCount", "unansweredCount", "unansweredRate",
    "ungradedCount", "wrongCount", "wrongRate",
];
const QUESTION_STAT_OPTIONAL = [
    "averageTimeSec", "averageVisitCount", "concept", "correctAnswer", "difficulty", "expectedTimeSec",
    "label", "mistakeTypes", "source", "timeOverExpectedRate", "topWrongOption", "unit",
];

function validQuestionStat(value: unknown): value is ExamQuestionResultStat {
    const row = ownDataRecord(value);
    if (!row || !exactKeys(row, QUESTION_STAT_REQUIRED, QUESTION_STAT_OPTIONAL)) return false;
    const counts = ["totalCount", "correctCount", "wrongCount", "unansweredCount", "ungradedCount", "studentCount", "groupCount"];
    if (!counts.every(key => Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)) return false;
    if (row.totalCount !== Number(row.correctCount) + Number(row.wrongCount) + Number(row.unansweredCount) + Number(row.ungradedCount)) return false;
    if (!Number.isSafeInteger(row.questionId) || Number(row.questionId) <= 0
        || !Number.isSafeInteger(row.questionNumber) || Number(row.questionNumber) <= 0
        || !finite(row.score) || Number(row.score) < 0
        || !Number.isSafeInteger(row.answerChangeCount) || Number(row.answerChangeCount) < 0
        || !Number.isSafeInteger(row.handwritingStrokeCount) || Number(row.handwritingStrokeCount) < 0
        || !boundedString(row.definitionManifestHash, 71) || !/^sha256:[a-f0-9]{64}$/.test(row.definitionManifestHash)
        || row.cohortKey !== `${row.definitionManifestHash}\u001f${row.questionId}`) return false;
    for (const key of ["correctRate", "wrongRate", "unansweredRate", "revisitRate"]) {
        if (!finite(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 100) return false;
    }
    const optionCounts = ownDataRecord(row.optionCounts);
    if (!optionCounts || !Object.entries(optionCounts).every(([key, count]) => /^[1-5]$/.test(key) && Number.isSafeInteger(count) && Number(count) >= 0)) return false;
    for (const key of ["averageTimeSec", "averageVisitCount", "expectedTimeSec"] as const) {
        if (row[key] !== undefined && (!finite(row[key]) || Number(row[key]) < 0)) return false;
    }
    for (const key of ["timeOverExpectedRate"] as const) {
        if (row[key] !== undefined && (!finite(row[key]) || Number(row[key]) < 0 || Number(row[key]) > 100)) return false;
    }
    for (const key of ["concept", "label", "source", "unit"] as const) {
        if (row[key] !== undefined && !boundedString(row[key], 512)) return false;
    }
    if (row.correctAnswer !== undefined
        && (!Number.isSafeInteger(row.correctAnswer) || Number(row.correctAnswer) < 1 || Number(row.correctAnswer) > 5)) return false;
    if (row.difficulty !== undefined && !["easy", "medium", "hard", "killer"].includes(String(row.difficulty))) return false;
    if (row.mistakeTypes !== undefined
        && (!denseArray(row.mistakeTypes, 100) || !row.mistakeTypes.every(item => boundedString(item, 512)))) return false;
    if (row.topWrongOption !== undefined) {
        const top = ownDataRecord(row.topWrongOption);
        if (!top || !exactKeys(top, ["count", "option", "rate"])
            || !Number.isSafeInteger(top.option) || Number(top.option) < 1 || Number(top.option) > 5
            || !Number.isSafeInteger(top.count) || Number(top.count) < 0 || Number(top.count) > Number(row.wrongCount)
            || !finite(top.rate) || Number(top.rate) < 0 || Number(top.rate) > 100) return false;
    }
    return stableAllowedNested(row, new WeakSet(), 0);
}

const NESTED_ALLOWED_KEYS = new Set([
    ...QUESTION_STAT_REQUIRED, ...QUESTION_STAT_OPTIONAL,
    "option", "count", "rate", "earned", "total",
    "attemptId", "studentKey", "studentName", "groupName", "regionName", "totalScore", "scorePercentage",
    "hasPerformanceScore", "gradingSource", "labelScores", "labelOutcomes", "behavior", "topWeakness", "retakeQuestionIds",
    "retakeCohorts", "questionCsvRows", "elapsedTimeSec", "totalTrackedTimeSec", "averageTimeSec",
    "slowQuestionNumbers", "rushedQuestionNumbers", "revisitedQuestionNumbers", "answerChangedQuestionNumbers",
    "focusLossCount", "focusLossQuestionNumbers", "questionId", "definitionManifestHash", "cohortKey",
    "key", "kind", "title", "basis", "questionIds", "questionNumbers", "wrongCount", "unansweredCount",
    "slowCorrectCount", "slowCorrectQuestionNumbers", "attemptCount", "studentCount", "labels", "concepts",
    "recommendedQuestionIds", "recommendedAction", "scope", "severity", "priorityScore", "reason",
    "sourceAttemptId", "retakeMode", "retakeLabels", "retakeConcepts",
    "groupKey", "rosterStudentCount", "submittedRosterStudentCount", "missingStudentCount", "missingStudentNames",
    "participationRate", "performanceCount", "averageScorePercent", "focusQuestionNumbers", "recommendations",
]);

function stableAllowedNested(value: unknown, seen: WeakSet<object>, depth: number): boolean {
    if (depth > 8) return false;
    if (value === null || typeof value === "boolean") return true;
    if (finite(value) || boundedString(value)
        || (typeof value === "string" && /^sha256:[a-f0-9]{64}\u001f[1-9]\d*$/.test(value))) return true;
    if (denseArray(value, 2_000)) {
        if (seen.has(value)) return false;
        seen.add(value);
        return value.every(item => stableAllowedNested(item, seen, depth + 1));
    }
    const record = ownDataRecord(value);
    if (!record || seen.has(value as object)) return false;
    seen.add(value as object);
    return Object.keys(record).every(key => NESTED_ALLOWED_KEYS.has(key) || /^[^\u0000-\u001f\u007f]{1,256}$/.test(key))
        && Object.values(record).every(item => stableAllowedNested(item, seen, depth + 1));
}

function validStudentRow(value: unknown): value is TeacherCanonicalStudentAnalyticsRow {
    const row = ownDataRecord(value);
    const keys = [
        "attemptId", "behavior", "gradingSource", "groupName", "hasPerformanceScore", "labelOutcomes", "labelScores",
        "questionCsvRows", "regionName", "retakeCohorts", "retakeQuestionIds", "scorePercentage", "studentKey",
        "studentName", "topWeakness", "totalScore",
    ];
    if (!row || !exactKeys(row, keys)
        || !boundedString(row.attemptId, 240) || !row.attemptId
        || !boundedString(row.studentKey, 512) || !row.studentKey
        || !boundedString(row.studentName, 512) || !row.studentName
        || (row.groupName !== null && !boundedString(row.groupName, 512))
        || (row.regionName !== null && !boundedString(row.regionName, 512))
        || !finite(row.totalScore) || Number(row.totalScore) < 0
        || !finite(row.scorePercentage) || Number(row.scorePercentage) < 0 || Number(row.scorePercentage) > 100
        || typeof row.hasPerformanceScore !== "boolean" || row.gradingSource !== "canonical_submission"
        || !denseArray(row.retakeQuestionIds, 500)
        || !row.retakeQuestionIds.every((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
        || !denseArray(row.retakeCohorts, 500) || !denseArray(row.questionCsvRows, 2_000)) return false;
    const behavior = ownDataRecord(row.behavior);
    if (!behavior || !exactKeys(behavior, [
        "answerChangedQuestionNumbers", "averageTimeSec", "elapsedTimeSec", "focusLossCount",
        "focusLossQuestionNumbers", "revisitedQuestionNumbers", "rushedQuestionNumbers", "slowQuestionNumbers",
        "totalTrackedTimeSec",
    ])) return false;
    if (!validBehavior(behavior)
        || !validLabelScoreMap(row.labelScores)
        || !validLabelOutcomeMap(row.labelOutcomes)
        || !validCsvRows(row.questionCsvRows)
        || (row.topWeakness !== null && !validLearningRecommendation(row.topWeakness))) return false;
    if (!row.retakeCohorts.every(value => {
        const cohort = ownDataRecord(value);
        return !!cohort && exactKeys(cohort, ["cohortKey", "definitionManifestHash", "questionId"])
            && boundedString(cohort.definitionManifestHash, 71) && /^sha256:[a-f0-9]{64}$/.test(cohort.definitionManifestHash)
            && Number.isSafeInteger(cohort.questionId) && Number(cohort.questionId) > 0
            && cohort.cohortKey === `${cohort.definitionManifestHash}\u001f${cohort.questionId}`;
    })) return false;
    return stableAllowedNested(row, new WeakSet(), 0);
}

function validPositiveIntegerArray(value: unknown): boolean {
    return denseArray(value, 500) && value.every(item => Number.isSafeInteger(item) && Number(item) > 0);
}

function validBehavior(record: Record<string, unknown>): boolean {
    return finite(record.elapsedTimeSec) && Number(record.elapsedTimeSec) >= 0
        && finite(record.totalTrackedTimeSec) && Number(record.totalTrackedTimeSec) >= 0
        && finite(record.averageTimeSec) && Number(record.averageTimeSec) >= 0
        && Number.isSafeInteger(record.focusLossCount) && Number(record.focusLossCount) >= 0
        && validPositiveIntegerArray(record.slowQuestionNumbers)
        && validPositiveIntegerArray(record.rushedQuestionNumbers)
        && validPositiveIntegerArray(record.revisitedQuestionNumbers)
        && validPositiveIntegerArray(record.answerChangedQuestionNumbers)
        && validPositiveIntegerArray(record.focusLossQuestionNumbers);
}

function validLabelKey(key: string): boolean {
    return key.length > 0 && key.length <= 512 && key.trim() === key && !/[\u0000-\u001f\u007f]/.test(key);
}

function validLabelScoreMap(value: unknown): boolean {
    const record = ownDataRecord(value);
    return !!record && Object.keys(record).length <= 500 && Object.entries(record).every(([key, item]) => {
        const score = ownDataRecord(item);
        return validLabelKey(key) && !!score && exactKeys(score, ["earned", "total"])
            && finite(score.earned) && Number(score.earned) >= 0
            && finite(score.total) && Number(score.total) >= 0
            && Number(score.earned) <= Number(score.total);
    });
}

function validLabelOutcomeMap(value: unknown): boolean {
    const record = ownDataRecord(value);
    return !!record && Object.keys(record).length <= 500 && Object.entries(record).every(([key, item]) => {
        const outcome = ownDataRecord(item);
        return validLabelKey(key) && !!outcome && exactKeys(outcome, ["correct", "total"])
            && Number.isSafeInteger(outcome.correct) && Number(outcome.correct) >= 0
            && Number.isSafeInteger(outcome.total) && Number(outcome.total) >= 0
            && Number(outcome.correct) <= Number(outcome.total);
    });
}

function validCsvRows(value: unknown): boolean {
    return denseArray(value, 2_000) && value.every(row => denseArray(row, 500)
        && row.every(cell => (typeof cell === "number" && Number.isFinite(cell)) || boundedString(cell, 10_000)));
}

const WEAKNESS_KEYS = [
    "basis", "concepts", "key", "labels", "questionIds", "questionNumbers", "recommendedAction",
    "title", "totalCount", "wrongCount", "wrongRate",
] as const;

function validWeaknessRecord(record: Record<string, unknown>): boolean {
    return boundedString(record.key, 512) && boundedString(record.title, 512) && boundedString(record.basis, 512)
        && boundedString(record.recommendedAction, 2_000)
        && Number.isSafeInteger(record.totalCount) && Number(record.totalCount) >= 0
        && Number.isSafeInteger(record.wrongCount) && Number(record.wrongCount) >= 0
        && Number(record.wrongCount) <= Number(record.totalCount)
        && finite(record.wrongRate) && Number(record.wrongRate) >= 0 && Number(record.wrongRate) <= 100
        && denseArray(record.questionIds, 500) && record.questionIds.every(value => Number.isSafeInteger(value) && Number(value) > 0)
        && denseArray(record.questionNumbers, 500) && record.questionNumbers.every(value => Number.isSafeInteger(value) && Number(value) > 0)
        && denseArray(record.labels, 500) && record.labels.every(value => boundedString(value, 512))
        && denseArray(record.concepts, 500) && record.concepts.every(value => boundedString(value, 512));
}

function validSimilarQuestionGroup(value: unknown): value is SimilarQuestionGroup {
    const row = ownDataRecord(value);
    return !!row && exactKeys(row, [...WEAKNESS_KEYS, "attemptCount"])
        && validWeaknessRecord(row) && Number.isSafeInteger(row.attemptCount) && Number(row.attemptCount) >= 0;
}

const RECOMMENDATION_KEYS = [
    "attemptCount", "basis", "concepts", "key", "kind", "labels", "priorityScore", "questionIds",
    "questionNumbers", "reason", "recommendedAction", "recommendedQuestionIds", "retakeConcepts",
    "retakeLabels", "retakeMode", "retakeQuestionIds", "scope", "severity", "slowCorrectCount",
    "slowCorrectQuestionNumbers", "sourceAttemptId", "studentCount", "title", "totalCount",
    "unansweredCount", "wrongCount", "wrongRate",
] as const;

function validLearningRecommendation(value: unknown): value is LearningRecommendation {
    const row = ownDataRecord(value);
    if (!row || !exactKeys(row, RECOMMENDATION_KEYS)
        || !["source", "concept", "unit", "label", "skill", "difficulty", "mistakeType"].includes(String(row.kind))
        || !["attempt", "student", "class", "exam"].includes(String(row.scope))
        || !["watch", "review", "urgent"].includes(String(row.severity))
        || !["wrong", "similar"].includes(String(row.retakeMode))
        || !boundedString(row.reason, 2_000) || !boundedString(row.sourceAttemptId, 240)
        || !finite(row.priorityScore) || Number(row.priorityScore) < 0) return false;
    for (const key of ["wrongCount", "unansweredCount", "slowCorrectCount", "totalCount", "attemptCount", "studentCount"] as const) {
        if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) return false;
    }
    for (const key of ["recommendedQuestionIds", "retakeQuestionIds", "slowCorrectQuestionNumbers"] as const) {
        if (!denseArray(row[key], 500) || !row[key].every(value => Number.isSafeInteger(value) && Number(value) > 0)) return false;
    }
    for (const key of ["retakeLabels", "retakeConcepts"] as const) {
        if (!denseArray(row[key], 500) || !row[key].every(value => boundedString(value, 512))) return false;
    }
    return validWeaknessRecord(row) && stableAllowedNested(row, new WeakSet(), 0);
}

function validClassMatrixRow(value: unknown): value is ClassExamWeaknessMatrixRow {
    const row = ownDataRecord(value);
    const required = [
        "attemptCount", "averageScorePercent", "focusQuestionNumbers", "groupKey", "groupName",
        "missingStudentCount", "missingStudentNames", "participationRate", "performanceCount", "recommendations",
        "retakeQuestionIds", "rosterStudentCount", "studentCount", "submittedRosterStudentCount", "totalCount",
        "wrongCount", "wrongRate",
    ];
    if (!row || !exactKeys(row, required, ["regionName"])
        || !boundedString(row.groupKey, 512) || !boundedString(row.groupName, 512)
        || (row.regionName !== undefined && !boundedString(row.regionName, 512))) return false;
    for (const key of ["attemptCount", "missingStudentCount", "performanceCount", "rosterStudentCount", "studentCount", "submittedRosterStudentCount", "totalCount", "wrongCount"] as const) {
        if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) return false;
    }
    if ((row.participationRate !== null && (!finite(row.participationRate) || Number(row.participationRate) < 0 || Number(row.participationRate) > 100))
        || (row.averageScorePercent !== null && (!finite(row.averageScorePercent) || Number(row.averageScorePercent) < 0 || Number(row.averageScorePercent) > 100))
        || !finite(row.wrongRate) || Number(row.wrongRate) < 0 || Number(row.wrongRate) > 100
        || !denseArray(row.focusQuestionNumbers, 500) || !row.focusQuestionNumbers.every(value => Number.isSafeInteger(value) && Number(value) > 0)
        || !denseArray(row.retakeQuestionIds, 500) || !row.retakeQuestionIds.every(value => Number.isSafeInteger(value) && Number(value) > 0)
        || !denseArray(row.missingStudentNames, 2_000) || !row.missingStudentNames.every(value => boundedString(value, 512))
        || !denseArray(row.recommendations, TEACHER_ANALYTICS_SNAPSHOT_MAX_RECOMMENDATIONS)
        || !row.recommendations.every(validLearningRecommendation)) return false;
    return true;
}

function validSnapshotNestedSchema(snapshot: TeacherCanonicalAnalyticsSnapshot): boolean {
    const diagnostics = ownDataRecord(snapshot.diagnostics);
    if (!diagnostics || !exactKeys(diagnostics, ["attemptCount", "canonicalQuestionResultCount", "clientResolutionCount", "serverResolutionCount"])) return false;
    if (![diagnostics.attemptCount, diagnostics.canonicalQuestionResultCount, diagnostics.clientResolutionCount, diagnostics.serverResolutionCount]
        .every(value => Number.isSafeInteger(value) && Number(value) >= 0)) return false;
    if (diagnostics.attemptCount !== diagnostics.serverResolutionCount || diagnostics.clientResolutionCount !== 0) return false;
    if (!snapshot.questionStats.every(validQuestionStat) || !snapshot.csvQuestionCohorts.every(validQuestionStat)) return false;
    if (JSON.stringify(snapshot.questionStats) !== JSON.stringify(snapshot.csvQuestionCohorts)) return false;
    const cohorts = new Set(snapshot.questionStats.map(stat => stat.cohortKey));
    if (!denseArray(snapshot.retakeEligibleCohortKeys, TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS)
        || !snapshot.retakeEligibleCohortKeys.every(key => typeof key === "string" && cohorts.has(key))
        || new Set(snapshot.retakeEligibleCohortKeys).size !== snapshot.retakeEligibleCohortKeys.length
        || !denseArray(snapshot.pointBiserial, TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS)
        || !snapshot.pointBiserial.every(tuple => denseArray(tuple, 2) && tuple.length === 2
            && typeof tuple[0] === "string" && cohorts.has(tuple[0])
            && (tuple[1] === null || (finite(tuple[1]) && tuple[1] >= -1 && tuple[1] <= 1)))) return false;
    if (!snapshot.studentRows.every(validStudentRow)) return false;
    if (!denseArray(snapshot.similarQuestionGroups, TEACHER_ANALYTICS_SNAPSHOT_MAX_QUESTION_COHORTS)
        || !snapshot.similarQuestionGroups.every(validSimilarQuestionGroup)
        || !denseArray(snapshot.recommendations, TEACHER_ANALYTICS_SNAPSHOT_MAX_RECOMMENDATIONS)
        || !snapshot.recommendations.every(validLearningRecommendation)
        || !denseArray(snapshot.classMatrix, TEACHER_ANALYTICS_SNAPSHOT_MAX_CLASSES)
        || !snapshot.classMatrix.every(validClassMatrixRow)) return false;
    if (snapshot.status === "unavailable") {
        return !snapshot.advancedAggregatesComplete && !snapshot.studentAggregatesComplete
            && snapshot.questionStats.length === 0 && snapshot.pointBiserial.length === 0
            && snapshot.similarQuestionGroups.length === 0 && snapshot.recommendations.length === 0
            && snapshot.classMatrix.length === 0 && snapshot.csvQuestionCohorts.length === 0
            && snapshot.retakeEligibleCohortKeys.length === 0
            && snapshot.studentRows.length === 0;
    }
    if (snapshot.diagnostics.canonicalQuestionResultCount > 0 && snapshot.questionStats.length === 0) return false;
    if (!snapshot.advancedAggregatesComplete
        && (snapshot.similarQuestionGroups.length > 0 || snapshot.recommendations.length > 0 || snapshot.classMatrix.length > 0)) return false;
    if (!snapshot.studentAggregatesComplete && snapshot.studentRows.length > 0) return false;
    return true;
}
