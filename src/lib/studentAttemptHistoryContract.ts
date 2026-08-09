import type {
    ServerGradedQuestionReceipt,
    StudentSolveQuestion,
} from "@/lib/studentExamContract";
import type {
    Attempt,
    Exam,
    FocusLossEvent,
    IdentityType,
    Question,
    QuestionTiming,
    RetakeMetadata,
    StoredDataRef,
} from "@/types/omr";
import type {
    AttemptBehaviorSummary,
    AttemptScoreSummary,
    LearningRecommendation,
    WeaknessGroup,
} from "@/lib/premiumAnalytics";

export interface StudentAttemptRecord {
    id: string;
    examId: string;
    examTitle: string;
    studentId: string;
    studentName: string;
    identityType: IdentityType;
    assignmentId?: string;
    assignmentRevision?: number;
    groupId?: string;
    groupName?: string;
    startedAt: string;
    finishedAt: string;
    score: number;
    totalScore: number;
    status: "completed";
    autoSubmitted?: boolean;
    tabFociLostCount?: number;
    questionTimings?: QuestionTiming[];
    focusLossEvents?: FocusLossEvent[];
    retake?: RetakeMetadata;
    questionResultsSource?: "legacy_derived_current_exam";
    questionResults: StudentAttemptQuestionResult[];
}

export interface StudentAttemptQuestionResult extends ServerGradedQuestionReceipt {
    /** Immutable grading evidence is included only in an authorized owner detail. */
    correctAnswer?: number;
    assignmentRevision?: number;
    canonicalQuestionId?: string;
    label?: string;
    subject?: string;
    unit?: string;
    concept?: string;
    skill?: string;
    source?: string;
    difficulty?: NonNullable<Question["tags"]>["difficulty"];
    cognitiveLevel?: NonNullable<Question["tags"]>["cognitiveLevel"];
    mistakeTypes?: string[];
    prerequisites?: string[];
    expectedTimeSec?: number;
    pdfLocation?: Question["pdfLocation"];
    pdfRegion?: Question["pdfRegion"];
    passagePdfRegions?: NonNullable<Question["passagePdfRegions"]>;
}

export interface StudentAttemptReviewExam {
    id: string;
    title: string;
    createdAt: string;
    questions: Array<StudentSolveQuestion & Pick<Question, "score" | "label" | "tags"> & {
        /** Released only after the signed student owns a completed attempt. */
        answer?: number;
        explanation?: string;
    }>;
    pdfData?: string;
}

export interface StudentTrustedOfficialReview {
    gradingSource: "canonical_submission";
    questions: StudentAttemptReviewExam["questions"];
    questionResults: StudentAttemptQuestionResult[];
    scoreSummary: AttemptScoreSummary;
    weaknessGroups: WeaknessGroup[];
    recommendations: LearningRecommendation[];
    behavior: AttemptBehaviorSummary;
}

const TRUSTED_REVIEW_ROOT_KEYS = [
    "behavior", "gradingSource", "questions", "questionResults", "recommendations", "scoreSummary", "weaknessGroups",
] as const;

function ownReviewRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length > 0) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(descriptor => !("value" in descriptor) || !descriptor.enumerable)) return null;
    return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function exactReviewKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
    const keys = Object.keys(record);
    return required.every(key => Object.prototype.hasOwnProperty.call(record, key))
        && keys.length >= required.length
        && keys.every(key => required.includes(key) || optional.includes(key));
}

function denseReviewArray(value: unknown, max: number): value is unknown[] {
    if (!Array.isArray(value) || value.length > max) return false;
    for (let index = 0; index < value.length; index += 1) if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
    return Reflect.ownKeys(value).every(key => key === "length" || (typeof key === "string" && /^(0|[1-9]\d*)$/.test(key)));
}

function reviewString(value: unknown, max = 2_000): value is string {
    return typeof value === "string" && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

function reviewFinite(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function positiveReviewIntegers(value: unknown): boolean {
    return denseReviewArray(value, 500) && value.every(item => Number.isSafeInteger(item) && Number(item) > 0);
}

function validReviewRegion(value: unknown): boolean {
    const region = ownReviewRecord(value);
    return !!region && exactReviewKeys(region, ["height", "page", "width", "x", "y"])
        && Number.isSafeInteger(region.page) && Number(region.page) > 0
        && [region.x, region.y, region.width, region.height].every(reviewFinite);
}

function validReviewQuestion(value: unknown): boolean {
    const question = ownReviewRecord(value);
    if (!question || !exactReviewKeys(question, ["id", "number"], [
        "answer", "choices", "explanation", "label", "passagePdfRegions", "pdfLocation", "pdfRegion", "score", "tags",
    ])) return false;
    if (!Number.isSafeInteger(question.id) || Number(question.id) <= 0
        || !Number.isSafeInteger(question.number) || Number(question.number) <= 0
        || (question.answer !== undefined && (!Number.isSafeInteger(question.answer) || Number(question.answer) <= 0))
        || (question.choices !== undefined && question.choices !== 4 && question.choices !== 5)
        || (question.score !== undefined && (!reviewFinite(question.score) || Number(question.score) < 0))
        || (question.label !== undefined && !reviewString(question.label, 512))
        || (question.explanation !== undefined && !reviewString(question.explanation, 10_000))) return false;
    if (question.pdfLocation !== undefined) {
        const location = ownReviewRecord(question.pdfLocation);
        if (!location || !exactReviewKeys(location, ["page", "x", "y"])
            || !Number.isSafeInteger(location.page) || Number(location.page) <= 0
            || !reviewFinite(location.x) || !reviewFinite(location.y)) return false;
    }
    if (question.pdfRegion !== undefined && !validReviewRegion(question.pdfRegion)) return false;
    if (question.passagePdfRegions !== undefined
        && (!denseReviewArray(question.passagePdfRegions, 500) || !question.passagePdfRegions.every(validReviewRegion))) return false;
    if (question.tags !== undefined) {
        const tags = ownReviewRecord(question.tags);
        if (!tags || !exactReviewKeys(tags, [], [
            "cognitiveLevel", "concept", "difficulty", "expectedTimeSec", "mistakeTypes", "prerequisites", "skill", "source", "subject", "unit",
        ])) return false;
        for (const key of ["concept", "skill", "source", "subject", "unit"] as const) {
            if (tags[key] !== undefined && !reviewString(tags[key], 512)) return false;
        }
        if (tags.difficulty !== undefined && !["easy", "medium", "hard", "killer"].includes(String(tags.difficulty))) return false;
        if (tags.cognitiveLevel !== undefined && !["recall", "understanding", "application", "reasoning"].includes(String(tags.cognitiveLevel))) return false;
        if (tags.expectedTimeSec !== undefined && (!reviewFinite(tags.expectedTimeSec) || Number(tags.expectedTimeSec) < 0)) return false;
        for (const key of ["mistakeTypes", "prerequisites"] as const) {
            if (tags[key] !== undefined && (!denseReviewArray(tags[key], 500) || !tags[key].every(item => reviewString(item, 512)))) return false;
        }
    }
    return true;
}

const RESULT_OPTIONAL_KEYS = [
    "assignmentRevision", "canonicalQuestionId", "cognitiveLevel", "concept", "correctAnswer", "difficulty",
    "expectedTimeSec", "label", "mistakeTypes", "passagePdfRegions", "pdfLocation", "pdfRegion", "prerequisites",
    "selectedAnswer", "skill", "source", "subject", "unit",
] as const;

function validTrustedQuestionResult(value: unknown): boolean {
    const result = ownReviewRecord(value);
    if (!result || !exactReviewKeys(result, ["earnedScore", "questionId", "questionNumber", "score", "status"], RESULT_OPTIONAL_KEYS)
        || !Number.isSafeInteger(result.questionId) || Number(result.questionId) <= 0
        || !Number.isSafeInteger(result.questionNumber) || Number(result.questionNumber) <= 0
        || !reviewFinite(result.score) || Number(result.score) < 0
        || !reviewFinite(result.earnedScore) || Number(result.earnedScore) < 0 || Number(result.earnedScore) > Number(result.score)
        || !["correct", "wrong", "unanswered", "ungraded"].includes(String(result.status))) return false;
    for (const key of ["selectedAnswer", "correctAnswer"] as const) {
        if (result[key] !== undefined && (!Number.isSafeInteger(result[key]) || Number(result[key]) < 1 || Number(result[key]) > 5)) return false;
    }
    if (result.assignmentRevision !== undefined
        && (!Number.isSafeInteger(result.assignmentRevision) || Number(result.assignmentRevision) <= 0)) return false;
    for (const key of ["canonicalQuestionId", "concept", "label", "skill", "source", "subject", "unit"] as const) {
        if (result[key] !== undefined && !reviewString(result[key], 512)) return false;
    }
    if (result.difficulty !== undefined && !["easy", "medium", "hard", "killer"].includes(String(result.difficulty))) return false;
    if (result.cognitiveLevel !== undefined && !["recall", "understanding", "application", "reasoning"].includes(String(result.cognitiveLevel))) return false;
    if (result.expectedTimeSec !== undefined && (!reviewFinite(result.expectedTimeSec) || Number(result.expectedTimeSec) < 0)) return false;
    for (const key of ["mistakeTypes", "prerequisites"] as const) {
        if (result[key] !== undefined && (!denseReviewArray(result[key], 500) || !result[key].every(item => reviewString(item, 512)))) return false;
    }
    if (result.pdfLocation !== undefined) {
        const location = ownReviewRecord(result.pdfLocation);
        if (!location || !exactReviewKeys(location, ["page", "x", "y"])
            || !Number.isSafeInteger(location.page) || Number(location.page) <= 0
            || !reviewFinite(location.x) || !reviewFinite(location.y)) return false;
    }
    if (result.pdfRegion !== undefined && !validReviewRegion(result.pdfRegion)) return false;
    if (result.passagePdfRegions !== undefined
        && (!denseReviewArray(result.passagePdfRegions, 500) || !result.passagePdfRegions.every(validReviewRegion))) return false;
    return true;
}

const WEAKNESS_REQUIRED_KEYS = [
    "basis", "concepts", "key", "labels", "questionIds", "questionNumbers", "recommendedAction", "title", "totalCount", "wrongCount", "wrongRate",
] as const;
const RECOMMENDATION_EXTRA_KEYS = [
    "attemptCount", "kind", "priorityScore", "reason", "recommendedQuestionIds", "retakeConcepts", "retakeLabels",
    "retakeMode", "retakeQuestionIds", "scope", "severity", "slowCorrectCount", "slowCorrectQuestionNumbers",
    "sourceAttemptId", "studentCount", "unansweredCount",
] as const;

function validWeakness(value: unknown, recommendation: boolean): boolean {
    const row = ownReviewRecord(value);
    if (!row || !exactReviewKeys(row, WEAKNESS_REQUIRED_KEYS, recommendation ? RECOMMENDATION_EXTRA_KEYS : [])) return false;
    for (const key of ["basis", "key", "recommendedAction", "title"] as const) if (!reviewString(row[key], 2_000)) return false;
    for (const key of ["questionIds", "questionNumbers"] as const) if (!positiveReviewIntegers(row[key])) return false;
    for (const key of ["labels", "concepts"] as const) {
        if (!denseReviewArray(row[key], 500) || !row[key].every(item => reviewString(item, 512))) return false;
    }
    if (!Number.isSafeInteger(row.totalCount) || Number(row.totalCount) < 0
        || !Number.isSafeInteger(row.wrongCount) || Number(row.wrongCount) < 0 || Number(row.wrongCount) > Number(row.totalCount)
        || !reviewFinite(row.wrongRate) || Number(row.wrongRate) < 0 || Number(row.wrongRate) > 100) return false;
    if (!recommendation) return true;
    for (const key of ["attemptCount", "slowCorrectCount", "studentCount", "unansweredCount"] as const) {
        if (!Number.isSafeInteger(row[key]) || Number(row[key]) < 0) return false;
    }
    for (const key of ["recommendedQuestionIds", "retakeQuestionIds", "slowCorrectQuestionNumbers"] as const) {
        if (!positiveReviewIntegers(row[key])) return false;
    }
    for (const key of ["retakeConcepts", "retakeLabels"] as const) {
        if (!denseReviewArray(row[key], 500) || !row[key].every(item => reviewString(item, 512))) return false;
    }
    return ["source", "concept", "unit", "label", "skill", "difficulty", "mistakeType"].includes(String(row.kind))
        && ["attempt", "student", "class", "exam"].includes(String(row.scope))
        && ["watch", "review", "urgent"].includes(String(row.severity))
        && ["wrong", "similar"].includes(String(row.retakeMode))
        && reviewString(row.reason, 2_000) && reviewString(row.sourceAttemptId, 240)
        && reviewFinite(row.priorityScore) && Number(row.priorityScore) >= 0;
}

function validTrustedBehavior(value: unknown): boolean {
    const row = ownReviewRecord(value);
    if (!row || !exactReviewKeys(row, [
        "answerChangedQuestionNumbers", "averageTimeSec", "elapsedTimeSec", "focusLossCount", "focusLossQuestionNumbers",
        "revisitedQuestionNumbers", "rushedQuestionNumbers", "slowQuestionNumbers", "totalTrackedTimeSec",
    ])) return false;
    return [row.averageTimeSec, row.elapsedTimeSec, row.totalTrackedTimeSec].every(item => reviewFinite(item) && Number(item) >= 0)
        && Number.isSafeInteger(row.focusLossCount) && Number(row.focusLossCount) >= 0
        && [row.answerChangedQuestionNumbers, row.focusLossQuestionNumbers, row.revisitedQuestionNumbers, row.rushedQuestionNumbers, row.slowQuestionNumbers]
            .every(positiveReviewIntegers);
}

export function studentTrustedOfficialReviewFromUnknown(value: unknown): StudentTrustedOfficialReview | null {
    try {
        const root = ownReviewRecord(value);
        if (!root || !exactReviewKeys(root, TRUSTED_REVIEW_ROOT_KEYS) || root.gradingSource !== "canonical_submission"
            || !denseReviewArray(root.questions, 500) || !root.questions.every(validReviewQuestion)
            || !denseReviewArray(root.questionResults, 500) || !root.questionResults.every(validTrustedQuestionResult)
            || root.questions.length !== root.questionResults.length
            || !denseReviewArray(root.weaknessGroups, 20) || !root.weaknessGroups.every(item => validWeakness(item, false))
            || !denseReviewArray(root.recommendations, 20) || !root.recommendations.every(item => validWeakness(item, true))
            || !validTrustedBehavior(root.behavior)) return null;
        const questionIds = new Set<number>();
        const resultIds = new Set<number>();
        let earnedScore = 0;
        let totalScore = 0;
        let gradedQuestionCount = 0;
        let ungradedQuestionCount = 0;
        for (let index = 0; index < root.questions.length; index += 1) {
            const question = root.questions[index] as Record<string, unknown>;
            const result = root.questionResults[index] as Record<string, unknown>;
            const questionId = Number(question.id);
            const resultId = Number(result.questionId);
            if (questionIds.has(questionId) || resultIds.has(resultId)
                || questionId !== resultId
                || question.number !== result.questionNumber
                || !reviewFinite(question.score) || Number(question.score) !== Number(result.score)) return null;
            questionIds.add(questionId);
            resultIds.add(resultId);
            const choices = question.choices === 5 ? 5 : 4;
            const selected = result.selectedAnswer;
            const correct = result.correctAnswer;
            const status = result.status;
            if ((selected !== undefined && Number(selected) > choices)
                || (correct !== undefined && Number(correct) > choices)
                || (question.answer !== undefined && question.answer !== correct)) return null;
            if (status === "correct") {
                if (selected === undefined || correct === undefined || selected !== correct || result.earnedScore !== result.score) return null;
                gradedQuestionCount += 1;
                earnedScore += Number(result.earnedScore);
                totalScore += Number(result.score);
            } else if (status === "wrong") {
                if (selected === undefined || correct === undefined || selected === correct || result.earnedScore !== 0) return null;
                gradedQuestionCount += 1;
                totalScore += Number(result.score);
            } else if (status === "unanswered") {
                if (selected !== undefined || correct === undefined || result.earnedScore !== 0) return null;
                gradedQuestionCount += 1;
                totalScore += Number(result.score);
            } else {
                if (correct !== undefined || result.earnedScore !== 0) return null;
                ungradedQuestionCount += 1;
            }
        }
        const roundScore = (number: number) => Math.round(number * 100) / 100;
        earnedScore = roundScore(earnedScore);
        totalScore = roundScore(totalScore);
        const scorePercent = totalScore > 0 ? Math.round((earnedScore / totalScore) * 100) : 0;
        const score = ownReviewRecord(root.scoreSummary);
        if (!score || !exactReviewKeys(score, ["earnedScore", "gradedQuestionCount", "scorePercent", "totalScore", "ungradedQuestionCount"])
            || !reviewFinite(score.earnedScore) || Number(score.earnedScore) < 0
            || !reviewFinite(score.totalScore) || Number(score.totalScore) < 0 || Number(score.earnedScore) > Number(score.totalScore)
            || !reviewFinite(score.scorePercent) || Number(score.scorePercent) < 0 || Number(score.scorePercent) > 100
            || !Number.isSafeInteger(score.gradedQuestionCount) || Number(score.gradedQuestionCount) < 0
            || !Number.isSafeInteger(score.ungradedQuestionCount) || Number(score.ungradedQuestionCount) < 0
            || score.earnedScore !== earnedScore
            || score.totalScore !== totalScore
            || score.scorePercent !== scorePercent
            || score.gradedQuestionCount !== gradedQuestionCount
            || score.ungradedQuestionCount !== ungradedQuestionCount) return null;
        const serialized = JSON.stringify(root);
        if (new TextEncoder().encode(serialized).byteLength > 512 * 1024) return null;
        return JSON.parse(serialized) as StudentTrustedOfficialReview;
    } catch {
        return null;
    }
}

export interface StudentAttemptDetail {
    attempt: StudentAttemptRecord;
    exam: StudentAttemptReviewExam;
    /** Server-validated archive pointer. It is absent from history list rows. */
    handwritingRef?: StoredDataRef;
    /** Present only when the immutable submitted definition still equals the authoritative current exam. */
    retakeEligibleQuestionIds?: number[];
    /** Authenticated, server-verified display projection; digest fields never cross Flight. */
    trustedReview?: StudentTrustedOfficialReview;
}

export type StudentAttemptListResult =
    | { status: "loaded"; attempts: StudentAttemptRecord[] }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string };

export type StudentAttemptDetailResult =
    | { status: "loaded"; detail: StudentAttemptDetail }
    | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable"; error?: string };

function safeQuestionResult(
    result: NonNullable<Attempt["questionResults"]>[number],
    includeCanonicalEvidence: boolean,
): StudentAttemptQuestionResult {
    return {
        questionId: result.questionId,
        questionNumber: result.questionNumber,
        ...(typeof result.selectedAnswer === "number" ? { selectedAnswer: result.selectedAnswer } : {}),
        score: result.score,
        earnedScore: result.earnedScore,
        status: result.status,
        ...(includeCanonicalEvidence && typeof result.correctAnswer === "number"
            ? { correctAnswer: result.correctAnswer }
            : {}),
        ...(includeCanonicalEvidence && typeof result.assignmentRevision === "number"
            ? { assignmentRevision: result.assignmentRevision }
            : {}),
        ...(includeCanonicalEvidence && result.canonicalQuestionId ? { canonicalQuestionId: result.canonicalQuestionId } : {}),
        ...(includeCanonicalEvidence && result.label ? { label: result.label } : {}),
        ...(includeCanonicalEvidence && result.subject ? { subject: result.subject } : {}),
        ...(includeCanonicalEvidence && result.unit ? { unit: result.unit } : {}),
        ...(includeCanonicalEvidence && result.concept ? { concept: result.concept } : {}),
        ...(includeCanonicalEvidence && result.skill ? { skill: result.skill } : {}),
        ...(includeCanonicalEvidence && result.source ? { source: result.source } : {}),
        ...(includeCanonicalEvidence && result.difficulty ? { difficulty: result.difficulty } : {}),
        ...(includeCanonicalEvidence && result.cognitiveLevel ? { cognitiveLevel: result.cognitiveLevel } : {}),
        ...(includeCanonicalEvidence && result.mistakeTypes ? { mistakeTypes: [...result.mistakeTypes] } : {}),
        ...(includeCanonicalEvidence && result.prerequisites ? { prerequisites: [...result.prerequisites] } : {}),
        ...(includeCanonicalEvidence && typeof result.expectedTimeSec === "number" ? { expectedTimeSec: result.expectedTimeSec } : {}),
        ...(includeCanonicalEvidence && result.pdfLocation ? { pdfLocation: result.pdfLocation } : {}),
        ...(includeCanonicalEvidence && result.pdfRegion ? { pdfRegion: result.pdfRegion } : {}),
        ...(includeCanonicalEvidence && result.passagePdfRegions ? { passagePdfRegions: result.passagePdfRegions } : {}),
    };
}

export function studentAttemptRecordFromAttempt(
    attempt: Attempt,
    options: { includeCanonicalEvidence?: boolean } = {},
): StudentAttemptRecord | null {
    if (
        attempt.status !== "completed"
        || !attempt.studentId?.trim()
        || !attempt.studentName.trim()
        || !attempt.identityType
        || !Array.isArray(attempt.questionResults)
        || (attempt.questionResultsSource !== undefined
            && attempt.questionResultsSource !== "legacy_derived_current_exam")
    ) {
        return null;
    }
    return {
        id: attempt.id,
        examId: attempt.examId,
        examTitle: attempt.examTitle,
        studentId: attempt.studentId,
        studentName: attempt.studentName,
        identityType: attempt.identityType,
        ...(attempt.assignmentId ? { assignmentId: attempt.assignmentId } : {}),
        ...(typeof attempt.assignmentRevision === "number"
            ? { assignmentRevision: attempt.assignmentRevision }
            : {}),
        ...(attempt.groupId ? { groupId: attempt.groupId } : {}),
        ...(attempt.groupName ? { groupName: attempt.groupName } : {}),
        startedAt: attempt.startedAt,
        finishedAt: attempt.finishedAt,
        score: attempt.score,
        totalScore: attempt.totalScore,
        status: "completed",
        ...(typeof attempt.autoSubmitted === "boolean" ? { autoSubmitted: attempt.autoSubmitted } : {}),
        ...(typeof attempt.tabFociLostCount === "number" ? { tabFociLostCount: attempt.tabFociLostCount } : {}),
        ...(attempt.questionTimings ? { questionTimings: attempt.questionTimings } : {}),
        ...(attempt.focusLossEvents ? { focusLossEvents: attempt.focusLossEvents } : {}),
        ...(attempt.retake ? { retake: attempt.retake } : {}),
        ...(attempt.questionResultsSource === "legacy_derived_current_exam"
            ? { questionResultsSource: attempt.questionResultsSource }
            : {}),
        questionResults: attempt.questionResults.map(result => safeQuestionResult(
            result,
            options.includeCanonicalEvidence === true,
        )),
    };
}

export function attemptFromStudentAttemptRecord(record: StudentAttemptRecord): Attempt {
    const rawQuestionResultsSource: unknown = record.questionResultsSource;
    const questionResultsSource: Attempt["questionResultsSource"] = rawQuestionResultsSource === undefined
        ? undefined
        : rawQuestionResultsSource === "legacy_derived_current_exam"
            ? "legacy_derived_current_exam"
            : "incomplete_or_invalid";
    const answers: Record<number, number> = {};
    const questionResults = record.questionResults.map(result => {
        if (typeof result.selectedAnswer === "number") answers[result.questionId] = result.selectedAnswer;
        return {
            schemaVersion: 1 as const,
            attemptId: record.id,
            examId: record.examId,
            examTitle: record.examTitle,
            studentName: record.studentName,
            studentId: record.studentId,
            groupId: record.groupId,
            groupName: record.groupName,
            identityType: record.identityType,
            assignmentId: record.assignmentId,
            assignmentRevision: result.assignmentRevision ?? record.assignmentRevision,
            canonicalQuestionId: result.canonicalQuestionId,
            label: result.label,
            questionId: result.questionId,
            questionNumber: result.questionNumber,
            score: result.score,
            earnedScore: result.earnedScore,
            selectedAnswer: result.selectedAnswer,
            correctAnswer: result.correctAnswer,
            subject: result.subject,
            unit: result.unit,
            concept: result.concept,
            skill: result.skill,
            source: result.source,
            difficulty: result.difficulty,
            cognitiveLevel: result.cognitiveLevel,
            mistakeTypes: result.mistakeTypes,
            prerequisites: result.prerequisites,
            expectedTimeSec: result.expectedTimeSec,
            pdfLocation: result.pdfLocation,
            pdfRegion: result.pdfRegion,
            passagePdfRegions: result.passagePdfRegions,
            status: result.status,
            isCorrect: result.status === "correct",
            isWrong: result.status === "wrong",
            isUnanswered: result.status === "unanswered",
            finishedAt: record.finishedAt,
        };
    });
    return {
        id: record.id,
        examId: record.examId,
        examTitle: record.examTitle,
        studentName: record.studentName,
        studentId: record.studentId,
        groupId: record.groupId,
        groupName: record.groupName,
        identityType: record.identityType,
        assignmentId: record.assignmentId,
        assignmentRevision: record.assignmentRevision,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        score: record.score,
        totalScore: record.totalScore,
        answers,
        questionResults,
        questionResultsSource,
        status: "completed",
        autoSubmitted: record.autoSubmitted,
        tabFociLostCount: record.tabFociLostCount,
        questionTimings: record.questionTimings,
        focusLossEvents: record.focusLossEvents,
        retake: record.retake,
    };
}

export function studentAttemptReviewExamFromExam(exam: Exam): StudentAttemptReviewExam {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        questions: exam.questions.map(question => ({
            id: question.id,
            number: question.number,
            ...(typeof question.answer === "number" ? { answer: question.answer } : {}),
            ...(typeof question.score === "number" ? { score: question.score } : {}),
            ...(question.label ? { label: question.label } : {}),
            ...(question.tags ? { tags: question.tags } : {}),
            ...(question.explanation ? { explanation: question.explanation } : {}),
            ...(question.choices ? { choices: question.choices } : {}),
            ...(question.pdfLocation ? { pdfLocation: question.pdfLocation } : {}),
            ...(question.pdfRegion ? { pdfRegion: question.pdfRegion } : {}),
        })),
        ...(exam.pdfData ? { pdfData: exam.pdfData } : {}),
    };
}

export function examFromStudentAttemptReviewExam(exam: StudentAttemptReviewExam): Exam {
    return {
        id: exam.id,
        title: exam.title,
        createdAt: exam.createdAt,
        questions: exam.questions.map(question => ({ ...question })),
        pdfData: exam.pdfData,
    };
}
