import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { SubmitAttemptInput } from "@/lib/studentExamCore";
import type { Attempt, IdentityType, QuestionResult } from "@/types/omr";

export type SubmissionReceiptStatus = "confirmed" | "pending" | "local_only";

export interface SubmissionReceipt {
    attemptId: string;
    status: SubmissionReceiptStatus;
    updatedAt: string;
    lastError?: string;
}

export interface PendingSignedSessionSubmission {
    attemptId: string;
    input: SubmitAttemptInput;
    pin?: string;
}

interface StoredSubmissionReceiptState {
    receipts: Record<string, SubmissionReceipt>;
    requests: Record<string, PendingSignedSessionSubmission>;
}

type SignedSessionSubmitResponse = {
    status: string;
    attempt?: Attempt;
};

export type SubmissionRetryResult =
    | { status: "confirmed"; attempt: Attempt }
    | { status: "pending"; error: string }
    | { status: "missing"; error: string };

const SUBMISSION_RECEIPT_KEY = "omr_student_submission_receipts_v1";
const RETRY_ERROR = "서버에 아직 반영하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.";
const retryInFlight = new Map<string, Promise<SubmissionRetryResult>>();

function emptyReceiptState(): StoredSubmissionReceiptState {
    return { receipts: {}, requests: {} };
}

function browserStorage(): Storage | null {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage;
    } catch {
        return null;
    }
}

function isReceiptStatus(value: unknown): value is SubmissionReceiptStatus {
    return value === "confirmed" || value === "pending" || value === "local_only";
}

function isPendingSubmissionRequest(
    id: string,
    value: unknown,
): value is PendingSignedSessionSubmission {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const request = value as Partial<PendingSignedSessionSubmission>;
    if (request.attemptId !== id || !request.input || typeof request.input !== "object") return false;
    const input = request.input as Partial<SubmitAttemptInput>;
    return typeof input.examId === "string"
        && input.examId.length > 0
        && typeof input.submissionId === "string"
        && input.submissionId.length > 0
        && typeof input.startedAt === "string"
        && !!input.answers
        && typeof input.answers === "object"
        && !Array.isArray(input.answers)
        && (request.pin === undefined || typeof request.pin === "string");
}

function readReceiptState(): StoredSubmissionReceiptState {
    const storage = browserStorage();
    if (!storage) return emptyReceiptState();
    try {
        const parsed = JSON.parse(storage.getItem(SUBMISSION_RECEIPT_KEY) || "{}") as {
            receipts?: unknown;
            requests?: unknown;
        };
        const rawReceipts = parsed.receipts && typeof parsed.receipts === "object" && !Array.isArray(parsed.receipts)
            ? parsed.receipts as Record<string, unknown>
            : {};
        const receipts = Object.entries(rawReceipts).reduce<Record<string, SubmissionReceipt>>((acc, [id, value]) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return acc;
            const receipt = value as Partial<SubmissionReceipt>;
            if (receipt.attemptId === id && isReceiptStatus(receipt.status) && typeof receipt.updatedAt === "string") {
                acc[id] = {
                    attemptId: id,
                    status: receipt.status,
                    updatedAt: receipt.updatedAt,
                    ...(typeof receipt.lastError === "string" ? { lastError: receipt.lastError } : {}),
                };
            }
            return acc;
        }, {});
        const rawRequests = parsed.requests && typeof parsed.requests === "object" && !Array.isArray(parsed.requests)
            ? parsed.requests as Record<string, unknown>
            : {};
        const requests = Object.entries(rawRequests).reduce<Record<string, PendingSignedSessionSubmission>>(
            (acc, [id, value]) => {
                if (isPendingSubmissionRequest(id, value)) acc[id] = value;
                return acc;
            },
            {},
        );
        return { receipts, requests };
    } catch {
        return emptyReceiptState();
    }
}

function writeReceiptState(state: StoredSubmissionReceiptState): boolean {
    const storage = browserStorage();
    if (!storage) return false;
    try {
        storage.setItem(SUBMISSION_RECEIPT_KEY, JSON.stringify(state));
        return true;
    } catch {
        return false;
    }
}

export function submissionReceiptLabel(
    receipt: { status: SubmissionReceiptStatus },
): string {
    if (receipt.status === "confirmed") return "서버 반영 완료";
    if (receipt.status === "pending") return "서버 반영 대기 · 자동 재시도";
    return "이 기기에만 저장됨";
}

export function persistSubmissionReceipt(receipt: SubmissionReceipt): boolean {
    const state = readReceiptState();
    state.receipts[receipt.attemptId] = receipt;
    if (receipt.status !== "pending") delete state.requests[receipt.attemptId];
    return writeReceiptState(state);
}

export function readSubmissionReceipt(attemptId: string): SubmissionReceipt | null {
    return readReceiptState().receipts[attemptId] || null;
}

export function queuePendingSubmissionReceipt(
    request: PendingSignedSessionSubmission,
    updatedAt = new Date().toISOString(),
): boolean {
    const state = readReceiptState();
    state.requests[request.attemptId] = request;
    state.receipts[request.attemptId] = {
        attemptId: request.attemptId,
        status: "pending",
        updatedAt,
    };
    return writeReceiptState(state);
}

export function pendingSubmissionReceiptIds(): string[] {
    const state = readReceiptState();
    return Object.keys(state.requests).filter(id => state.receipts[id]?.status === "pending");
}

export function retryPendingSubmissionReceipt(
    attemptId: string,
    deps: {
        submitSignedSessionAttempt: (
            input: SubmitAttemptInput,
            pin?: string,
        ) => Promise<SignedSessionSubmitResponse>;
    },
): Promise<SubmissionRetryResult> {
    const existing = retryInFlight.get(attemptId);
    if (existing) return existing;

    const retry = (async (): Promise<SubmissionRetryResult> => {
        const state = readReceiptState();
        const request = state.requests[attemptId];
        if (!request) {
            return { status: "missing", error: "다시 시도할 제출 요청을 찾지 못했습니다." };
        }
        try {
            const result = await deps.submitSignedSessionAttempt(request.input, request.pin);
            if (result.status === "ok" && result.attempt) {
                const latest = readReceiptState();
                latest.receipts[attemptId] = {
                    attemptId,
                    status: "confirmed",
                    updatedAt: new Date().toISOString(),
                };
                delete latest.requests[attemptId];
                writeReceiptState(latest);
                return { status: "confirmed", attempt: result.attempt };
            }
        } catch {
            // Keep the exact same idempotent request queued.
        }
        const latest = readReceiptState();
        latest.receipts[attemptId] = {
            attemptId,
            status: "pending",
            updatedAt: new Date().toISOString(),
            lastError: RETRY_ERROR,
        };
        writeReceiptState(latest);
        return { status: "pending", error: RETRY_ERROR };
    })().finally(() => {
        retryInFlight.delete(attemptId);
    });
    retryInFlight.set(attemptId, retry);
    return retry;
}

export async function flushPendingSubmissionReceipts(
    deps: Parameters<typeof retryPendingSubmissionReceipt>[1],
): Promise<number> {
    const ids = pendingSubmissionReceiptIds();
    await Promise.all(ids.map(id => retryPendingSubmissionReceipt(id, deps)));
    return pendingSubmissionReceiptIds().length;
}

export interface StudentReceiptCacheIdentity {
    examTitle: string;
    studentName: string;
    studentId?: string;
    groupId?: string;
    groupName?: string;
    identityType?: IdentityType;
}

/**
 * Converts the deliberately answer-key-free server receipt into the local review shape.
 * This is a cache projection only: all grading fields come from the server receipt.
 */
export function localResultCacheFromServerReceipt(
    receipt: ServerGradedAttemptReceipt,
    identity: StudentReceiptCacheIdentity,
): { answers: Record<number, number>; questionResults: QuestionResult[] } {
    const answers: Record<number, number> = {};
    const questionResults = receipt.questionResults.map(result => {
        if (typeof result.selectedAnswer === "number") {
            answers[result.questionId] = result.selectedAnswer;
        }
        return {
            schemaVersion: 1 as const,
            attemptId: receipt.attemptId,
            examId: receipt.examId,
            examTitle: identity.examTitle,
            studentName: identity.studentName,
            studentId: identity.studentId,
            groupId: identity.groupId,
            groupName: identity.groupName,
            identityType: identity.identityType,
            questionId: result.questionId,
            questionNumber: result.questionNumber,
            score: result.score,
            earnedScore: result.earnedScore,
            selectedAnswer: result.selectedAnswer,
            status: result.status,
            isCorrect: result.status === "correct",
            isWrong: result.status === "wrong",
            isUnanswered: result.status === "unanswered",
            finishedAt: receipt.finishedAt,
        } satisfies QuestionResult;
    });
    return { answers, questionResults };
}
