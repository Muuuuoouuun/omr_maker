import { withBrowserStorageLock } from "@/lib/browserStorageLock";
import { normalizeStudentQuestionBody, type StudentQuestionInput } from "@/lib/studentQuestions";
import type { Attempt, StudentQuestionNote } from "@/types/omr";

const STUDENT_QUESTION_OUTBOX_KEY = "omr_pending_student_questions_v1";
const STUDENT_QUESTION_QUARANTINE_KEY = "omr_pending_student_questions_quarantine_v1";
export const STUDENT_QUESTION_OUTBOX_LIMIT = 100;
const STUDENT_QUESTION_QUARANTINE_LIMIT = 20;
const OUTBOX_LOCK_NAME = "student-question-outbox";

export interface PendingStudentQuestion extends StudentQuestionInput {
    attemptId: string;
    queuedAt: string;
}

export interface StudentQuestionOutboxQuarantine {
    reason: string;
    detectedAt: string;
    byteLength: number;
    malformedEntryCount?: number;
}

export type StudentQuestionOutboxLock = <T>(
    name: string,
    operation: () => Promise<T> | T,
) => Promise<T>;

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "getItem" | "setItem" | "removeItem">;

let serverTail = Promise.resolve();
const serverProcessLock: StudentQuestionOutboxLock = async <T>(
    _name: string,
    operation: () => Promise<T> | T,
) => {
    const prior = serverTail;
    let release!: () => void;
    serverTail = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try {
        return await operation();
    } finally {
        release();
    }
};

function defaultLock(): StudentQuestionOutboxLock {
    return typeof window === "undefined" ? serverProcessLock : withBrowserStorageLock;
}

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
        || !Number.isSafeInteger(questionId)
        || !Number.isSafeInteger(questionNumber)
        || !Number.isFinite(Date.parse(queuedAt))
    ) return null;
    return { attemptId, questionId, questionNumber, body, queuedAt };
}

function parseEntries(raw: string | null): {
    entries: PendingStudentQuestion[];
    malformed: boolean;
    malformedEntryCount: number;
} {
    if (!raw) return { entries: [], malformed: false, malformedEntryCount: 0 };
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!Array.isArray(parsed)) return { entries: [], malformed: true, malformedEntryCount: 1 };
        const normalized = parsed.map(normalizeEntry);
        return {
            entries: normalized.filter((entry): entry is PendingStudentQuestion => !!entry),
            malformed: normalized.some(entry => !entry),
            malformedEntryCount: normalized.filter(entry => !entry).length,
        };
    } catch {
        return { entries: [], malformed: true, malformedEntryCount: 1 };
    }
}

function readAll(storage: StorageReader | null = defaultStorage()): PendingStudentQuestion[] {
    if (!storage) return [];
    try {
        return parseEntries(storage.getItem(STUDENT_QUESTION_OUTBOX_KEY)).entries;
    } catch {
        return [];
    }
}

export function readStudentQuestionOutboxQuarantine(
    storage: StorageReader | null = defaultStorage(),
): StudentQuestionOutboxQuarantine[] {
    if (!storage) return [];
    try {
        const parsed = JSON.parse(storage.getItem(STUDENT_QUESTION_QUARANTINE_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((value): value is StudentQuestionOutboxQuarantine => (
            !!value
            && typeof value === "object"
            && !Array.isArray(value)
            && typeof (value as StudentQuestionOutboxQuarantine).reason === "string"
            && typeof (value as StudentQuestionOutboxQuarantine).detectedAt === "string"
            && Number.isFinite((value as StudentQuestionOutboxQuarantine).byteLength)
        ));
    } catch {
        return [];
    }
}

function quarantineMalformed(
    storage: StorageWriter,
    raw: string,
    malformedEntryCount: number,
): boolean {
    const previous = readStudentQuestionOutboxQuarantine(storage);
    const metadata: StudentQuestionOutboxQuarantine = {
        reason: "malformed_outbox",
        detectedAt: new Date().toISOString(),
        byteLength: new TextEncoder().encode(raw).byteLength,
        malformedEntryCount,
    };
    try {
        storage.setItem(
            STUDENT_QUESTION_QUARANTINE_KEY,
            JSON.stringify([...previous, metadata].slice(-STUDENT_QUESTION_QUARANTINE_LIMIT)),
        );
        return true;
    } catch {
        return false;
    }
}

function readForMutation(storage: StorageWriter): PendingStudentQuestion[] | null {
    let raw: string | null;
    try {
        raw = storage.getItem(STUDENT_QUESTION_OUTBOX_KEY);
    } catch {
        return null;
    }
    const parsed = parseEntries(raw);
    if (parsed.malformed && raw && !quarantineMalformed(storage, raw, parsed.malformedEntryCount)) return null;
    return parsed.entries;
}

function writeAll(entries: PendingStudentQuestion[], storage: StorageWriter): boolean {
    if (entries.length > STUDENT_QUESTION_OUTBOX_LIMIT) return false;
    try {
        if (entries.length === 0) storage.removeItem(STUDENT_QUESTION_OUTBOX_KEY);
        else storage.setItem(STUDENT_QUESTION_OUTBOX_KEY, JSON.stringify(entries));
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

export async function queuePendingStudentQuestion(
    input: PendingStudentQuestion,
    storage: StorageWriter | null = defaultStorage(),
    lock: StudentQuestionOutboxLock = defaultLock(),
): Promise<
    | { status: "queued" }
    | { status: "invalid" }
    | { status: "capacity_exceeded" }
    | { status: "storage_error" }
> {
    const entry = normalizeEntry(input);
    if (!entry) return { status: "invalid" };
    if (!storage) return { status: "storage_error" };
    try {
        return await lock(OUTBOX_LOCK_NAME, () => {
            const current = readForMutation(storage);
            if (!current) return { status: "storage_error" as const };
            const existingIndex = current.findIndex(candidate => (
                candidate.attemptId === entry.attemptId && candidate.questionId === entry.questionId
            ));
            if (existingIndex < 0 && current.length >= STUDENT_QUESTION_OUTBOX_LIMIT) {
                return { status: "capacity_exceeded" as const };
            }
            const next = existingIndex < 0
                ? [...current, entry]
                : current.map((candidate, index) => index === existingIndex ? entry : candidate);
            return writeAll(next, storage)
                ? { status: "queued" as const }
                : { status: "storage_error" as const };
        });
    } catch {
        return { status: "storage_error" };
    }
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
    lock: StudentQuestionOutboxLock = defaultLock(),
): Promise<
    | { status: "empty" }
    | { status: "sent"; attempt: TAttempt }
    | { status: "retryable_error"; error?: string }
> {
    if (!storage) return { status: "retryable_error" };
    let pending: PendingStudentQuestion[];
    try {
        pending = await lock(OUTBOX_LOCK_NAME, () => readPendingStudentQuestions(attemptId, storage));
    } catch {
        return { status: "retryable_error", error: "storage_lock_failed" };
    }
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
            const acknowledged = await lock(OUTBOX_LOCK_NAME, () => {
                const current = readForMutation(storage);
                if (!current) return false;
                const remaining = current.filter(candidate => (
                    candidate.attemptId !== entry.attemptId
                    || candidate.questionId !== entry.questionId
                    || candidate.queuedAt !== entry.queuedAt
                    || candidate.body !== entry.body
                ));
                return writeAll(remaining, storage);
            });
            if (!acknowledged) return { status: "retryable_error", error: "ack_storage_failed" };
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
