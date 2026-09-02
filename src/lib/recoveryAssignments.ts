import type { Attempt, Exam, QuestionResult } from "@/types/omr";
import { getAttemptQuestionResults, studentScopeKeyForAttempt } from "@/lib/premiumAnalytics";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { DEFAULT_RECOVERY_POLICY } from "@/lib/serviceRoadmap";

export interface RecoveryAssignmentProposal {
    key: string;
    attemptId: string;
    studentName: string;
    studentKey: string;
    groupName?: string;
    regionName?: string;
    questionIds: number[];
    questionNumbers: number[];
    missedCount: number;
    wrongCount: number;
    unansweredCount: number;
    ungradedCount: number;
    overflowCount: number;
    estimatedMinutes: number;
    href: string;
    needsIdentityReview: boolean;
}

export interface RecoveryAssignmentBatch {
    examId: string;
    examTitle: string;
    attemptCount: number;
    studentCount: number;
    candidateStudentCount: number;
    candidateQuestionCount: number;
    noActionStudentCount: number;
    exceptionStudentCount: number;
    proposals: RecoveryAssignmentProposal[];
}

export interface RecoveryAssignmentOptions {
    minMissedQuestions?: number;
    maxQuestionsPerAssignment?: number;
}

function activityTime(attempt: Attempt): number {
    return Date.parse(attempt.finishedAt || attempt.startedAt || "") || 0;
}

function isMissed(result: QuestionResult): boolean {
    return result.status === "wrong" || result.status === "unanswered" || result.isWrong || result.isUnanswered;
}

function stableStudentKey(attempt: Attempt): string {
    return attempt.studentProfileId?.trim() || studentScopeKeyForAttempt(attempt) || `attempt:${attempt.id}`;
}

function latestCompletedBaseAttempts(exam: Exam, attempts: Attempt[]): Attempt[] {
    const latestByStudent = new Map<string, Attempt>();
    const sorted = attempts
        .filter(attempt => attempt.examId === exam.id && attempt.status === "completed" && !attempt.retake)
        .sort((left, right) => activityTime(right) - activityTime(left));

    for (const attempt of sorted) {
        const studentKey = stableStudentKey(attempt);
        if (!latestByStudent.has(studentKey)) latestByStudent.set(studentKey, attempt);
    }

    return Array.from(latestByStudent.values());
}

function estimatedMinutes(questionCount: number): number {
    return Math.max(3, Math.ceil(questionCount * 0.8));
}

export function buildRecoveryAssignmentBatch(
    exam: Exam,
    attempts: Attempt[],
    options: RecoveryAssignmentOptions = {},
): RecoveryAssignmentBatch {
    const minMissedQuestions = Math.max(
        1,
        options.minMissedQuestions ?? DEFAULT_RECOVERY_POLICY.minMissedQuestionsForAutoCandidate,
    );
    const maxQuestionsPerAssignment = Math.max(
        1,
        options.maxQuestionsPerAssignment ?? DEFAULT_RECOVERY_POLICY.maxQuestionsPerAssignment,
    );
    const sourceAttempts = latestCompletedBaseAttempts(exam, attempts);
    const proposals: RecoveryAssignmentProposal[] = [];
    let noActionStudentCount = 0;

    for (const attempt of sourceAttempts) {
        const results = getAttemptQuestionResults(exam, attempt);
        const missedResults = results
            .filter(isMissed)
            .sort((left, right) => left.questionNumber - right.questionNumber);
        if (missedResults.length < minMissedQuestions) {
            noActionStudentCount += 1;
            continue;
        }

        const selectedResults = missedResults.slice(0, maxQuestionsPerAssignment);
        const questionIds = selectedResults.map(result => result.questionId);
        const wrongCount = selectedResults.filter(result => result.status === "wrong" || result.isWrong).length;
        const unansweredCount = selectedResults.filter(result => result.status === "unanswered" || result.isUnanswered).length;
        const ungradedCount = results.filter(result => result.status === "ungraded").length;
        const studentKey = stableStudentKey(attempt);

        proposals.push({
            key: `${exam.id}:${studentKey}`,
            attemptId: attempt.id,
            studentName: attempt.studentName,
            studentKey,
            groupName: attempt.groupName,
            regionName: attempt.regionName,
            questionIds,
            questionNumbers: selectedResults.map(result => result.questionNumber),
            missedCount: missedResults.length,
            wrongCount,
            unansweredCount,
            ungradedCount,
            overflowCount: Math.max(0, missedResults.length - selectedResults.length),
            estimatedMinutes: estimatedMinutes(questionIds.length),
            href: buildRetakeHref(exam.id, attempt.id, questionIds, "wrong"),
            needsIdentityReview: !attempt.studentProfileId?.trim() && !attempt.studentId?.trim(),
        });
    }

    proposals.sort((left, right) => {
        if (right.missedCount !== left.missedCount) return right.missedCount - left.missedCount;
        return left.studentName.localeCompare(right.studentName, "ko");
    });

    return {
        examId: exam.id,
        examTitle: exam.title,
        attemptCount: attempts.filter(attempt => (
            attempt.examId === exam.id && attempt.status === "completed" && !attempt.retake
        )).length,
        studentCount: sourceAttempts.length,
        candidateStudentCount: proposals.length,
        candidateQuestionCount: proposals.reduce((sum, proposal) => sum + proposal.questionIds.length, 0),
        noActionStudentCount,
        exceptionStudentCount: proposals.filter(proposal => (
            proposal.ungradedCount > 0 || proposal.overflowCount > 0 || proposal.needsIdentityReview
        )).length,
        proposals,
    };
}

function absoluteRecoveryHref(origin: string, href: string): string {
    const normalizedOrigin = origin.trim().replace(/\/$/, "");
    return normalizedOrigin ? `${normalizedOrigin}${href}` : href;
}

export function formatRecoveryAssignmentBundle(
    batch: Pick<RecoveryAssignmentBatch, "examTitle" | "proposals">,
    selectedKeys: ReadonlySet<string>,
    origin = "",
): string {
    const selected = batch.proposals.filter(proposal => selectedKeys.has(proposal.key));
    if (selected.length === 0) return "";

    return [
        `[${batch.examTitle}] 오답 회복 과제`,
        ...selected.flatMap(proposal => [
            "",
            `${proposal.studentName}${proposal.groupName ? ` · ${proposal.groupName}` : ""} · ${proposal.questionIds.length}문항 · 약 ${proposal.estimatedMinutes}분`,
            absoluteRecoveryHref(origin, proposal.href),
        ]),
    ].join("\n");
}
