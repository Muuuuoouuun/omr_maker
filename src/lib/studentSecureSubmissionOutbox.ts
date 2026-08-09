import { withBrowserStorageLock } from "@/lib/browserStorageLock";
import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { FocusLossEvent, QuestionTiming, SubQuestionAnswers } from "@/types/omr";

export const SECURE_SUBMISSION_OUTBOX_LIMIT = 5;
export const MAX_SECURE_SUBMISSION_RECORD_BYTES = 512 * 1024;
const MAX_RECOVERED_SECURE_SUBMISSION_RECORD_BYTES = MAX_SECURE_SUBMISSION_RECORD_BYTES + 1024;
const MAX_LEGACY_SUBMISSION_ENVELOPE_OVERHEAD_BYTES = 16 * 1024;
export const MAX_SECURE_SUBMISSION_OUTBOX_BYTES = 2 * 1024 * 1024;
export const SECURE_SUBMISSION_TTL_MS = 24 * 60 * 60 * 1000;
export const SECURE_SUBMISSION_OUTBOX_EVENT = "omr:secure-submission-outbox-change";

const DB_NAME = "omr-secure-submission-outbox-v1";
const STORE_NAME = "submissions";
const NOTICE_STORE_NAME = "recoveryNotices";
const OUTBOX_LOCK = "secure-student-submission-outbox";
const REPLAY_CLAIM_MS = 60_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60_000;
const RECOVERY_NOTICE_LIMIT = 20;

type SecureSubmissionState = "queued" | "blocked";
type SecureSubmissionBlockReason =
    | "revision_conflict"
    | "lease_conflict"
    | "expired"
    | "unauthenticated"
    | "invalid"
    | "not_found"
    | "not_owned"
    | "not_active"
    | "retake_denied"
    | "max_attempts";

export interface SecureSubmissionSnapshot {
    sessionId: string;
    examId: string;
    assignmentId?: string;
    assignmentRevision?: number;
    expectedRevision: number;
    expectedLeaseEpoch: number;
    leaseToken: string;
    answers: Record<number, number>;
    subQuestionAnswers: SubQuestionAnswers;
    progressPayload: Record<string, unknown>;
    autoSubmitted: boolean;
    tabFociLostCount: number;
    questionTimings: QuestionTiming[];
    focusLossEvents: FocusLossEvent[];
    finishedAt: string;
}

export interface SecureSubmissionOutboxRecord {
    schemaVersion: 2;
    id: string;
    ownerFingerprint: string;
    createdAt: string;
    expiresAt: string;
    byteLength: number;
    state: SecureSubmissionState;
    blockReason?: SecureSubmissionBlockReason;
    retryCount: number;
    nextAttemptAt: string;
    replayClaim?: { id: string; expiresAt: string };
    /** Mutable replay cursor; the snapshot itself is never replaced. */
    checkpointRevision?: number;
    /** Allows only the bounded exam-id overhead added while recovering a v1 snapshot. */
    recoveredFromSchemaVersion?: 1;
    snapshot: SecureSubmissionSnapshot;
}

interface LegacySecureSubmissionQuarantine {
    schemaVersion: 1;
    id: string;
    ownerFingerprint: string;
    expiresAt: string;
    byteLength: number;
    createdAt: string;
    state: SecureSubmissionState;
    retryCount: number;
    nextAttemptAt: string;
    blockReason?: SecureSubmissionBlockReason;
    replayClaim?: { id: string; expiresAt: string };
    checkpointRevision?: number;
    snapshot: Omit<SecureSubmissionSnapshot, "examId" | "assignmentId" | "assignmentRevision">;
}

export interface SecureSubmissionRecoveryNotice {
    id: string;
    kind: "expired" | "invalid" | "legacy_recovery_required";
    sessionId?: string;
    createdAt: string;
}

export type SecureSubmissionCommit =
    | { kind: "update"; record: SecureSubmissionOutboxRecord }
    | { kind: "retryable"; now: number; random: number }
    | { kind: "blocked"; reason: SecureSubmissionBlockReason }
    | { kind: "delete" }
    | { kind: "release" };

export interface SecureSubmissionOutboxStore {
    list(): Promise<unknown[]>;
    put(record: SecureSubmissionOutboxRecord): Promise<void>;
    replaceLegacy(
        id: string,
        expected: unknown,
        replacement: SecureSubmissionOutboxRecord,
    ): Promise<SecureSubmissionOutboxRecord | null>;
    delete(id: string): Promise<void>;
    deleteInvalid(raw: unknown): Promise<boolean>;
    claim(id: string, ownerFingerprint: string, claimId: string, now: number, expiresAt: number): Promise<SecureSubmissionOutboxRecord | null>;
    commit(id: string, claimId: string, resolution: SecureSubmissionCommit): Promise<boolean>;
    listNotices(): Promise<unknown[]>;
    putNotice(notice: SecureSubmissionRecoveryNotice): Promise<void>;
    deleteNotice(id: string): Promise<void>;
}

export type SecureSubmissionOutboxLock = <T>(operation: () => Promise<T>) => Promise<T>;

interface OutboxOptions {
    store?: SecureSubmissionOutboxStore;
    lock?: SecureSubmissionOutboxLock;
    now?: number;
    sessionId?: string;
    random?: () => number;
}

interface ReplayActions {
    resolveLegacyScope?(input: { sessionId: string }): Promise<
        | { status: "resolved"; examId: string }
        | { status: "targeted" | "not_found" | "unauthenticated" | "invalid" | "service_unavailable" | "error" }
    >;
    checkpoint(input: {
        sessionId: string;
        examId: string;
        assignmentId?: string;
        assignmentRevision?: number;
        expectedRevision: number;
        expectedLeaseEpoch: number;
        leaseToken: string;
        answers: Record<number, number>;
        subQuestionAnswers: SubQuestionAnswers;
        progressPayload: Record<string, unknown>;
        finalCheckpoint: true;
    }): Promise<{ status: string; session?: { revision: number; leaseEpoch: number } }>;
    submit(input: {
        sessionId: string;
        examId: string;
        assignmentId?: string;
        assignmentRevision?: number;
        expectedRevision: number;
        expectedLeaseEpoch: number;
        leaseToken: string;
        autoSubmitted: boolean;
        tabFociLostCount: number;
        questionTimings: QuestionTiming[];
        focusLossEvents: FocusLossEvent[];
        finishedAt: string;
    }): Promise<{ status: string; receipt?: ServerGradedAttemptReceipt }>;
}

const processTails = new Map<string, Promise<void>>();

const processLock: SecureSubmissionOutboxLock = async operation => {
    const prior = processTails.get(OUTBOX_LOCK) || Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const tail = prior.then(() => next);
    processTails.set(OUTBOX_LOCK, tail);
    await prior;
    try {
        return await operation();
    } finally {
        release();
        if (processTails.get(OUTBOX_LOCK) === tail) processTails.delete(OUTBOX_LOCK);
    }
};

function defaultLock(): SecureSubmissionOutboxLock {
    return typeof window === "undefined"
        ? processLock
        : operation => withBrowserStorageLock(OUTBOX_LOCK, operation);
}

function bytes(value: unknown): number {
    try {
        return new TextEncoder().encode(JSON.stringify(value)).byteLength;
    } catch {
        return Number.POSITIVE_INFINITY;
    }
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function validPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 1;
}

function validBlockReason(value: unknown): value is SecureSubmissionBlockReason {
    return typeof value === "string" && [
        "revision_conflict", "lease_conflict", "expired", "unauthenticated", "invalid",
        "not_found", "not_owned", "not_active", "retake_denied", "max_attempts",
    ].includes(value);
}

function validReplayClaim(value: unknown): value is { id: string; expiresAt: string } {
    return !!value && typeof value === "object" && !Array.isArray(value)
        && Object.keys(value).every(key => key === "id" || key === "expiresAt")
        && clean((value as { id?: unknown }).id).length > 0
        && clean((value as { id?: unknown }).id).length <= 256
        && clean((value as { expiresAt?: unknown }).expiresAt).length <= 40
        && Number.isFinite(Date.parse(clean((value as { expiresAt?: unknown }).expiresAt)));
}

function validSnapshot(value: unknown): value is SecureSubmissionSnapshot {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const candidate = value as Partial<SecureSubmissionSnapshot>;
    const assignmentId = clean(candidate.assignmentId);
    const assignmentRevision = Number(candidate.assignmentRevision);
    const exactKeys = [
        "answers", "assignmentId", "assignmentRevision", "autoSubmitted", "examId",
        "expectedLeaseEpoch", "expectedRevision", "finishedAt", "focusLossEvents",
        "leaseToken", "progressPayload", "questionTimings", "sessionId",
        "subQuestionAnswers", "tabFociLostCount",
    ];
    return Object.keys(candidate).every(key => exactKeys.includes(key))
        && clean(candidate.sessionId).length > 0
        && clean(candidate.sessionId).length <= 256
        && clean(candidate.examId).length > 0
        && clean(candidate.examId).length <= 256
        && (assignmentId
            ? validPositiveInteger(assignmentRevision)
            : candidate.assignmentRevision === undefined)
        && validPositiveInteger(candidate.expectedRevision)
        && validPositiveInteger(candidate.expectedLeaseEpoch)
        && clean(candidate.leaseToken).length > 0
        && clean(candidate.leaseToken).length <= 512
        && !!candidate.answers && typeof candidate.answers === "object" && !Array.isArray(candidate.answers)
        && !!candidate.subQuestionAnswers && typeof candidate.subQuestionAnswers === "object" && !Array.isArray(candidate.subQuestionAnswers)
        && !!candidate.progressPayload && typeof candidate.progressPayload === "object" && !Array.isArray(candidate.progressPayload)
        && typeof candidate.autoSubmitted === "boolean"
        && Number.isSafeInteger(candidate.tabFociLostCount) && Number(candidate.tabFociLostCount) >= 0
        && Array.isArray(candidate.questionTimings)
        && Array.isArray(candidate.focusLossEvents)
        && Number.isFinite(Date.parse(clean(candidate.finishedAt)));
}

function normalizedRecord(value: unknown): SecureSubmissionOutboxRecord | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<SecureSubmissionOutboxRecord>;
    const exactKeys = [
        "blockReason", "byteLength", "checkpointRevision", "createdAt", "expiresAt", "id",
        "nextAttemptAt", "ownerFingerprint", "recoveredFromSchemaVersion", "replayClaim",
        "retryCount", "schemaVersion", "snapshot", "state",
    ];
    const snapshotBytes = bytes(candidate.snapshot);
    const recordLimit = candidate.recoveredFromSchemaVersion === 1
        ? MAX_RECOVERED_SECURE_SUBMISSION_RECORD_BYTES
        : MAX_SECURE_SUBMISSION_RECORD_BYTES;
    if (
        candidate.schemaVersion !== 2
        || Object.keys(candidate).some(key => !exactKeys.includes(key))
        || clean(candidate.id).length === 0
        || clean(candidate.id).length > 256
        || clean(candidate.ownerFingerprint).length !== 64
        || clean(candidate.createdAt).length > 40
        || !Number.isFinite(Date.parse(clean(candidate.createdAt)))
        || clean(candidate.expiresAt).length > 40
        || !Number.isFinite(Date.parse(clean(candidate.expiresAt)))
        || !Number.isSafeInteger(candidate.byteLength)
        || Number(candidate.byteLength) <= 0
        || Number(candidate.byteLength) !== snapshotBytes
        || Number(candidate.byteLength) > recordLimit
        || (candidate.recoveredFromSchemaVersion !== undefined && candidate.recoveredFromSchemaVersion !== 1)
        || (candidate.state !== "queued" && candidate.state !== "blocked")
        || (candidate.blockReason !== undefined && !validBlockReason(candidate.blockReason))
        || !Number.isSafeInteger(candidate.retryCount)
        || Number(candidate.retryCount) < 0
        || Number(candidate.retryCount) > 1_000_000
        || clean(candidate.nextAttemptAt).length > 40
        || !Number.isFinite(Date.parse(clean(candidate.nextAttemptAt)))
        || (candidate.replayClaim !== undefined && !validReplayClaim(candidate.replayClaim))
        || (candidate.checkpointRevision !== undefined && !validPositiveInteger(candidate.checkpointRevision))
        || bytes(value) > snapshotBytes + MAX_LEGACY_SUBMISSION_ENVELOPE_OVERHEAD_BYTES
        || !validSnapshot(candidate.snapshot)
        || candidate.id !== candidate.snapshot.sessionId
    ) return null;
    return candidate as SecureSubmissionOutboxRecord;
}

function normalizedLegacyQuarantine(value: unknown): LegacySecureSubmissionQuarantine | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const snapshot = candidate.snapshot;
    const legacySnapshot = snapshot as Partial<SecureSubmissionSnapshot>;
    const legacyKeys = [
        "answers", "autoSubmitted", "expectedLeaseEpoch", "expectedRevision",
        "finishedAt", "focusLossEvents", "leaseToken", "progressPayload",
        "questionTimings", "sessionId", "subQuestionAnswers", "tabFociLostCount",
    ];
    const exactKeys = [
        "blockReason", "byteLength", "checkpointRevision", "createdAt", "expiresAt", "id",
        "nextAttemptAt", "ownerFingerprint", "replayClaim", "retryCount", "schemaVersion",
        "snapshot", "state",
    ];
    const snapshotBytes = bytes(snapshot);
    const replayClaim = candidate.replayClaim;
    if (
        candidate.schemaVersion !== 1
        || Object.keys(candidate).some(key => !exactKeys.includes(key))
        || clean(candidate.id).length === 0
        || clean(candidate.id).length > 256
        || clean(candidate.ownerFingerprint).length !== 64
        || clean(candidate.createdAt).length > 40
        || !Number.isFinite(Date.parse(clean(candidate.createdAt)))
        || clean(candidate.expiresAt).length > 40
        || !Number.isFinite(Date.parse(clean(candidate.expiresAt)))
        || !Number.isSafeInteger(candidate.byteLength)
        || Number(candidate.byteLength) <= 0
        || Number(candidate.byteLength) > MAX_SECURE_SUBMISSION_RECORD_BYTES
        || Number(candidate.byteLength) !== snapshotBytes
        || bytes(value) > snapshotBytes + MAX_LEGACY_SUBMISSION_ENVELOPE_OVERHEAD_BYTES
        || !snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)
        || clean((snapshot as { sessionId?: unknown }).sessionId) !== clean(candidate.id)
        || Object.keys(snapshot).some(key => !legacyKeys.includes(key)
            && key !== "examId" && key !== "assignmentId" && key !== "assignmentRevision")
        || !validSnapshot({
            ...legacySnapshot,
            examId: "legacy-recovery-validation",
            assignmentId: undefined,
            assignmentRevision: undefined,
        })
        || (candidate.state !== "queued" && candidate.state !== "blocked")
        || (candidate.blockReason !== undefined && !validBlockReason(candidate.blockReason))
        || !Number.isSafeInteger(candidate.retryCount) || Number(candidate.retryCount) < 0
        || Number(candidate.retryCount) > 1_000_000
        || clean(candidate.nextAttemptAt).length > 40
        || !Number.isFinite(Date.parse(clean(candidate.nextAttemptAt)))
        || (replayClaim !== undefined && !validReplayClaim(replayClaim))
        || (candidate.checkpointRevision !== undefined && !validPositiveInteger(candidate.checkpointRevision))
    ) return null;
    const recoveredSnapshot = Object.fromEntries(
        legacyKeys.map(key => [key, (snapshot as Record<string, unknown>)[key]]),
    ) as unknown as Omit<SecureSubmissionSnapshot, "examId" | "assignmentId" | "assignmentRevision">;
    return {
        schemaVersion: 1,
        id: clean(candidate.id),
        ownerFingerprint: clean(candidate.ownerFingerprint),
        expiresAt: clean(candidate.expiresAt),
        byteLength: Number(candidate.byteLength),
        createdAt: clean(candidate.createdAt),
        state: candidate.state,
        retryCount: Number(candidate.retryCount),
        nextAttemptAt: clean(candidate.nextAttemptAt),
        ...(candidate.blockReason ? { blockReason: candidate.blockReason as SecureSubmissionBlockReason } : {}),
        ...(replayClaim ? { replayClaim: replayClaim as { id: string; expiresAt: string } } : {}),
        ...(candidate.checkpointRevision ? { checkpointRevision: Number(candidate.checkpointRevision) } : {}),
        snapshot: recoveredSnapshot,
    };
}

function normalizedNotice(value: unknown): SecureSubmissionRecoveryNotice | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Partial<SecureSubmissionRecoveryNotice>;
    if (
        clean(candidate.id).length === 0
        || !["expired", "invalid", "legacy_recovery_required"].includes(String(candidate.kind))
        || !Number.isFinite(Date.parse(clean(candidate.createdAt)))
        || (candidate.sessionId !== undefined && clean(candidate.sessionId).length === 0)
    ) return null;
    return candidate as SecureSubmissionRecoveryNotice;
}

function retryDelayMs(retryCount: number, random: number): number {
    const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(retryCount, 12));
    return Math.round(exponential * (1 + Math.max(0, Math.min(1, random)) * 0.25));
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === "undefined") {
            reject(new Error("IndexedDB unavailable"));
            return;
        }
        const request = indexedDB.open(DB_NAME, 2);
        let settled = false;
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(STORE_NAME)) {
                request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
            }
            if (!request.result.objectStoreNames.contains(NOTICE_STORE_NAME)) {
                request.result.createObjectStore(NOTICE_STORE_NAME, { keyPath: "id" });
            }
        };
        request.onsuccess = () => {
            settled = true;
            resolve(request.result);
        };
        request.onerror = () => {
            settled = true;
            reject(request.error || new Error("Secure submission outbox unavailable"));
        };
        request.onblocked = () => {
            if (!settled) reject(new Error("Secure submission outbox upgrade blocked"));
        };
    });
}

async function transact<T>(
    mode: IDBTransactionMode,
    requestFactory: (store: IDBObjectStore) => IDBRequest<T>,
    storeName = STORE_NAME,
): Promise<T> {
    const database = await openDatabase();
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(storeName, mode);
        const request = requestFactory(transaction.objectStore(storeName));
        let result!: T;
        let requestFinished = false;
        let settled = false;
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            database.close();
            reject(error);
        };
        request.onsuccess = () => {
            result = request.result;
            requestFinished = true;
        };
        request.onerror = () => rejectOnce(request.error);
        transaction.oncomplete = () => {
            if (settled) return;
            settled = true;
            database.close();
            if (requestFinished) resolve(result);
            else reject(new Error("Secure submission transaction completed early"));
        };
        transaction.onerror = () => rejectOnce(transaction.error || new Error("Secure submission transaction failed"));
        transaction.onabort = () => rejectOnce(transaction.error || new Error("Secure submission transaction aborted"));
    });
}

async function atomicRecordMutation<T>(
    id: string,
    mutate: (record: SecureSubmissionOutboxRecord | null) => {
        result: T;
        record?: SecureSubmissionOutboxRecord;
        remove?: boolean;
    },
): Promise<T> {
    const database = await openDatabase();
    return new Promise<T>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id) as IDBRequest<unknown>;
        let result!: T;
        let mutated = false;
        request.onsuccess = () => {
            const mutation = mutate(normalizedRecord(request.result));
            result = mutation.result;
            mutated = true;
            if (mutation.remove) store.delete(id);
            else if (mutation.record) store.put(mutation.record);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            database.close();
            if (mutated) resolve(result);
            else reject(new Error("Secure submission mutation completed early"));
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error || new Error("Secure submission mutation failed"));
        };
        transaction.onabort = () => {
            database.close();
            reject(transaction.error || request.error || new Error("Secure submission mutation aborted"));
        };
    });
}

async function atomicLegacyReplace(
    id: string,
    expected: unknown,
    replacement: SecureSubmissionOutboxRecord,
): Promise<SecureSubmissionOutboxRecord | null> {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(id) as IDBRequest<unknown>;
        let result: SecureSubmissionOutboxRecord | null = null;
        request.onsuccess = () => {
            const currentRecord = normalizedRecord(request.result);
            if (currentRecord) {
                result = currentRecord;
                return;
            }
            const currentLegacy = normalizedLegacyQuarantine(request.result);
            const expectedLegacy = normalizedLegacyQuarantine(expected);
            if (!currentLegacy || !expectedLegacy
                || JSON.stringify(currentLegacy) !== JSON.stringify(expectedLegacy)) return;
            result = replacement;
            store.put(replacement);
        };
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => {
            database.close();
            resolve(result);
        };
        transaction.onerror = () => {
            database.close();
            reject(transaction.error || new Error("Secure submission legacy replacement failed"));
        };
        transaction.onabort = () => {
            database.close();
            reject(transaction.error || request.error || new Error("Secure submission legacy replacement aborted"));
        };
    });
}

function claimRecord(
    record: SecureSubmissionOutboxRecord | null,
    ownerFingerprint: string,
    claimId: string,
    now: number,
    expiresAt: number,
): { result: SecureSubmissionOutboxRecord | null; record?: SecureSubmissionOutboxRecord } {
    if (
        !record
        || record.ownerFingerprint !== ownerFingerprint
        || record.state !== "queued"
        || Date.parse(record.expiresAt) <= now
        || Date.parse(record.nextAttemptAt) > now
        || (record.replayClaim && Date.parse(record.replayClaim.expiresAt) > now)
    ) return { result: null };
    const claimed = { ...record, replayClaim: { id: claimId, expiresAt: new Date(expiresAt).toISOString() } };
    return { result: claimed, record: claimed };
}

function commitRecord(
    record: SecureSubmissionOutboxRecord | null,
    claimId: string,
    resolution: SecureSubmissionCommit,
): { result: boolean; record?: SecureSubmissionOutboxRecord; remove?: boolean } {
    if (!record || record.replayClaim?.id !== claimId) return { result: false };
    if (resolution.kind === "delete") return { result: true, remove: true };
    if (resolution.kind === "update") {
        return { result: true, record: { ...resolution.record, replayClaim: record.replayClaim } };
    }
    if (resolution.kind === "blocked") {
        return { result: true, record: { ...record, state: "blocked", blockReason: resolution.reason, replayClaim: undefined } };
    }
    if (resolution.kind === "retryable") {
        const retryCount = record.retryCount + 1;
        return {
            result: true,
            record: {
                ...record,
                retryCount,
                nextAttemptAt: new Date(resolution.now + retryDelayMs(record.retryCount, resolution.random)).toISOString(),
                replayClaim: undefined,
            },
        };
    }
    return { result: true, record: { ...record, replayClaim: undefined } };
}

const indexedDbStore: SecureSubmissionOutboxStore = {
    list: () => transact("readonly", store => store.getAll()),
    put: record => transact("readwrite", store => store.put(record)).then(() => undefined),
    replaceLegacy: atomicLegacyReplace,
    delete: id => transact("readwrite", store => store.delete(id)).then(() => undefined),
    deleteInvalid: async raw => {
        const id = raw && typeof raw === "object" && !Array.isArray(raw)
            ? (raw as { id?: unknown }).id
            : undefined;
        if (typeof id !== "string" || !id) return false;
        await transact("readwrite", store => store.delete(id));
        return true;
    },
    claim: (id, ownerFingerprint, claimId, now, expiresAt) => atomicRecordMutation(
        id,
        record => claimRecord(record, ownerFingerprint, claimId, now, expiresAt),
    ),
    commit: (id, claimId, resolution) => atomicRecordMutation(
        id,
        record => commitRecord(record, claimId, resolution),
    ),
    listNotices: () => transact("readonly", store => store.getAll(), NOTICE_STORE_NAME),
    putNotice: notice => transact("readwrite", store => store.put(notice), NOTICE_STORE_NAME).then(() => undefined),
    deleteNotice: id => transact("readwrite", store => store.delete(id), NOTICE_STORE_NAME).then(() => undefined),
};

function defaultStore(): SecureSubmissionOutboxStore {
    return indexedDbStore;
}

function emitOutboxEvent(detail: Record<string, unknown>): void {
    if (typeof window === "undefined") return;
    try {
        window.dispatchEvent(new CustomEvent(SECURE_SUBMISSION_OUTBOX_EVENT, { detail }));
    } catch {
        // Persistence is authoritative; this event only updates visible UI.
    }
}

function randomId(prefix: string): string {
    const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    return `${prefix}-${value}`;
}

export function createMemorySecureSubmissionStore(): SecureSubmissionOutboxStore & { list(): Promise<SecureSubmissionOutboxRecord[]> } {
    const records = new Map<unknown, SecureSubmissionOutboxRecord>();
    const notices = new Map<string, SecureSubmissionRecoveryNotice>();
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
    return {
        list: async () => [...records.values()].map(clone),
        put: async record => { records.set(record.id, clone(record)); },
        replaceLegacy: async (id, expected, replacement) => {
            const current = records.get(id) as unknown;
            const currentRecord = normalizedRecord(current);
            if (currentRecord) return clone(currentRecord);
            const currentLegacy = normalizedLegacyQuarantine(current);
            const expectedLegacy = normalizedLegacyQuarantine(expected);
            if (!currentLegacy || !expectedLegacy
                || JSON.stringify(currentLegacy) !== JSON.stringify(expectedLegacy)) return null;
            records.set(id, clone(replacement));
            return clone(replacement);
        },
        delete: async id => { records.delete(id); },
        deleteInvalid: async raw => {
            for (const [key, value] of records) {
                if (value === raw || JSON.stringify(value) === JSON.stringify(raw)) {
                    records.delete(key);
                    return true;
                }
            }
            return false;
        },
        claim: async (id, ownerFingerprint, claimId, now, expiresAt) => {
            const mutation = claimRecord(records.get(id) || null, ownerFingerprint, claimId, now, expiresAt);
            if (mutation.record) records.set(id, clone(mutation.record));
            return mutation.result ? clone(mutation.result) : null;
        },
        commit: async (id, claimId, resolution) => {
            const mutation = commitRecord(records.get(id) || null, claimId, resolution);
            if (mutation.remove) records.delete(id);
            else if (mutation.record) records.set(id, clone(mutation.record));
            return mutation.result;
        },
        listNotices: async () => [...notices.values()].map(clone),
        putNotice: async notice => { notices.set(notice.id, clone(notice)); },
        deleteNotice: async id => { notices.delete(id); },
    };
}

export async function secureSubmissionOwnerFingerprint(ownerId: string): Promise<string> {
    const normalized = clean(ownerId);
    if (!normalized || !globalThis.crypto?.subtle) throw new Error("Owner fingerprint unavailable");
    const digest = await globalThis.crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(`omr-secure-submit-owner-v1\0${normalized}`),
    );
    return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
}

export async function queueSecureSubmission(
    ownerFingerprint: string,
    snapshot: SecureSubmissionSnapshot,
    options: OutboxOptions = {},
): Promise<
    | { status: "queued"; record: SecureSubmissionOutboxRecord }
    | { status: "invalid" | "record_too_large" | "capacity_exceeded" | "conflict" | "storage_error" }
> {
    if (clean(ownerFingerprint).length !== 64 || !validSnapshot(snapshot)) return { status: "invalid" };
    const byteLength = bytes(snapshot);
    if (byteLength > MAX_SECURE_SUBMISSION_RECORD_BYTES) return { status: "record_too_large" };
    const store = options.store || defaultStore();
    const lock = options.lock || defaultLock();
    const now = options.now ?? Date.now();
    try {
        return await lock(async () => {
            const rawRecords = await store.list();
            const records = rawRecords.map(normalizedRecord);
            const legacy = rawRecords.map(normalizedLegacyQuarantine);
            if (records.some((record, index) => !record && !legacy[index])) return { status: "storage_error" as const };
            const validRecords = records.filter((record): record is SecureSubmissionOutboxRecord => !!record);
            const existing = validRecords.find(record => record.id === snapshot.sessionId);
            if (legacy.some(record => record?.id === snapshot.sessionId)) return { status: "conflict" as const };
            if (existing) {
                if (existing.ownerFingerprint !== ownerFingerprint || JSON.stringify(existing.snapshot) !== JSON.stringify(snapshot)) {
                    return { status: "conflict" as const };
                }
                return { status: "queued" as const, record: existing };
            }
            if (
                validRecords.length >= SECURE_SUBMISSION_OUTBOX_LIMIT
                || validRecords.filter(Boolean).reduce((total, record) => total + record.byteLength, 0)
                    + byteLength > MAX_SECURE_SUBMISSION_OUTBOX_BYTES
            ) return { status: "capacity_exceeded" as const };
            const record: SecureSubmissionOutboxRecord = {
                schemaVersion: 2,
                id: snapshot.sessionId,
                ownerFingerprint,
                createdAt: new Date(now).toISOString(),
                expiresAt: new Date(now + SECURE_SUBMISSION_TTL_MS).toISOString(),
                byteLength,
                state: "queued",
                retryCount: 0,
                nextAttemptAt: new Date(now).toISOString(),
                snapshot: JSON.parse(JSON.stringify(snapshot)) as SecureSubmissionSnapshot,
            };
            await store.put(record);
            emitOutboxEvent({ sessionId: record.id, status: "queued" });
            return { status: "queued" as const, record };
        });
    } catch {
        return { status: "storage_error" };
    }
}

export async function readSecureSubmission(
    sessionId: string,
    options: Pick<OutboxOptions, "store"> = {},
): Promise<SecureSubmissionOutboxRecord | null> {
    try {
        const record = (await (options.store || defaultStore()).list())
            .map(normalizedRecord)
            .find(candidate => candidate?.id === sessionId);
        return record || null;
    } catch {
        return null;
    }
}

export async function maintainSecureSubmissionOutbox(
    options: Pick<OutboxOptions, "store" | "lock" | "now"> = {},
): Promise<{ expiredCount: number; invalidCount: number }> {
    const store = options.store || defaultStore();
    const lock = options.lock || defaultLock();
    const now = options.now ?? Date.now();
    return lock(async () => {
        const persistNotice = async (notice: SecureSubmissionRecoveryNotice): Promise<void> => {
            const notices = (await store.listNotices())
                .map(normalizedNotice)
                .filter((candidate): candidate is SecureSubmissionRecoveryNotice => !!candidate)
                .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
            if (notices.some(candidate => (
                candidate.kind === notice.kind
                && candidate.sessionId === notice.sessionId
            ))) return;
            // Write the new tombstone first. If cleanup is interrupted, the
            // next maintenance pass sees the durable notice before deleting
            // any sensitive payload.
            await store.putNotice(notice);
            if (notices.length >= RECOVERY_NOTICE_LIMIT) {
                await store.deleteNotice(notices[0].id);
            }
        };
        let expiredCount = 0;
        let invalidCount = 0;
        for (const raw of await store.list()) {
            const record = normalizedRecord(raw);
            if (!record) {
                const legacy = normalizedLegacyQuarantine(raw);
                if (legacy) {
                    if (Date.parse(legacy.expiresAt) <= now) {
                        await persistNotice({
                            id: randomId("expired"),
                            kind: "expired",
                            sessionId: legacy.id,
                            createdAt: new Date(now).toISOString(),
                        });
                        await store.delete(legacy.id);
                        expiredCount += 1;
                        emitOutboxEvent({ sessionId: legacy.id, status: "expired" });
                    } else {
                        // v1 did not persist the exact exam/assignment tuple.
                        // Recovery resolves it through the exact-owner server
                        // session boundary; maintenance retains it until TTL.
                    }
                    continue;
                }
                const id = raw && typeof raw === "object" && !Array.isArray(raw) ? clean((raw as { id?: unknown }).id) : "";
                await persistNotice({
                    id: randomId("invalid"),
                    kind: "invalid",
                    ...(id ? { sessionId: id } : {}),
                    createdAt: new Date(now).toISOString(),
                });
                if (id) await store.delete(id);
                else await store.deleteInvalid(raw);
                invalidCount += 1;
                continue;
            }
            if (Date.parse(record.expiresAt) <= now) {
                await persistNotice({
                    id: randomId("expired"),
                    kind: "expired",
                    sessionId: record.id,
                    createdAt: new Date(now).toISOString(),
                });
                await store.delete(record.id);
                expiredCount += 1;
                emitOutboxEvent({ sessionId: record.id, status: "expired" });
            }
        }
        return { expiredCount, invalidCount };
    });
}

export async function readSecureSubmissionRecoveryNotices(
    options: Pick<OutboxOptions, "store"> = {},
): Promise<SecureSubmissionRecoveryNotice[]> {
    try {
        return (await (options.store || defaultStore()).listNotices())
            .map(normalizedNotice)
            .filter((notice): notice is SecureSubmissionRecoveryNotice => !!notice)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    } catch {
        return [];
    }
}

export async function acknowledgeSecureSubmissionRecoveryNotice(
    noticeId: string,
    options: Pick<OutboxOptions, "store"> = {},
): Promise<boolean> {
    try {
        await (options.store || defaultStore()).deleteNotice(noticeId);
        return true;
    } catch {
        return false;
    }
}

const blockedStatuses = new Set<SecureSubmissionBlockReason>([
    "revision_conflict",
    "lease_conflict",
    "expired",
    "unauthenticated",
    "invalid",
    "not_found",
    "not_owned",
    "not_active",
    "retake_denied",
    "max_attempts",
]);

type SecureSubmissionReplayResult =
    | { status: "empty" | "deferred" | "submitted" | "retryable_error" | "blocked"; submitted: ServerGradedAttemptReceipt[]; blockedCount?: number }
    | { status: "storage_error"; submitted: ServerGradedAttemptReceipt[]; blockedCount: number };

const replayInFlight = new Map<string, Promise<SecureSubmissionReplayResult>>();

async function replaySecureSubmissionsForOwnerInternal(
    ownerFingerprint: string,
    actions: ReplayActions,
    options: OutboxOptions = {},
): Promise<SecureSubmissionReplayResult> {
    if (clean(ownerFingerprint).length !== 64) return { status: "empty", submitted: [] };
    const store = options.store || defaultStore();
    const lock = options.lock || defaultLock();
    const now = options.now ?? Date.now();
    try {
        const rawRecords = await store.list();
        const records = rawRecords.map(normalizedRecord);
        const legacy = rawRecords.map(normalizedLegacyQuarantine);
        if (records.some((record, index) => !record && !legacy[index])) {
            return { status: "storage_error", submitted: [], blockedCount: 0 };
        }
        const recoveredRecords: SecureSubmissionOutboxRecord[] = [];
        for (const candidate of legacy.filter((record): record is LegacySecureSubmissionQuarantine => (
            !!record && record.ownerFingerprint === ownerFingerprint && Date.parse(record.expiresAt) > now
        ))) {
            let resolution: Awaited<ReturnType<NonNullable<ReplayActions["resolveLegacyScope"]>>> | null = null;
            try {
                resolution = actions.resolveLegacyScope
                    ? await actions.resolveLegacyScope({ sessionId: candidate.id })
                    : null;
            } catch {
                resolution = null;
            }
            const resolvedExamId = resolution?.status === "resolved" ? clean(resolution.examId) : "";
            const exactResolved = resolution?.status === "resolved"
                && resolvedExamId.length > 0
                && resolvedExamId.length <= 256
                && Object.keys(resolution).every(key => key === "status" || key === "examId");
            if (exactResolved) {
                const snapshot: SecureSubmissionSnapshot = {
                    ...candidate.snapshot,
                    examId: resolvedExamId,
                };
                const migrated: SecureSubmissionOutboxRecord = {
                    schemaVersion: 2,
                    id: candidate.id,
                    ownerFingerprint: candidate.ownerFingerprint,
                    createdAt: candidate.createdAt,
                    expiresAt: candidate.expiresAt,
                    byteLength: bytes(snapshot),
                    state: candidate.state,
                    ...(candidate.blockReason ? { blockReason: candidate.blockReason } : {}),
                    retryCount: candidate.retryCount,
                    nextAttemptAt: candidate.nextAttemptAt,
                    ...(candidate.replayClaim ? { replayClaim: candidate.replayClaim } : {}),
                    ...(candidate.checkpointRevision ? { checkpointRevision: candidate.checkpointRevision } : {}),
                    recoveredFromSchemaVersion: 1,
                    snapshot,
                };
                if (!validSnapshot(snapshot) || migrated.byteLength > MAX_RECOVERED_SECURE_SUBMISSION_RECORD_BYTES) {
                    return { status: "storage_error", submitted: [], blockedCount: 0 };
                }
                const recovered = await lock(async () => {
                    const replacement = await store.replaceLegacy(candidate.id, candidate, migrated);
                    if (!replacement) return null;
                    const notices = (await store.listNotices()).map(normalizedNotice);
                    for (const notice of notices) {
                        if (notice?.kind === "legacy_recovery_required" && notice.sessionId === candidate.id) {
                            await store.deleteNotice(notice.id);
                        }
                    }
                    return replacement;
                });
                if (recovered) recoveredRecords.push(recovered);
            } else {
                const notices = (await store.listNotices()).map(normalizedNotice);
                if (!notices.some(notice => notice?.kind === "legacy_recovery_required" && notice.sessionId === candidate.id)) {
                    await store.putNotice({
                        id: randomId("legacy"),
                        kind: "legacy_recovery_required",
                        sessionId: candidate.id,
                        createdAt: new Date(now).toISOString(),
                    });
                }
            }
        }
        const owned = [...records.filter((record): record is SecureSubmissionOutboxRecord => !!record), ...recoveredRecords]
            .filter((record): record is SecureSubmissionOutboxRecord => !!record)
            .filter(record => (
                record.ownerFingerprint === ownerFingerprint
                && Date.parse(record.expiresAt) > now
                && (!options.sessionId || record.id === options.sessionId)
            ))
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        if (owned.length === 0) return { status: "empty", submitted: [] };
        const submitted: ServerGradedAttemptReceipt[] = [];
        let blockedCount = 0;
        let retryableError = false;
        let deferred = false;
        for (const candidate of owned) {
            if (candidate.state === "blocked") {
                blockedCount += 1;
                continue;
            }
            if (Date.parse(candidate.nextAttemptAt) > now) {
                deferred = true;
                continue;
            }
            const claimId = randomId("replay");
            let record = await store.claim(
                candidate.id,
                ownerFingerprint,
                claimId,
                now,
                now + REPLAY_CLAIM_MS,
            );
            if (!record) {
                deferred = true;
                continue;
            }
            const retryLater = async () => {
                retryableError = true;
                await store.commit(record!.id, claimId, {
                    kind: "retryable",
                    now,
                    random: options.random?.() ?? Math.random(),
                });
            };
            const snapshot = record.snapshot;
            let checkpoint: Awaited<ReturnType<ReplayActions["checkpoint"]>>;
            try {
                checkpoint = await actions.checkpoint({
                    sessionId: snapshot.sessionId,
                    examId: snapshot.examId,
                    assignmentId: snapshot.assignmentId,
                    assignmentRevision: snapshot.assignmentRevision,
                    expectedRevision: record.checkpointRevision || snapshot.expectedRevision,
                    expectedLeaseEpoch: snapshot.expectedLeaseEpoch,
                    leaseToken: snapshot.leaseToken,
                    answers: snapshot.answers,
                    subQuestionAnswers: snapshot.subQuestionAnswers,
                    progressPayload: snapshot.progressPayload,
                    finalCheckpoint: true,
                });
            } catch {
                await retryLater();
                continue;
            }
            if (blockedStatuses.has(checkpoint.status as SecureSubmissionBlockReason)) {
                const reason = checkpoint.status as SecureSubmissionBlockReason;
                await store.commit(record.id, claimId, { kind: "blocked", reason });
                blockedCount += 1;
                emitOutboxEvent({ sessionId: record.id, status: "blocked", reason });
                continue;
            }
            if ((checkpoint.status !== "active" && checkpoint.status !== "submitted") || !checkpoint.session) {
                await retryLater();
                continue;
            }
            const revision = checkpoint.session.revision;
            if (!validPositiveInteger(revision)) {
                await retryLater();
                continue;
            }
            if (record.checkpointRevision !== revision) {
                record = { ...record, checkpointRevision: revision };
                if (!await store.commit(record.id, claimId, { kind: "update", record })) {
                    return { status: "storage_error", submitted, blockedCount };
                }
            }
            let result: Awaited<ReturnType<ReplayActions["submit"]>>;
            try {
                result = await actions.submit({
                    sessionId: snapshot.sessionId,
                    examId: snapshot.examId,
                    assignmentId: snapshot.assignmentId,
                    assignmentRevision: snapshot.assignmentRevision,
                    expectedRevision: revision,
                    expectedLeaseEpoch: checkpoint.session.leaseEpoch || snapshot.expectedLeaseEpoch,
                    leaseToken: snapshot.leaseToken,
                    autoSubmitted: snapshot.autoSubmitted,
                    tabFociLostCount: snapshot.tabFociLostCount,
                    questionTimings: snapshot.questionTimings,
                    focusLossEvents: snapshot.focusLossEvents,
                    finishedAt: snapshot.finishedAt,
                });
            } catch {
                await retryLater();
                continue;
            }
            if (result.status === "submitted" && result.receipt) {
                if (!await store.commit(record.id, claimId, { kind: "delete" })) {
                    return { status: "storage_error", submitted, blockedCount };
                }
                submitted.push(result.receipt);
                emitOutboxEvent({ sessionId: record.id, status: "submitted", attemptId: result.receipt.attemptId });
            } else if (blockedStatuses.has(result.status as SecureSubmissionBlockReason)) {
                const reason = result.status as SecureSubmissionBlockReason;
                await store.commit(record.id, claimId, { kind: "blocked", reason });
                blockedCount += 1;
                emitOutboxEvent({ sessionId: record.id, status: "blocked", reason });
            } else {
                await retryLater();
            }
        }
        if (blockedCount > 0) return { status: "blocked", submitted, blockedCount };
        if (retryableError) return { status: "retryable_error", submitted, blockedCount: 0 };
        if (submitted.length > 0) return { status: "submitted", submitted };
        if (deferred) return { status: "deferred", submitted: [] };
        return { status: "empty", submitted: [] };
    } catch {
        return { status: "storage_error", submitted: [], blockedCount: 0 };
    }
}

export function replaySecureSubmissionsForOwner(
    ownerFingerprint: string,
    actions: ReplayActions,
    options: OutboxOptions = {},
): Promise<SecureSubmissionReplayResult> {
    const key = `${ownerFingerprint}:${options.sessionId || "*"}`;
    const existing = replayInFlight.get(key);
    if (existing) return existing;
    const replay = replaySecureSubmissionsForOwnerInternal(ownerFingerprint, actions, options)
        .finally(() => {
            if (replayInFlight.get(key) === replay) replayInFlight.delete(key);
        });
    replayInFlight.set(key, replay);
    return replay;
}

export async function retryBlockedSecureSubmission(
    sessionId: string,
    ownerFingerprint: string,
    actions: ReplayActions,
    options: OutboxOptions = {},
) {
    const store = options.store || defaultStore();
    const lock = options.lock || defaultLock();
    try {
        await lock(async () => {
            const record = (await store.list()).map(normalizedRecord).find(candidate => candidate?.id === sessionId);
            if (!record || record.ownerFingerprint !== ownerFingerprint) return;
            if (record.replayClaim && Date.parse(record.replayClaim.expiresAt) > Date.now()) return;
            await store.put({
                ...record,
                state: "queued",
                blockReason: undefined,
                retryCount: 0,
                nextAttemptAt: new Date(options.now ?? Date.now()).toISOString(),
                replayClaim: undefined,
            });
        });
    } catch {
        return { status: "storage_error" as const, submitted: [], blockedCount: 0 };
    }
    return replaySecureSubmissionsForOwner(ownerFingerprint, actions, options);
}
