import type { ServerGradedAttemptReceipt } from "@/lib/studentExamContract";
import type { SubmitAttemptInput } from "@/lib/studentExamCore";
import type { Attempt, IdentityType, QuestionResult } from "@/types/omr";
import { STUDENT_SESSION_GENERATION_KEY } from "@/utils/storage";
import {
    hasLocalServerConfirmation,
    replaceLocalAttemptWithCanonicalTransaction,
    withLocalAttemptServerConfirmationLock,
} from "@/lib/omrPersistence";
import { withBrowserStorageLock } from "@/lib/browserStorageLock";

export type SubmissionReceiptStatus = "confirmed" | "pending" | "local_only";
export type SubmissionRetryMode = "automatic" | "manual";
export type SubmissionPrerequisite = "pin" | "login" | "exam_start";

export type SubmissionReceiptReason =
    | "login_required"
    | "exam_ended"
    | "exam_archived"
    | "not_started"
    | "access_denied"
    | "not_found"
    | "service_unavailable";

export interface SubmissionReceipt {
    attemptId: string;
    status: SubmissionReceiptStatus;
    updatedAt: string;
    lastError?: string;
    reason?: SubmissionReceiptReason;
    actionDetail?: string;
    requiresPin?: boolean;
    retryMode?: SubmissionRetryMode;
    prerequisite?: SubmissionPrerequisite;
    blockedSessionGeneration?: string;
}

export interface PendingSignedSessionSubmission {
    attemptId: string;
    input: SubmitAttemptInput;
    requiresPin?: boolean;
}

type SignedSessionSubmitResponse = {
    status: string;
    attempt?: Attempt;
};

export type SubmissionRetryResult =
    | {
        status: "confirmed";
        previousAttemptId: string;
        attempt: Attempt;
        receipt: SubmissionReceipt;
    }
    | { status: "pending"; error: string; requiresPin?: boolean }
    | { status: "local_only"; receipt: SubmissionReceipt; error: string }
    | { status: "missing"; error: string };

export const SUBMISSION_RECEIPT_KEY = "omr_student_submission_receipts_v1";
export const SUBMISSION_RECEIPT_ENTRY_PREFIX = "omr_student_submission_receipt_v2:";
export const SUBMISSION_RECEIPT_REQUEST_PREFIX = "omr_student_submission_request_v2:";
export const SUBMISSION_RECEIPT_ALIAS_PREFIX = "omr_student_submission_alias_v2:";
export const SUBMISSION_RECEIPT_QUARANTINE_PREFIX = "omr_student_submission_quarantine_v2:";
export const SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY =
    "omr_student_submission_legacy_cleanup_candidate_v2";
export const SUBMISSION_RECEIPT_LEGACY_CLEANUP_GRACE_MS = 2_000;
export const SUBMISSION_RECEIPT_RECONCILED_EVENT = "omr:submission-receipt-reconciled";
const MIGRATION_MARKER_KEY = "omr_student_submission_receipts_v2_migrated";
const SANITIZED_LEGACY_REGISTRY = JSON.stringify({
    receipts: {},
    requests: {},
    reconciliations: {},
});
const CONFIRMED_RETENTION_CAP = 100;
const ALIAS_RETENTION_CAP = 100;
const QUARANTINE_RETENTION_CAP = 50;
const RETRY_ERROR = "서버에 아직 반영하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.";
const DURABILITY_ERROR = "서버 응답은 받았지만 확인 상태를 저장하지 못했습니다. 자동 재시도를 유지합니다.";
const PIN_REQUIRED_ERROR = "시험 PIN을 다시 입력해야 서버 반영을 시도할 수 있습니다.";
const LOGIN_REQUIRED_ERROR = "학생 계정으로 다시 로그인하면 서버 반영을 자동으로 다시 시도합니다.";
const NOT_STARTED_ERROR = "온라인 전환 또는 화면 복귀 시 다시 시도합니다.";
const MISSING_SESSION_GENERATION = "__missing__";
const retryInFlight = new Map<string, Promise<SubmissionRetryResult>>();
let quarantineSequence = 0;

export function isSubmissionReceiptStorageKey(key: string | null): boolean {
    return key === SUBMISSION_RECEIPT_KEY
        || !!key?.startsWith(SUBMISSION_RECEIPT_ENTRY_PREFIX)
        || !!key?.startsWith(SUBMISSION_RECEIPT_REQUEST_PREFIX)
        || !!key?.startsWith(SUBMISSION_RECEIPT_ALIAS_PREFIX);
}

export interface SubmissionReceiptReconciledDetail {
    previousAttemptId: string;
    attempt: Attempt;
    receipt: SubmissionReceipt;
}

declare global {
    interface WindowEventMap {
        [SUBMISSION_RECEIPT_RECONCILED_EVENT]: CustomEvent<SubmissionReceiptReconciledDetail>;
    }
}

interface ReceiptEnvelope {
    version: 2;
    revision: number;
    receipt: SubmissionReceipt;
}

interface RequestEnvelope {
    version: 2;
    revision: number;
    request: PendingSignedSessionSubmission;
}

interface AliasEnvelope {
    version: 2;
    previousAttemptId: string;
    canonicalAttemptId: string;
    updatedAt: string;
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

function isReceiptReason(value: unknown): value is SubmissionReceiptReason {
    return value === "login_required"
        || value === "exam_ended"
        || value === "exam_archived"
        || value === "not_started"
        || value === "access_denied"
        || value === "not_found"
        || value === "service_unavailable";
}

function encodedKey(prefix: string, attemptId: string): string {
    return `${prefix}${encodeURIComponent(attemptId)}`;
}

function receiptKey(attemptId: string): string {
    return encodedKey(SUBMISSION_RECEIPT_ENTRY_PREFIX, attemptId);
}

function requestKey(attemptId: string): string {
    return encodedKey(SUBMISSION_RECEIPT_REQUEST_PREFIX, attemptId);
}

function aliasKey(attemptId: string): string {
    return encodedKey(SUBMISSION_RECEIPT_ALIAS_PREFIX, attemptId);
}

function attemptIdFromKey(key: string, prefix: string): string | null {
    if (!key.startsWith(prefix)) return null;
    try {
        return decodeURIComponent(key.slice(prefix.length));
    } catch {
        return null;
    }
}

function storageKeys(storage: Storage, prefix: string): string[] {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) keys.push(key);
    }
    return keys;
}

function pruneQuarantineMetadata(storage: Storage): void {
    const quarantined = storageKeys(storage, SUBMISSION_RECEIPT_QUARANTINE_PREFIX)
        .map(key => {
            const raw = storage.getItem(key);
            let at = 0;
            if (raw) {
                try {
                    const parsed = JSON.parse(raw) as { quarantinedAt?: unknown };
                    if (typeof parsed.quarantinedAt === "string") {
                        at = Date.parse(parsed.quarantinedAt) || 0;
                    }
                } catch {}
            }
            const sequence = Number(key.slice(key.lastIndexOf(":") + 1)) || 0;
            return { key, at, sequence };
        })
        .sort((a, b) => b.at - a.at || b.sequence - a.sequence || b.key.localeCompare(a.key));
    quarantined.slice(QUARANTINE_RETENTION_CAP).forEach(({ key }) => {
        try { storage.removeItem(key); } catch {}
    });
}

function writeQuarantineMetadata(storage: Storage, key: string, raw: string): void {
    const sourceKind = key === SUBMISSION_RECEIPT_KEY
        ? "legacy"
        : key.startsWith(SUBMISSION_RECEIPT_ENTRY_PREFIX)
            ? "receipt"
            : key.startsWith(SUBMISSION_RECEIPT_REQUEST_PREFIX)
                ? "request"
                : key.startsWith(SUBMISSION_RECEIPT_ALIAS_PREFIX)
                    ? "alias"
                    : "unknown";
    quarantineSequence += 1;
    const quarantineKey = `${SUBMISSION_RECEIPT_QUARANTINE_PREFIX}${Date.now()}:${quarantineSequence}`;
    try {
        storage.setItem(quarantineKey, JSON.stringify({
            version: 1,
            sourceKind,
            errorCategory: "invalid_json_or_schema",
            byteLength: raw.length,
            quarantinedAt: new Date().toISOString(),
        }));
        pruneQuarantineMetadata(storage);
    } catch {
        // Metadata is best-effort. Corrupt submission data may contain a PIN,
        // so it is never copied into quarantine.
    }
}

function quarantineCorruptValue(storage: Storage, key: string, raw: string): void {
    writeQuarantineMetadata(storage, key, raw);
    try {
        storage.removeItem(key);
    } catch {
        // A blocked storage implementation can prevent cleanup, but quarantine
        // itself still never receives the sensitive raw value.
    }
}

function isRetryMode(value: unknown): value is SubmissionRetryMode {
    return value === "automatic" || value === "manual";
}

function isSubmissionPrerequisite(value: unknown): value is SubmissionPrerequisite {
    return value === "pin" || value === "login" || value === "exam_start";
}

function sanitizeReceipt(id: string, value: unknown): SubmissionReceipt | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const receipt = value as Partial<SubmissionReceipt>;
    if (receipt.attemptId !== id || !isReceiptStatus(receipt.status) || typeof receipt.updatedAt !== "string") {
        return null;
    }
    return {
        attemptId: id,
        status: receipt.status,
        updatedAt: receipt.updatedAt,
        ...(typeof receipt.lastError === "string" ? { lastError: receipt.lastError } : {}),
        ...(isReceiptReason(receipt.reason) ? { reason: receipt.reason } : {}),
        ...(typeof receipt.actionDetail === "string" ? { actionDetail: receipt.actionDetail } : {}),
        ...(receipt.requiresPin === true ? { requiresPin: true } : {}),
        ...(isRetryMode(receipt.retryMode) ? { retryMode: receipt.retryMode } : {}),
        ...(isSubmissionPrerequisite(receipt.prerequisite) ? { prerequisite: receipt.prerequisite } : {}),
        ...(typeof receipt.blockedSessionGeneration === "string"
            ? { blockedSessionGeneration: receipt.blockedSessionGeneration }
            : {}),
    };
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
        && (request.requiresPin === undefined || request.requiresPin === true);
}

function parseReceiptEnvelope(
    storage: Storage,
    id: string,
    options: { quarantine?: boolean } = {},
): ReceiptEnvelope | null {
    const key = receiptKey(id);
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<ReceiptEnvelope>;
        const receipt = sanitizeReceipt(id, parsed.receipt);
        if (parsed.version !== 2 || !Number.isInteger(parsed.revision) || !receipt) throw new Error("invalid");
        return { version: 2, revision: parsed.revision!, receipt };
    } catch {
        if (options.quarantine !== false) quarantineCorruptValue(storage, key, raw);
        return null;
    }
}

function parseRequestEnvelope(
    storage: Storage,
    id: string,
    options: { quarantine?: boolean } = {},
): RequestEnvelope | null {
    const key = requestKey(id);
    const raw = storage.getItem(key);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<RequestEnvelope>;
        if (parsed.version !== 2 || !Number.isInteger(parsed.revision) || !isPendingSubmissionRequest(id, parsed.request)) {
            throw new Error("invalid");
        }
        const request = parsed.request as PendingSignedSessionSubmission;
        return {
            version: 2,
            revision: parsed.revision!,
            request: {
                attemptId: id,
                input: request.input,
                ...(request.requiresPin ? { requiresPin: true } : {}),
            },
        };
    } catch {
        if (options.quarantine !== false) quarantineCorruptValue(storage, key, raw);
        return null;
    }
}

function v2SupersedesPending(
    storage: Storage,
    id: string,
    options: { quarantine?: boolean } = {},
): boolean {
    if (storage.getItem(aliasKey(id)) !== null) return true;
    if (storage.getItem(receiptKey(id)) === null) return false;
    const envelope = parseReceiptEnvelope(storage, id, options);
    // A corrupt receipt is not terminal evidence. Quarantine it and preserve
    // the idempotent request so awaited maintenance can rebuild pending state.
    if (!envelope) return false;
    const status = envelope.receipt.status;
    return status === "confirmed" || status === "local_only";
}

function writeReceiptEnvelope(storage: Storage, receipt: SubmissionReceipt): void {
    const current = parseReceiptEnvelope(storage, receipt.attemptId);
    const envelope: ReceiptEnvelope = {
        version: 2,
        revision: (current?.revision || 0) + 1,
        receipt,
    };
    storage.setItem(receiptKey(receipt.attemptId), JSON.stringify(envelope));
}

function writeRequestEnvelope(storage: Storage, request: PendingSignedSessionSubmission): void {
    const current = parseRequestEnvelope(storage, request.attemptId);
    const envelope: RequestEnvelope = {
        version: 2,
        revision: (current?.revision || 0) + 1,
        request: {
            attemptId: request.attemptId,
            input: request.input,
            ...(request.requiresPin ? { requiresPin: true } : {}),
        },
    };
    storage.setItem(requestKey(request.attemptId), JSON.stringify(envelope));
}

function writeAliasEnvelope(storage: Storage, previousAttemptId: string, canonicalAttemptId: string): void {
    const envelope: AliasEnvelope = {
        version: 2,
        previousAttemptId,
        canonicalAttemptId,
        updatedAt: new Date().toISOString(),
    };
    storage.setItem(aliasKey(previousAttemptId), JSON.stringify(envelope));
}

interface LegacyRegistry {
    receipts?: Record<string, unknown>;
    requests?: Record<string, unknown>;
    reconciliations?: Record<string, unknown>;
}

interface LegacyCleanupCandidate {
    version: 1;
    fingerprint: string;
    firstSeenAt: number;
    generation: number;
}

function readLegacyCleanupCandidate(
    storage: Storage,
    options: { removeInvalid?: boolean } = {},
): LegacyCleanupCandidate | null {
    const raw = storage.getItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY);
    if (!raw) return null;
    try {
        const candidate = JSON.parse(raw) as Partial<LegacyCleanupCandidate>;
        if (
            candidate.version !== 1
            || typeof candidate.fingerprint !== "string"
            || !/^[a-f0-9]{64}$/.test(candidate.fingerprint)
            || typeof candidate.firstSeenAt !== "number"
            || !Number.isFinite(candidate.firstSeenAt)
            || !Number.isInteger(candidate.generation)
            || candidate.generation! < 1
        ) {
            throw new Error("invalid");
        }
        return candidate as LegacyCleanupCandidate;
    } catch {
        if (options.removeInvalid) {
            try { storage.removeItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY); } catch {}
        }
        return null;
    }
}

function readLegacyOverlayRegistry(storage: Storage): LegacyRegistry | undefined {
    // Once a fingerprint candidate exists, that exact generation has already
    // been copied to v2. Old-tab changes become visible after the next awaited
    // maintenance pass resets the candidate and migrates the new generation.
    if (storage.getItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY) !== null) {
        return undefined;
    }
    return parseLegacyRegistry(storage, { quarantine: false })?.registry;
}

async function legacyRawFingerprint(raw: string): Promise<string | null> {
    try {
        if (!globalThis.crypto?.subtle) return null;
        const bytes = new TextEncoder().encode(raw);
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        return [...new Uint8Array(digest)]
            .map(value => value.toString(16).padStart(2, "0"))
            .join("");
    } catch {
        return null;
    }
}

function parseLegacyRegistry(
    storage: Storage,
    options: { quarantine?: boolean } = {},
): { raw: string; registry: LegacyRegistry } | null {
    const raw = storage.getItem(SUBMISSION_RECEIPT_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
        return { raw, registry: parsed as LegacyRegistry };
    } catch {
        if (options.quarantine !== false) {
            quarantineCorruptValue(storage, SUBMISSION_RECEIPT_KEY, raw);
        }
        return null;
    }
}

async function migrateLegacyRegistryUnlocked(
    storage: Storage,
    options: { now?: number; cleanupGraceMs?: number } = {},
): Promise<boolean> {
    const now = options.now ?? Date.now();
    const cleanupGraceMs = Math.max(0, options.cleanupGraceMs ?? SUBMISSION_RECEIPT_LEGACY_CLEANUP_GRACE_MS);
    const raw = storage.getItem(SUBMISSION_RECEIPT_KEY);
    if (!raw || raw === SANITIZED_LEGACY_REGISTRY) {
        maintainV2Registry(storage);
        try { storage.removeItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY); } catch {}
        try { storage.setItem(MIGRATION_MARKER_KEY, "1"); } catch {}
        return true;
    }
    const fingerprint = await legacyRawFingerprint(raw);
    if (!fingerprint) return false;
    const previousCandidate = readLegacyCleanupCandidate(storage, { removeInvalid: true });
    const parsed = parseLegacyRegistry(storage, { quarantine: false });
    const legacy = parsed?.raw === raw ? parsed : null;
    if (!legacy && previousCandidate?.fingerprint !== fingerprint) {
        writeQuarantineMetadata(storage, SUBMISSION_RECEIPT_KEY, raw);
    }
    try {
        for (const [id, value] of Object.entries(legacy?.registry.receipts || {})) {
            const receipt = sanitizeReceipt(id, value);
            if (
                receipt
                && !storage.getItem(receiptKey(id))
                && !storage.getItem(aliasKey(id))
            ) {
                writeReceiptEnvelope(storage, receipt);
            }
        }
        for (const [id, value] of Object.entries(legacy?.registry.requests || {})) {
            if (!isPendingSubmissionRequest(id, value)) continue;
            if (v2SupersedesPending(storage, id)) {
                storage.removeItem(requestKey(id));
                continue;
            }
            const legacy = value as PendingSignedSessionSubmission & { pin?: unknown };
            if (!storage.getItem(requestKey(id))) {
                writeRequestEnvelope(storage, {
                    attemptId: id,
                    input: legacy.input,
                    ...((legacy.requiresPin || typeof legacy.pin === "string") ? { requiresPin: true } : {}),
                });
            }
        }
        for (const [previousId, canonicalId] of Object.entries(legacy?.registry.reconciliations || {})) {
            if (
                previousId
                && typeof canonicalId === "string"
                && canonicalId
                && canonicalId !== previousId
                && !storage.getItem(aliasKey(previousId))
            ) {
                writeAliasEnvelope(storage, previousId, canonicalId);
            }
        }
        // Legacy confirmed receipts may predate durable local provenance.
        // Keep a bounded recovery window while all newly written confirmed
        // receipts are required to have a matching server-confirmed attempt.
        maintainV2Registry(storage);
        // A legacy writer is outside this lock protocol. If it writes while the
        // snapshot is copied, discard the cleanup generation. The next awaited
        // pass migrates the new raw and starts a fresh grace interval.
        if (storage.getItem(SUBMISSION_RECEIPT_KEY) !== raw) {
            storage.removeItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY);
            return false;
        }
        const candidate: LegacyCleanupCandidate = previousCandidate?.fingerprint === fingerprint
            ? {
                ...previousCandidate,
                generation: previousCandidate.generation + 1,
            }
            : {
                version: 1,
                fingerprint,
                firstSeenAt: now,
                generation: 1,
            };
        storage.setItem(
            SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY,
            JSON.stringify(candidate),
        );
        if (
            candidate.generation >= 2
            && now - candidate.firstSeenAt >= cleanupGraceMs
        ) {
            const finalRaw = storage.getItem(SUBMISSION_RECEIPT_KEY);
            if (!finalRaw || await legacyRawFingerprint(finalRaw) !== fingerprint) {
                storage.removeItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY);
                return false;
            }
            if (storage.getItem(SUBMISSION_RECEIPT_KEY) !== finalRaw) {
                storage.removeItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY);
                return false;
            }
            // This final in-lock check narrows, but cannot eliminate, the
            // unavoidable limitation of an old writer that ignores this lock.
            storage.setItem(SUBMISSION_RECEIPT_KEY, SANITIZED_LEGACY_REGISTRY);
            storage.removeItem(SUBMISSION_RECEIPT_LEGACY_CLEANUP_CANDIDATE_KEY);
        }
        storage.setItem(MIGRATION_MARKER_KEY, "1");
        return true;
    } catch {
        // A quota or blocked write is not corruption. Keep the legacy registry
        // and leave the marker unset so a later awaited writer can finish.
        return false;
    }
}

export async function migrateLegacySubmissionReceipts(
    options: { now?: number; cleanupGraceMs?: number } = {},
): Promise<boolean> {
    const storage = browserStorage();
    if (!storage) return false;
    return withBrowserStorageLock(
        "submission-receipts",
        () => migrateLegacyRegistryUnlocked(storage, options),
    );
}

export function legacySubmissionReceiptCleanupDelayMs(
    now = Date.now(),
    cleanupGraceMs = SUBMISSION_RECEIPT_LEGACY_CLEANUP_GRACE_MS,
): number | null {
    const storage = browserStorage();
    if (!storage) return null;
    const raw = storage.getItem(SUBMISSION_RECEIPT_KEY);
    if (!raw || raw === SANITIZED_LEGACY_REGISTRY) return null;
    const candidate = readLegacyCleanupCandidate(storage);
    if (!candidate) return null;
    return Math.max(0, candidate.firstSeenAt + Math.max(0, cleanupGraceMs) - now);
}

function pruneRetainedRecords(storage: Storage): void {
    const confirmed = storageKeys(storage, SUBMISSION_RECEIPT_ENTRY_PREFIX)
        .flatMap(key => {
            const id = attemptIdFromKey(key, SUBMISSION_RECEIPT_ENTRY_PREFIX);
            if (!id) return [];
            const envelope = parseReceiptEnvelope(storage, id);
            return envelope?.receipt.status === "confirmed"
                ? [{ key, id, at: Date.parse(envelope.receipt.updatedAt) || 0 }]
                : [];
        })
        .sort((a, b) => b.at - a.at);
    confirmed.slice(CONFIRMED_RETENTION_CAP).forEach(({ key }) => {
        try { storage.removeItem(key); } catch {}
    });

    const aliases = storageKeys(storage, SUBMISSION_RECEIPT_ALIAS_PREFIX)
        .flatMap(key => {
            const raw = storage.getItem(key);
            if (!raw) return [];
            try {
                const parsed = JSON.parse(raw) as Partial<AliasEnvelope>;
                if (
                    parsed.version !== 2
                    || typeof parsed.previousAttemptId !== "string"
                    || typeof parsed.canonicalAttemptId !== "string"
                    || typeof parsed.updatedAt !== "string"
                ) {
                    throw new Error("invalid");
                }
                return [{ key, at: Date.parse(parsed.updatedAt) || 0 }];
            } catch {
                quarantineCorruptValue(storage, key, raw);
                return [];
            }
        })
        .sort((a, b) => b.at - a.at);
    aliases.slice(ALIAS_RETENTION_CAP).forEach(({ key }) => {
        try { storage.removeItem(key); } catch {}
    });
}

function maintainV2Registry(storage: Storage): void {
    pruneRetainedRecords(storage);
    storageKeys(storage, SUBMISSION_RECEIPT_REQUEST_PREFIX).forEach(key => {
        const id = attemptIdFromKey(key, SUBMISSION_RECEIPT_REQUEST_PREFIX);
        if (!id) return;
        const request = parseRequestEnvelope(storage, id);
        const receipt = parseReceiptEnvelope(storage, id);
        if (!request) return;
        if (
            storage.getItem(aliasKey(id)) !== null
            || receipt?.receipt.status === "confirmed"
            || receipt?.receipt.status === "local_only"
        ) {
            try { storage.removeItem(key); } catch {}
            return;
        }
        if (!receipt) {
            writeReceiptEnvelope(storage, {
                attemptId: id,
                status: "pending",
                updatedAt: new Date().toISOString(),
                ...(request.request.requiresPin ? {
                    requiresPin: true,
                    retryMode: "manual" as const,
                    prerequisite: "pin" as const,
                } : {
                    retryMode: "automatic" as const,
                }),
            });
        }
    });
}

export function submissionReceiptLabel(
    receipt: Pick<SubmissionReceipt, "status" | "retryMode" | "prerequisite" | "requiresPin">,
): string {
    if (receipt.status === "confirmed") return "서버 반영 완료";
    if (receipt.status === "pending") {
        if (receipt.requiresPin || receipt.prerequisite === "pin") return "서버 반영 대기 · PIN 입력 필요";
        if (receipt.prerequisite === "login") return "서버 반영 대기 · 로그인 필요";
        if (receipt.prerequisite === "exam_start") return "서버 반영 대기 · 시험 시작 전";
        return "서버 반영 대기 · 자동 재시도";
    }
    return "이 기기에만 저장됨";
}

export function submissionReceiptForAttempt(
    attempt: Attempt,
    storedReceipt: SubmissionReceipt | null,
    source: "server" | "local",
): SubmissionReceipt {
    if (source === "server" || attempt.localSubmissionProvenance?.source === "server") {
        return {
            attemptId: attempt.id,
            status: "confirmed",
            updatedAt: attempt.localSubmissionProvenance?.confirmedAt || new Date().toISOString(),
        };
    }
    return storedReceipt || {
        attemptId: attempt.id,
        status: "local_only",
        updatedAt: new Date().toISOString(),
    };
}

async function persistSubmissionReceiptUnlocked(
    receipt: SubmissionReceipt,
    provenanceAttached = false,
): Promise<boolean> {
    const storage = browserStorage();
    if (!storage) return false;
    await migrateLegacyRegistryUnlocked(storage);
    const current = parseReceiptEnvelope(storage, receipt.attemptId)?.receipt;
    if (current?.status === "confirmed" && receipt.status === "pending") return false;
    if (receipt.status === "pending" && storage.getItem(aliasKey(receipt.attemptId))) return false;
    try {
        if (receipt.status === "confirmed") {
            if (
                !provenanceAttached
                && !hasLocalServerConfirmation(receipt.attemptId)
            ) {
                return false;
            }
        }
        writeReceiptEnvelope(storage, receipt);
        if (receipt.status !== "pending") storage.removeItem(requestKey(receipt.attemptId));
        pruneRetainedRecords(storage);
        return true;
    } catch {
        return false;
    }
}

export async function persistSubmissionReceipt(receipt: SubmissionReceipt): Promise<boolean> {
    if (receipt.status !== "confirmed") {
        return withBrowserStorageLock(
            "submission-receipts",
            () => persistSubmissionReceiptUnlocked(receipt),
        );
    }
    return withLocalAttemptServerConfirmationLock(receipt.attemptId, receipt.updatedAt, async attached => {
        const provenanceAttached = attached || hasLocalServerConfirmation(receipt.attemptId);
        if (!provenanceAttached) return false;
        return withBrowserStorageLock(
            "submission-receipts",
            () => persistSubmissionReceiptUnlocked(receipt, true),
        );
    });
}

export function readSubmissionReceipt(attemptId: string): SubmissionReceipt | null {
    const storage = browserStorage();
    if (!storage) return null;
    if (storage.getItem(receiptKey(attemptId)) !== null) {
        return parseReceiptEnvelope(storage, attemptId, { quarantine: false })?.receipt || null;
    }
    if (storage.getItem(aliasKey(attemptId)) !== null) return null;
    const legacy = readLegacyOverlayRegistry(storage);
    return sanitizeReceipt(attemptId, legacy?.receipts?.[attemptId]) || null;
}

export function readReconciledSubmissionAttemptId(attemptId: string): string | null {
    const storage = browserStorage();
    if (!storage) return null;
    const legacy = readLegacyOverlayRegistry(storage);
    let current = attemptId;
    const visited = new Set<string>();
    while (!visited.has(current)) {
        visited.add(current);
        const key = aliasKey(current);
        const raw = storage.getItem(key);
        if (raw !== null) {
            try {
                const parsed = JSON.parse(raw) as Partial<AliasEnvelope>;
                if (
                    parsed.version !== 2
                    || parsed.previousAttemptId !== current
                    || typeof parsed.canonicalAttemptId !== "string"
                    || !parsed.canonicalAttemptId
                ) {
                    throw new Error("invalid");
                }
                current = parsed.canonicalAttemptId;
                continue;
            } catch {
                break;
            }
        }
        const legacyCanonicalId = legacy?.reconciliations?.[current];
        if (
            typeof legacyCanonicalId !== "string"
            || !legacyCanonicalId
            || legacyCanonicalId === current
        ) break;
        current = legacyCanonicalId;
    }
    return current !== attemptId ? current : null;
}

async function queuePendingSubmissionReceiptUnlocked(
    request: PendingSignedSessionSubmission,
    updatedAt = new Date().toISOString(),
): Promise<boolean> {
    const storage = browserStorage();
    if (!storage) return false;
    await migrateLegacyRegistryUnlocked(storage);
    if (parseReceiptEnvelope(storage, request.attemptId)?.receipt.status === "confirmed") return false;
    if (storage.getItem(aliasKey(request.attemptId))) return false;
    const receipt: SubmissionReceipt = {
        attemptId: request.attemptId,
        status: "pending",
        updatedAt,
        ...(request.requiresPin ? {
            requiresPin: true,
            retryMode: "manual" as const,
            prerequisite: "pin" as const,
        } : {}),
    };
    const requestStorageKey = requestKey(request.attemptId);
    const receiptStorageKey = receiptKey(request.attemptId);
    const previousRequest = storage.getItem(requestStorageKey);
    const previousReceipt = storage.getItem(receiptStorageKey);
    try {
        writeRequestEnvelope(storage, request);
        writeReceiptEnvelope(storage, receipt);
        return true;
    } catch {
        try {
            if (previousRequest === null) storage.removeItem(requestStorageKey);
            else storage.setItem(requestStorageKey, previousRequest);
            if (previousReceipt === null) storage.removeItem(receiptStorageKey);
            else storage.setItem(receiptStorageKey, previousReceipt);
        } catch {}
        return false;
    }
}

export async function queuePendingSubmissionReceipt(
    request: PendingSignedSessionSubmission,
    updatedAt = new Date().toISOString(),
): Promise<boolean> {
    return withBrowserStorageLock(
        "submission-receipts",
        () => queuePendingSubmissionReceiptUnlocked(request, updatedAt),
    );
}

export function pendingSubmissionReceiptIds(options: { automaticOnly?: boolean } = {}): string[] {
    const storage = browserStorage();
    if (!storage) return [];
    const legacy = readLegacyOverlayRegistry(storage);
    const ids = new Set(
        storageKeys(storage, SUBMISSION_RECEIPT_REQUEST_PREFIX)
            .flatMap(key => attemptIdFromKey(key, SUBMISSION_RECEIPT_REQUEST_PREFIX) || []),
    );
    Object.keys(legacy?.requests || {}).forEach(id => ids.add(id));
    return [...ids].flatMap(id => {
        if (v2SupersedesPending(storage, id, { quarantine: false })) return [];
        const request = storage.getItem(requestKey(id)) !== null
            ? parseRequestEnvelope(storage, id, { quarantine: false })?.request
            : isPendingSubmissionRequest(id, legacy?.requests?.[id])
                ? legacy?.requests?.[id] as PendingSignedSessionSubmission
                : undefined;
        const receipt = storage.getItem(receiptKey(id)) !== null
            ? parseReceiptEnvelope(storage, id, { quarantine: false })?.receipt
            : sanitizeReceipt(id, legacy?.receipts?.[id]);
        if (!request || receipt?.status !== "pending") return [];
        if (options.automaticOnly) {
            if (request.requiresPin || receipt.requiresPin || receipt.prerequisite === "pin") return [];
            if (receipt.retryMode === "manual") {
                const currentSessionGeneration = readStudentSessionGeneration();
                const restoredLogin = receipt.prerequisite === "login"
                    && !!receipt.blockedSessionGeneration
                    && !!currentSessionGeneration
                    && currentSessionGeneration !== receipt.blockedSessionGeneration;
                if (!restoredLogin) return [];
            }
        }
        return [id];
    });
}

function readStudentSessionGeneration(): string | null {
    if (typeof window === "undefined") return null;
    try {
        return window.sessionStorage?.getItem(STUDENT_SESSION_GENERATION_KEY) || null;
    } catch {
        return null;
    }
}

function isBlockedOnCurrentStudentSession(receipt: SubmissionReceipt): boolean {
    if (receipt.prerequisite !== "login" || !receipt.blockedSessionGeneration) return false;
    const current = readStudentSessionGeneration();
    return receipt.blockedSessionGeneration === MISSING_SESSION_GENERATION
        ? !current
        : current === receipt.blockedSessionGeneration;
}

async function withAttemptMutationLock<T>(attemptId: string, operation: () => Promise<T>): Promise<T> {
    return withBrowserStorageLock(`submission:${attemptId}`, operation);
}

function permanentOutcome(status: string): { reason: SubmissionReceiptReason; actionDetail: string } | null {
    if (status === "ended") {
        return { reason: "exam_ended", actionDetail: "시험 제출 가능 시간을 확인하고 선생님에게 문의해주세요." };
    }
    if (status === "archived") {
        return { reason: "exam_archived", actionDetail: "보관된 시험입니다. 선생님에게 시험 재개를 요청해주세요." };
    }
    if (status === "group_denied" || status === "denied" || status === "invalid_submission") {
        return { reason: "access_denied", actionDetail: "현재 계정에는 제출 권한이 없습니다. 선생님에게 문의해주세요." };
    }
    if (status === "not_found" || status === "misconfigured" || status === "local_only") {
        return { reason: "not_found", actionDetail: "서버에서 시험을 찾지 못했습니다. 시험을 다시 열거나 선생님에게 문의해주세요." };
    }
    return null;
}

function restoreKeys(storage: Storage, snapshots: Map<string, string | null>): void {
    for (const [key, value] of snapshots) {
        try {
            if (value === null) storage.removeItem(key);
            else storage.setItem(key, value);
        } catch {}
    }
}

async function persistConfirmedReconciliationUnderAttemptLock(
    storage: Storage,
    previousAttemptId: string,
    canonicalAttemptId: string,
    receipt: SubmissionReceipt,
): Promise<boolean> {
    if (!hasLocalServerConfirmation(canonicalAttemptId)) return false;
    return withBrowserStorageLock("submission-receipts", () => {
        const keys = [
            receiptKey(previousAttemptId),
            requestKey(previousAttemptId),
            receiptKey(canonicalAttemptId),
            requestKey(canonicalAttemptId),
            aliasKey(previousAttemptId),
        ];
        const snapshots = new Map(keys.map(key => [key, storage.getItem(key)]));
        try {
            writeReceiptEnvelope(storage, receipt);
            if (previousAttemptId !== canonicalAttemptId) {
                writeAliasEnvelope(storage, previousAttemptId, canonicalAttemptId);
                storage.removeItem(receiptKey(previousAttemptId));
            }
            storage.removeItem(requestKey(previousAttemptId));
            storage.removeItem(requestKey(canonicalAttemptId));
            pruneRetainedRecords(storage);
            return true;
        } catch {
            restoreKeys(storage, snapshots);
            return false;
        }
    });
}

export function retryPendingSubmissionReceipt(
    attemptId: string,
    deps: {
        submitSignedSessionAttempt: (
            input: SubmitAttemptInput,
            pin?: string,
        ) => Promise<SignedSessionSubmitResponse>;
        pin?: string;
    },
): Promise<SubmissionRetryResult> {
    const existing = retryInFlight.get(attemptId);
    if (existing) return existing;

    const retry = withAttemptMutationLock(attemptId, async (): Promise<SubmissionRetryResult> => {
        const storage = browserStorage();
        if (!storage) return { status: "missing", error: "브라우저 저장소를 사용할 수 없습니다." };
        await withBrowserStorageLock(
            "submission-receipts",
            () => migrateLegacyRegistryUnlocked(storage),
        );
        const request = parseRequestEnvelope(storage, attemptId)?.request;
        if (!request) {
            return { status: "missing", error: "다시 시도할 제출 요청을 찾지 못했습니다." };
        }
        const currentReceipt = parseReceiptEnvelope(storage, attemptId)?.receipt;
        if (currentReceipt && isBlockedOnCurrentStudentSession(currentReceipt)) {
            return { status: "pending", error: LOGIN_REQUIRED_ERROR };
        }
        if (request.requiresPin && !deps.pin) {
            return { status: "pending", error: PIN_REQUIRED_ERROR, requiresPin: true };
        }
        let result: SignedSessionSubmitResponse;
        try {
            result = await deps.submitSignedSessionAttempt(request.input, deps.pin);
        } catch {
            // Keep the exact same idempotent request queued.
            result = { status: "error" };
        }
        if (result.status === "ok" && result.attempt) {
            const canonicalAttemptId = result.attempt.id;
            const receipt: SubmissionReceipt = {
                attemptId: canonicalAttemptId,
                status: "confirmed",
                updatedAt: new Date().toISOString(),
            };
            const cacheTransaction = await replaceLocalAttemptWithCanonicalTransaction(
                attemptId,
                result.attempt,
                () => persistConfirmedReconciliationUnderAttemptLock(
                    storage,
                    attemptId,
                    canonicalAttemptId,
                    receipt,
                ),
            );
            if (!cacheTransaction.committed) {
                return { status: "pending", error: DURABILITY_ERROR };
            }
            const cachedAttempt = cacheTransaction.attempt || result.attempt;
            emitSubmissionReceiptReconciled({
                previousAttemptId: attemptId,
                attempt: cachedAttempt,
                receipt,
            });
            return {
                status: "confirmed",
                previousAttemptId: attemptId,
                attempt: cachedAttempt,
                receipt,
            };
        }
        if (result.status === "pin_required" || result.status === "pin_rate_limited") {
            const pinReceipt: SubmissionReceipt = {
                attemptId,
                status: "pending",
                updatedAt: new Date().toISOString(),
                lastError: PIN_REQUIRED_ERROR,
                requiresPin: true,
                retryMode: "manual",
                prerequisite: "pin",
            };
            const persisted = await queuePendingSubmissionReceipt({
                ...request,
                requiresPin: true,
            }, pinReceipt.updatedAt);
            if (!persisted) return { status: "pending", error: DURABILITY_ERROR, requiresPin: true };
            return { status: "pending", error: PIN_REQUIRED_ERROR, requiresPin: true };
        }
        if (result.status === "unauthenticated" || result.status === "login_required") {
            const pendingReceipt: SubmissionReceipt = {
                attemptId,
                status: "pending",
                updatedAt: new Date().toISOString(),
                lastError: LOGIN_REQUIRED_ERROR,
                reason: "login_required",
                actionDetail: LOGIN_REQUIRED_ERROR,
                retryMode: "manual",
                prerequisite: "login",
                blockedSessionGeneration: readStudentSessionGeneration() || MISSING_SESSION_GENERATION,
            };
            if (!await persistSubmissionReceipt(pendingReceipt)) {
                return { status: "pending", error: DURABILITY_ERROR };
            }
            return { status: "pending", error: LOGIN_REQUIRED_ERROR };
        }
        if (result.status === "not_started") {
            const pendingReceipt: SubmissionReceipt = {
                attemptId,
                status: "pending",
                updatedAt: new Date().toISOString(),
                lastError: NOT_STARTED_ERROR,
                reason: "not_started",
                actionDetail: NOT_STARTED_ERROR,
                retryMode: "automatic",
                prerequisite: "exam_start",
            };
            if (!await persistSubmissionReceipt(pendingReceipt)) {
                return { status: "pending", error: DURABILITY_ERROR };
            }
            return { status: "pending", error: NOT_STARTED_ERROR };
        }
        const permanent = permanentOutcome(result.status);
        if (permanent) {
            const receipt: SubmissionReceipt = {
                attemptId,
                status: "local_only",
                updatedAt: new Date().toISOString(),
                reason: permanent.reason,
                actionDetail: permanent.actionDetail,
            };
            if (!await persistSubmissionReceipt(receipt)) {
                return { status: "pending", error: DURABILITY_ERROR };
            }
            return { status: "local_only", receipt, error: permanent.actionDetail };
        }
        const pendingReceipt: SubmissionReceipt = {
            attemptId,
            status: "pending",
            updatedAt: new Date().toISOString(),
            lastError: RETRY_ERROR,
            ...(request.requiresPin ? {
                requiresPin: true,
                retryMode: "manual" as const,
                prerequisite: "pin" as const,
            } : {}),
        };
        if (!await persistSubmissionReceipt(pendingReceipt)) {
            return { status: "pending", error: DURABILITY_ERROR };
        }
        return { status: "pending", error: RETRY_ERROR };
    }).catch((): SubmissionRetryResult => ({
        status: "pending",
        error: RETRY_ERROR,
    })).finally(() => {
        retryInFlight.delete(attemptId);
    });
    retryInFlight.set(attemptId, retry);
    return retry;
}

function emitSubmissionReceiptReconciled(detail: SubmissionReceiptReconciledDetail): void {
    if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
    const event = typeof CustomEvent === "function"
        ? new CustomEvent<SubmissionReceiptReconciledDetail>(
            SUBMISSION_RECEIPT_RECONCILED_EVENT,
            { detail },
        )
        : { type: SUBMISSION_RECEIPT_RECONCILED_EVENT, detail } as CustomEvent<SubmissionReceiptReconciledDetail>;
    try {
        window.dispatchEvent(event);
    } catch {
        // The durable receipt and cache are already committed. A mounted view
        // can still reconcile through the storage event or its next load.
    }
}

export async function flushPendingSubmissionReceipts(
    deps: Parameters<typeof retryPendingSubmissionReceipt>[1],
): Promise<number> {
    const ids = pendingSubmissionReceiptIds({ automaticOnly: true });
    await Promise.all(ids.map(id => retryPendingSubmissionReceipt(id, deps)));
    return pendingSubmissionReceiptIds({ automaticOnly: true }).length;
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
            assignmentId: receipt.assignmentId,
            assignmentRevision: receipt.assignmentRevision,
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
