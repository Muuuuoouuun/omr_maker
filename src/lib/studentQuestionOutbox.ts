import { normalizeStudentQuestionBody, type StudentQuestionInput } from "@/lib/studentQuestions";
import type { Attempt, StudentQuestionNote } from "@/types/omr";

const STUDENT_QUESTION_OUTBOX_KEY = "omr_pending_student_questions_v1";
const STUDENT_QUESTION_OUTBOX_LIMIT = 100;

export interface PendingStudentQuestion extends StudentQuestionInput {
    attemptId: string;
    queuedAt: string;
}

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): Storage | null {
    return typeof window !== "undefined" ? window.localStorage : null;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizeEntry(value: unknown): PendingStudentQuestion | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const attemptId = clean(record.attemptId);
    const body = normalizeStudentQuestionBody(clean(record.body));
    const questionId = Number(record.questionId);
    const questionNumber = Number(record.questionNumber);
    const queuedAt = clean(record.queuedAt);
    if (
        !attemptId
        || !body
        || !Number.isFinite(questionId)
        || !Number.isFinite(questionNumber)
        || !Number.isFinite(Date.parse(queuedAt))
    ) return null;
    return { attemptId, questionId, questionNumber, body, queuedAt };
}

function readAll(storage: StorageReader | null = defaultStorage()): PendingStudentQuestion[] {
    if (!storage) return [];
    try {
        const parsed = JSON.parse(storage.getItem(STUDENT_QUESTION_OUTBOX_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map(normalizeEntry)
            .filter((entry): entry is PendingStudentQuestion => !!entry)
            .slice(-STUDENT_QUESTION_OUTBOX_LIMIT);
    } catch {
        return [];
    }
}

function writeAll(entries: PendingStudentQuestion[], storage: StorageWriter | null): boolean {
    if (!storage) return false;
    try {
        if (entries.length === 0) storage.removeItem(STUDENT_QUESTION_OUTBOX_KEY);
        else storage.setItem(STUDENT_QUESTION_OUTBOX_KEY, JSON.stringify(entries.slice(-STUDENT_QUESTION_OUTBOX_LIMIT)));
        return true;
    } catch {
        return false;
    }
}

export function readPendingStudentQuestions(
    attemptId: string,
    storage: StorageReader | null = defaultStorage(),
): PendingStudentQuestion[] {
    return readAll(storage)
        .filter(entry => entry.attemptId === attemptId)
        .sort((a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt) || a.questionId - b.questionId);
}

export function queuePendingStudentQuestion(
    input: PendingStudentQuestion,
    storage: StorageWriter | null = defaultStorage(),
): boolean {
    const entry = normalizeEntry(input);
    if (!entry || !storage) return false;
    const next = readAll(storage).filter(candidate => (
        candidate.attemptId !== entry.attemptId || candidate.questionId !== entry.questionId
    ));
    next.push(entry);
    return writeAll(next, storage);
}

export function pendingStudentQuestionNotesById(
    attemptId: string,
    storage: StorageReader | null = defaultStorage(),
): Record<number, StudentQuestionNote> {
    return readPendingStudentQuestions(attemptId, storage).reduce<Record<number, StudentQuestionNote>>((notes, entry) => {
        notes[entry.questionId] = {
            questionId: entry.questionId,
            questionNumber: entry.questionNumber,
            body: entry.body,
            createdAt: entry.queuedAt,
            status: "queued",
        };
        return notes;
    }, {});
}

export async function flushPendingStudentQuestions<TAttempt extends Pick<Attempt, "id">>(
    attemptId: string,
    submit: (
        attemptId: string,
        question: StudentQuestionInput,
    ) => Promise<{ status: string; attempt?: TAttempt }>,
    storage: StorageWriter | null = defaultStorage(),
): Promise<
    | { status: "empty" }
    | { status: "sent"; attempt: TAttempt }
    | { status: "retryable_error"; error?: string }
> {
    const pending = readPendingStudentQuestions(attemptId, storage);
    if (pending.length === 0) return { status: "empty" };

    let latestAttempt: TAttempt | undefined;
    for (const entry of pending) {
        try {
            const result = await submit(attemptId, {
                questionId: entry.questionId,
                questionNumber: entry.questionNumber,
                body: entry.body,
            });
            if (result.status !== "ok" || !result.attempt) {
                return { status: "retryable_error", error: result.status };
            }
            latestAttempt = result.attempt;
            if (!storage) return { status: "retryable_error" };
            const remaining = readAll(storage).filter(candidate => (
                candidate.attemptId !== entry.attemptId
                || candidate.questionId !== entry.questionId
                || candidate.queuedAt !== entry.queuedAt
                || candidate.body !== entry.body
            ));
            if (!writeAll(remaining, storage)) return { status: "retryable_error" };
        } catch (error) {
            return {
                status: "retryable_error",
                error: error instanceof Error ? error.message : "Question retry failed",
            };
        }
    }

    if (!latestAttempt) return { status: "retryable_error" };
    return { status: "sent", attempt: latestAttempt };
}
