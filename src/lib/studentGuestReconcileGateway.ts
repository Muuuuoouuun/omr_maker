import type { Attempt, Exam } from "@/types/omr";
import {
    attemptOwnedBy,
    buildServerAttempt,
    type SubmitAttemptInput,
} from "./studentExamCore";
import type { GuestClaimCapability } from "./studentGuestClaimCapability";
import type { StudentServerIdentity } from "./studentServerSession";

export const GUEST_RECONCILE_BATCH_LIMIT = 20;

export interface GuestAttemptReconcileItem {
    localAttemptId: string;
    submission: SubmitAttemptInput;
    completedAt?: string;
}

export interface GuestAttemptAcknowledgement {
    localAttemptId: string;
    canonicalAttemptId: string;
}

interface ReconcileDependencies {
    attemptIdFor(localAttemptId: string, examId: string, studentId: string): string | null;
    loadExam(examId: string): Promise<Exam | null>;
    loadExisting(attemptId: string): Promise<Attempt | null>;
    save(attempt: Attempt): Promise<Attempt | null>;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function guestAttemptToReconcileItem(
    attempt: Attempt,
    guestId: string,
): GuestAttemptReconcileItem | null {
    if (
        !clean(attempt.id)
        || !clean(attempt.examId)
        || attempt.guestId !== clean(guestId)
        || attempt.identityType !== "guest"
        || attempt.studentId !== `guest:${clean(guestId)}`
        || !attempt.answers
    ) return null;
    return {
        localAttemptId: attempt.id,
        completedAt: attempt.finishedAt,
        submission: {
            examId: attempt.examId,
            submissionId: attempt.id,
            answers: attempt.answers,
            subQuestionAnswers: attempt.subQuestionAnswers,
            startedAt: attempt.startedAt,
            autoSubmitted: attempt.autoSubmitted,
            questionTimings: attempt.questionTimings,
            focusLossEvents: attempt.focusLossEvents,
            tabFociLostCount: attempt.tabFociLostCount,
            retake: attempt.retake,
        },
    };
}

export async function reconcileGuestAttemptSubmissions(
    input: {
        capability: GuestClaimCapability;
        student: StudentServerIdentity;
        items: GuestAttemptReconcileItem[];
    },
    deps: ReconcileDependencies,
): Promise<{
    status: "ok" | "partial";
    acknowledgements: GuestAttemptAcknowledgement[];
}> {
    const permitted = new Set(input.capability.attemptIds);
    const acknowledgements: GuestAttemptAcknowledgement[] = [];
    const items = input.items.slice(0, GUEST_RECONCILE_BATCH_LIMIT);
    for (const item of items) {
        const localAttemptId = clean(item.localAttemptId);
        if (
            !localAttemptId
            || !permitted.has(localAttemptId)
            || clean(item.submission.submissionId) !== localAttemptId
        ) continue;
        try {
            const exam = await deps.loadExam(item.submission.examId);
            if (!exam || clean(exam.organizationId) !== input.capability.organizationId) continue;
            const canonicalAttemptId = deps.attemptIdFor(
                localAttemptId,
                exam.id,
                clean(input.student.studentId),
            );
            if (!canonicalAttemptId) continue;
            const existing = await deps.loadExisting(canonicalAttemptId);
            if (existing) {
                if (attemptOwnedBy(existing, input.student)) {
                    acknowledgements.push({ localAttemptId, canonicalAttemptId });
                }
                continue;
            }
            const finishedAt = item.completedAt && Number.isFinite(Date.parse(item.completedAt))
                ? item.completedAt
                : new Date().toISOString();
            const attempt = buildServerAttempt(
                item.submission,
                exam,
                input.student,
                canonicalAttemptId,
                finishedAt,
            );
            attempt.studentProfileId = input.student.studentId;
            attempt.classId = input.student.groupId;
            attempt.mergedFromGuestId = input.capability.guestId;
            attempt.mergedAt = finishedAt;
            const stored = await deps.save(attempt);
            if (stored && attemptOwnedBy(stored, input.student)) {
                acknowledgements.push({ localAttemptId, canonicalAttemptId: stored.id });
            }
        } catch {
            // Per-id reconciliation is retryable. One malformed/offline item
            // must not prevent authoritative ACKs for the rest of the batch.
        }
    }
    return {
        status: acknowledgements.length === input.items.length ? "ok" : "partial",
        acknowledgements,
    };
}
