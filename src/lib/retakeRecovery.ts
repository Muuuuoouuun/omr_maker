import type { Attempt, Exam, RetakeMetadata } from "@/types/omr";
import { getAttemptQuestionResults } from "@/lib/premiumAnalytics";

/**
 * Retake recovery: how much of what a student missed on the source attempt
 * they got right on the retake. The retake scope (retake.questionIds) is the
 * comparison universe; source results outside it are ignored.
 */

export interface RetakeRecoveryInsight {
    retakeAttemptId: string;
    sourceAttemptId: string;
    examId: string;
    studentName: string;
    mode: RetakeMetadata["mode"];
    finishedAt: string;
    /** Scoped question count (retake.questionIds ∩ exam questions). */
    questionCount: number;
    /** Wrong/unanswered in the source within scope — the recovery target. */
    targetCount: number;
    /** Target questions answered correctly on the retake. */
    recoveredCount: number;
    /** Correct in the source but missed on the retake (전체/유사 재시험 case). */
    regressedCount: number;
    retakeCorrectCount: number;
    /** recovered/target as a percent; undefined when there was nothing to recover. */
    recoveryRate?: number;
}

export interface RetakeRecoverySummary {
    retakeCount: number;
    /** Retakes with at least one recovery target (rate is meaningful). */
    measuredCount: number;
    targetCount: number;
    recoveredCount: number;
    regressedCount: number;
    /** Aggregate recovered/target percent across measured retakes. */
    recoveryRate?: number;
}

function isCorrect(status: string | undefined): boolean {
    return status === "correct";
}

function isMissed(status: string | undefined): boolean {
    return status === "wrong" || status === "unanswered";
}

/**
 * Owner identity of an attempt for cross-check. Guests key on guestId, roster
 * students on studentId; only compared when both attempts expose the same kind.
 */
function attemptOwnerKey(attempt: Attempt): string {
    if (attempt.guestId) return `guest:${attempt.guestId}`;
    if (attempt.studentId) return `student:${attempt.studentId}`;
    return "";
}

export function buildAttemptRetakeRecovery(
    exam: Exam,
    retakeAttempt: Attempt,
    sourceAttempt: Attempt,
): RetakeRecoveryInsight | null {
    const retake = retakeAttempt.retake;
    if (!retake) return null;
    if (retakeAttempt.examId !== exam.id || sourceAttempt.examId !== exam.id) return null;
    if (sourceAttempt.id !== retake.sourceAttemptId) return null;
    // Guard against a sourceAttemptId that (via id collision or a crafted
    // payload) points at a DIFFERENT student's attempt — recovery must compare
    // the same person to themselves. Skip only when both owners are known and differ.
    const retakeOwner = attemptOwnerKey(retakeAttempt);
    const sourceOwner = attemptOwnerKey(sourceAttempt);
    if (retakeOwner && sourceOwner && retakeOwner !== sourceOwner) return null;

    const examQuestionIds = new Set(exam.questions.map(q => q.id));
    const scopedIds = [...new Set(retake.questionIds)].filter(id => examQuestionIds.has(id));
    if (scopedIds.length === 0) return null;

    const sourceById = new Map(getAttemptQuestionResults(exam, sourceAttempt).map(r => [r.questionId, r]));
    const retakeById = new Map(getAttemptQuestionResults(exam, retakeAttempt).map(r => [r.questionId, r]));

    let targetCount = 0;
    let recoveredCount = 0;
    let regressedCount = 0;
    let retakeCorrectCount = 0;

    for (const questionId of scopedIds) {
        const source = sourceById.get(questionId);
        const redo = retakeById.get(questionId);
        if (isCorrect(redo?.status)) retakeCorrectCount += 1;
        if (isMissed(source?.status)) {
            targetCount += 1;
            if (isCorrect(redo?.status)) recoveredCount += 1;
        } else if (isCorrect(source?.status) && isMissed(redo?.status)) {
            regressedCount += 1;
        }
    }

    return {
        retakeAttemptId: retakeAttempt.id,
        sourceAttemptId: sourceAttempt.id,
        examId: exam.id,
        studentName: retakeAttempt.studentName,
        mode: retake.mode,
        finishedAt: retakeAttempt.finishedAt,
        questionCount: scopedIds.length,
        targetCount,
        recoveredCount,
        regressedCount,
        retakeCorrectCount,
        recoveryRate: targetCount > 0 ? Math.round((recoveredCount / targetCount) * 100) : undefined,
    };
}

/**
 * Join every retake attempt to its source attempt (by retake.sourceAttemptId)
 * and compute recovery. Retakes launched without a real source attempt
 * (sourceAttemptId like "exam:...", "student:...") are skipped.
 */
export function buildExamRetakeRecoveries(
    exam: Exam,
    retakeAttempts: Attempt[],
    allAttempts: Attempt[],
): RetakeRecoveryInsight[] {
    const attemptById = new Map(allAttempts.map(attempt => [attempt.id, attempt]));
    return retakeAttempts
        .map(retakeAttempt => {
            const sourceId = retakeAttempt.retake?.sourceAttemptId;
            if (!sourceId) return null;
            const source = attemptById.get(sourceId);
            if (!source || source.id === retakeAttempt.id) return null;
            return buildAttemptRetakeRecovery(exam, retakeAttempt, source);
        })
        .filter((insight): insight is RetakeRecoveryInsight => !!insight)
        .sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
}

export interface SourceRecoverySummary {
    /** Retakes of this attempt that were counted. */
    retakeCount: number;
    /** Missed on the source, answered correctly on at least one retake. */
    recoveredQuestionIds: number[];
    /** Missed on the source and still missed (or untried) on every retake. */
    unrecoveredQuestionIds: number[];
}

/**
 * The ORIGINAL attempt's view of recovery: which of its missed questions the
 * same student later answered correctly on any retake of it. Retakes whose
 * owner differs from the source owner are ignored.
 */
export function buildSourceAttemptRecovery(
    exam: Exam,
    sourceAttempt: Attempt,
    candidateAttempts: Attempt[],
): SourceRecoverySummary {
    const sourceOwner = attemptOwnerKey(sourceAttempt);
    const retakes = candidateAttempts.filter(candidate => {
        if (!candidate.retake || candidate.retake.sourceAttemptId !== sourceAttempt.id) return false;
        if (candidate.id === sourceAttempt.id || candidate.examId !== sourceAttempt.examId) return false;
        const owner = attemptOwnerKey(candidate);
        return !(owner && sourceOwner && owner !== sourceOwner);
    });

    const sourceById = new Map(getAttemptQuestionResults(exam, sourceAttempt).map(r => [r.questionId, r]));
    const missedIds = exam.questions
        .map(question => question.id)
        .filter(id => isMissed(sourceById.get(id)?.status));
    if (retakes.length === 0 || missedIds.length === 0) {
        return { retakeCount: retakes.length, recoveredQuestionIds: [], unrecoveredQuestionIds: missedIds };
    }

    const recovered = new Set<number>();
    for (const retakeAttempt of retakes) {
        const scopedIds = new Set(retakeAttempt.retake?.questionIds || []);
        const retakeById = new Map(getAttemptQuestionResults(exam, retakeAttempt).map(r => [r.questionId, r]));
        for (const id of missedIds) {
            if (!scopedIds.has(id)) continue;
            if (isCorrect(retakeById.get(id)?.status)) recovered.add(id);
        }
    }
    return {
        retakeCount: retakes.length,
        recoveredQuestionIds: missedIds.filter(id => recovered.has(id)),
        unrecoveredQuestionIds: missedIds.filter(id => !recovered.has(id)),
    };
}

export function summarizeRetakeRecoveries(insights: RetakeRecoveryInsight[]): RetakeRecoverySummary {
    const measured = insights.filter(insight => insight.targetCount > 0);
    const targetCount = measured.reduce((sum, insight) => sum + insight.targetCount, 0);
    const recoveredCount = measured.reduce((sum, insight) => sum + insight.recoveredCount, 0);
    const regressedCount = insights.reduce((sum, insight) => sum + insight.regressedCount, 0);
    return {
        retakeCount: insights.length,
        measuredCount: measured.length,
        targetCount,
        recoveredCount,
        regressedCount,
        recoveryRate: targetCount > 0 ? Math.round((recoveredCount / targetCount) * 100) : undefined,
    };
}
