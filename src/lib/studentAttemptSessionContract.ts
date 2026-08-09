import type { SubQuestionAnswers } from "@/types/omr";
import { canonicalStudentAttemptProgressPayload } from "@/lib/studentAttemptHandwritingCheckpoint";

export const STUDENT_ATTEMPT_LEASE_SECONDS = 45;
export const STUDENT_ATTEMPT_HEARTBEAT_MS = 15_000;
export const STUDENT_ATTEMPT_CHECKPOINT_MS = 5_000;

export type StudentAttemptSessionStatus = "in_progress" | "submitted" | "expired";

export interface StudentAttemptSessionState {
    sessionId: string;
    examId: string;
    status: StudentAttemptSessionStatus;
    revision: number;
    leaseEpoch: number;
    startedAt: string;
    deadlineAt: string;
    serverNow: string;
    answers: Record<number, number>;
    subQuestionAnswers: SubQuestionAnswers;
    progressPayload: Record<string, unknown>;
    allowedQuestionIds: number[];
    submittedAttemptId?: string;
    assignmentId?: string;
    assignmentRevision?: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function safePositiveInteger(value: unknown): number | null {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function safeIso(value: unknown): string {
    const candidate = clean(value);
    return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : "";
}

function safeAnswers(value: unknown, allowedQuestionIds: Set<number>): Record<number, number> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const answers: Record<number, number> = {};
    for (const [rawQuestionId, rawAnswer] of Object.entries(value)) {
        const questionId = Number(rawQuestionId);
        if (
            allowedQuestionIds.has(questionId)
            && Number.isInteger(rawAnswer)
            && Number(rawAnswer) >= 1
            && Number(rawAnswer) <= 5
        ) {
            answers[questionId] = Number(rawAnswer);
        }
    }
    return answers;
}

function safeSubQuestionAnswers(value: unknown, allowedQuestionIds: Set<number>): SubQuestionAnswers {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    try {
        if (JSON.stringify(value).length > 524_288) return {};
    } catch {
        return {};
    }
    const safe: SubQuestionAnswers = {};
    for (const [rawQuestionId, rawSubAnswers] of Object.entries(value).slice(0, 500)) {
        const questionId = Number(rawQuestionId);
        if (!allowedQuestionIds.has(questionId) || !rawSubAnswers || typeof rawSubAnswers !== "object" || Array.isArray(rawSubAnswers)) continue;
        const accepted: SubQuestionAnswers[number] = {};
        for (const [rawSubQuestionId, rawAnswer] of Object.entries(rawSubAnswers).slice(0, 10)) {
            const subQuestionId = clean(rawSubQuestionId);
            if (!subQuestionId || subQuestionId.length > 100 || !rawAnswer || typeof rawAnswer !== "object" || Array.isArray(rawAnswer)) continue;
            const answer = rawAnswer as Record<string, unknown>;
            if (
                answer.schemaVersion !== 1
                || typeof answer.body !== "string"
                || answer.body.length > 2_000
                || (answer.reviewStatus !== "needs_review" && answer.reviewStatus !== "reviewed")
            ) continue;
            accepted[subQuestionId] = {
                schemaVersion: 1,
                body: answer.body,
                reviewStatus: answer.reviewStatus,
                ...(safeIso(answer.answeredAt) ? { answeredAt: safeIso(answer.answeredAt) } : {}),
                ...(safeIso(answer.reviewedAt) ? { reviewedAt: safeIso(answer.reviewedAt) } : {}),
                ...(clean(answer.reviewedBy) ? { reviewedBy: clean(answer.reviewedBy).slice(0, 200) } : {}),
            };
        }
        if (Object.keys(accepted).length > 0) safe[questionId] = accepted;
    }
    return safe;
}

function safeProgressPayload(value: unknown): Record<string, unknown> {
    const canonical = canonicalStudentAttemptProgressPayload(value);
    if (canonical) return canonical;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return canonicalStudentAttemptProgressPayload({
        currentQuestionId: (value as Record<string, unknown>).currentQuestionId,
    }) || {};
}

export function studentAttemptSessionStateFromRpc(value: unknown): StudentAttemptSessionState | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (!candidate || typeof candidate !== "object") return null;
    const row = candidate as Record<string, unknown>;
    const sessionId = clean(row.session_id);
    const examId = clean(row.exam_id);
    const status = row.status === "in_progress" || row.status === "submitted" || row.status === "expired"
        ? row.status
        : null;
    const revision = safePositiveInteger(row.revision);
    const leaseEpoch = safePositiveInteger(row.lease_epoch);
    const startedAt = safeIso(row.started_at);
    const deadlineAt = safeIso(row.deadline_at);
    const serverNow = safeIso(row.server_now);
    const allowedQuestionIds = Array.isArray(row.allowed_question_ids)
        ? [...new Set(row.allowed_question_ids.map(Number).filter(id => Number.isInteger(id) && id > 0))]
        : [];
    const assignmentId = clean(row.assignment_id);
    const assignmentRevision = safePositiveInteger(row.assignment_revision);
    if (!sessionId || !examId || !status || !revision || !leaseEpoch || !startedAt || !deadlineAt || !serverNow
        || allowedQuestionIds.length === 0 || allowedQuestionIds.length > 500
        || Boolean(assignmentId) !== Boolean(assignmentRevision)) {
        return null;
    }
    const allowedQuestionIdSet = new Set(allowedQuestionIds);
    return {
        sessionId,
        examId,
        status,
        revision,
        leaseEpoch,
        startedAt,
        deadlineAt,
        serverNow,
        answers: safeAnswers(row.answers, allowedQuestionIdSet),
        subQuestionAnswers: safeSubQuestionAnswers(row.sub_question_answers, allowedQuestionIdSet),
        progressPayload: safeProgressPayload(row.progress_payload),
        allowedQuestionIds,
        ...(assignmentId && assignmentRevision
            ? { assignmentId, assignmentRevision }
            : {}),
        ...(clean(row.submitted_attempt_id) ? { submittedAttemptId: clean(row.submitted_attempt_id) } : {}),
    };
}

export function remainingAttemptSeconds(
    deadlineAt: string,
    serverNow: string,
    observedAtClientMs: number,
    clientNow = Date.now(),
): number {
    const deadlineMs = Date.parse(deadlineAt);
    const observedServerMs = Date.parse(serverNow);
    if (
        !Number.isFinite(deadlineMs)
        || !Number.isFinite(observedServerMs)
        || !Number.isFinite(observedAtClientMs)
        || !Number.isFinite(clientNow)
    ) return 0;
    const elapsedSinceObservation = Math.max(0, clientNow - observedAtClientMs);
    return Math.max(0, Math.ceil((deadlineMs - observedServerMs - elapsedSinceObservation) / 1000));
}
