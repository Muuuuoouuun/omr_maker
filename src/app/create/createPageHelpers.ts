import type { StoredDataRef } from "@/types/omr";

const DRAFT_KEY = "omr_exam_draft";

interface DraftPdfAssets {
    pdfDataRef?: StoredDataRef;
    answerKeyPdfRef?: StoredDataRef;
}

export async function deleteScopedDraftPdfAssets(input: {
    draft: DraftPdfAssets;
    scopedDraftKey: string;
    preserve?: DraftPdfAssets;
    deleteStoredData: (ref?: StoredDataRef) => Promise<void>;
}): Promise<{ expected: number; deleted: number; failed: number }> {
    const expected = [
        { ref: input.draft.pdfDataRef, key: `${input.scopedDraftKey}:problemPdf`, preserve: input.preserve?.pdfDataRef },
        { ref: input.draft.answerKeyPdfRef, key: `${input.scopedDraftKey}:answerKeyPdf`, preserve: input.preserve?.answerKeyPdfRef },
    ];
    let expectedCount = 0;
    let deleted = 0;
    let failed = 0;
    for (const candidate of expected) {
        if (candidate.ref?.store !== "indexeddb" || candidate.ref.key !== candidate.key) continue;
        if (candidate.preserve?.store === "indexeddb" && candidate.preserve.key === candidate.ref.key) continue;
        expectedCount += 1;
        try {
            await input.deleteStoredData(candidate.ref);
            deleted += 1;
        } catch {
            failed += 1;
        }
    }
    return { expected: expectedCount, deleted, failed };
}

export async function retryPendingScopedDraftPdfCleanup(input: {
    storage: {
        getItem(key: string): string | null;
        removeItem(key: string): void;
    };
    scopedDraftKey: string;
    deleteStoredData: (ref?: StoredDataRef) => Promise<void>;
}): Promise<
    | { status: "none"; cleanup: { expected: 0; deleted: 0; failed: 0 } }
    | { status: "failed" | "cleaned"; cleanup: { expected: number; deleted: number; failed: number } }
> {
    const markerKey = `${input.scopedDraftKey}:cleanupPending`;
    const empty = { expected: 0 as const, deleted: 0 as const, failed: 0 as const };
    let marker: { assets?: DraftPdfAssets; removeDraftBody?: boolean };
    try {
        const rawMarker = input.storage.getItem(markerKey);
        if (!rawMarker) return { status: "none", cleanup: empty };
        marker = JSON.parse(rawMarker) as { assets?: DraftPdfAssets; removeDraftBody?: boolean };
    } catch {
        return { status: "failed", cleanup: empty };
    }
    let draft = marker.assets;
    if (!draft) {
        try {
            const rawDraft = input.storage.getItem(input.scopedDraftKey);
            draft = rawDraft ? JSON.parse(rawDraft) as DraftPdfAssets : {};
        } catch {
            return { status: "failed", cleanup: empty };
        }
    }
    const cleanup = await deleteScopedDraftPdfAssets({
        draft,
        scopedDraftKey: input.scopedDraftKey,
        deleteStoredData: input.deleteStoredData,
    });
    if (cleanup.failed > 0) return { status: "failed", cleanup };
    try {
        if (marker.removeDraftBody) input.storage.removeItem(input.scopedDraftKey);
        input.storage.removeItem(markerKey);
    } catch {
        return { status: "failed", cleanup };
    }
    return { status: "cleaned", cleanup };
}

export function isLoadedExamCurrentForEdit(
    editId: string | null | undefined,
    loadedExam: { id: string } | null | undefined,
): boolean {
    return editId ? loadedExam?.id === editId : !loadedExam;
}

export function shouldApplyAutoDetectOutcome(input: {
    runGeneration: number;
    currentGeneration: number;
    aborted: boolean;
}): boolean {
    return input.runGeneration === input.currentGeneration && !input.aborted;
}

export function mergePdfHydrationFailures(
    previous: { problem: boolean; answer: boolean },
    input: {
        runGeneration: number;
        currentGeneration: number;
        problem: { replaced: boolean; failed: boolean };
        answer: { replaced: boolean; failed: boolean };
    },
): { problem: boolean; answer: boolean } {
    if (input.runGeneration !== input.currentGeneration) return previous;
    return {
        problem: input.problem.replaced ? previous.problem : input.problem.failed,
        answer: input.answer.replaced ? previous.answer : input.answer.failed,
    };
}

export async function resolveExamEditorLoad<T extends { organizationId?: string }>(
    serverResult:
        | { status: "loaded"; exam: T }
        | { status: "not_found" | "local_only" | "unauthorized" | "service_unavailable" },
    examId: string,
    activeOrganizationId: string,
    readBrowserOnly: (examId: string) => T | null | Promise<T | null>,
): Promise<{ exam: T; canonical: boolean; source: "server" | "browser_import" } | null> {
    if (serverResult.status === "loaded") {
        return { exam: serverResult.exam, canonical: true, source: "server" };
    }
    if (serverResult.status !== "not_found") return null;
    const organizationId = cleanSafeId(activeOrganizationId);
    if (!organizationId) return null;
    const exam = await readBrowserOnly(examId);
    if (!exam || cleanSafeId(exam.organizationId) !== organizationId) return null;
    return {
        exam,
        canonical: false,
        source: "browser_import",
    };
}

export function scopedExamDraftStorageKey(
    editId: string | null | undefined,
    organizationId: string,
    actorUserId: string,
): string {
    const safeOrganizationId = cleanSafeId(organizationId);
    const safeActorUserId = cleanSafeId(actorUserId);
    if (!safeOrganizationId || !safeActorUserId) {
        throw new Error("Unable to scope the teacher exam draft");
    }
    const requestedEditId = typeof editId === "string" ? editId.trim() : "";
    const safeEditId = cleanSafeId(editId);
    if (requestedEditId && !safeEditId) {
        throw new Error("Unable to scope the teacher exam draft editor slot");
    }
    const slot = safeEditId ? `exam:${safeEditId}` : "new";
    return `${DRAFT_KEY}:workspace:${safeOrganizationId}:${safeActorUserId}:${slot}`;
}

interface KeyValueStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const fallbackBrowserStorageValues = new Map<string, string>();
const fallbackBrowserStorage: KeyValueStorage = {
    getItem: key => fallbackBrowserStorageValues.get(key) ?? null,
    setItem: (key, value) => { fallbackBrowserStorageValues.set(key, value); },
    removeItem: key => { fallbackBrowserStorageValues.delete(key); },
};

export function safeBrowserStorage(getStorage: () => KeyValueStorage): KeyValueStorage {
    try {
        return getStorage();
    } catch {
        return fallbackBrowserStorage;
    }
}

type TeacherPdfKind = "problem_pdf" | "answer_key_pdf";
const volatilePublishTargets = new WeakMap<object, Map<string, string>>();
const volatilePdfUploadNonces = new WeakMap<object, Map<string, { fingerprint: string; nonce: string }>>();

function cleanSafeId(value: unknown): string {
    const normalized = typeof value === "string" ? value.trim() : "";
    return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(normalized) ? normalized : "";
}

function publishTargetKey(draftKey: string): string {
    return `${draftKey}:publishTargetId`;
}

export interface ExamPublishLockManager {
    request<T>(
        name: string,
        options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: { name: string } | null) => T | PromiseLike<T>,
    ): Promise<T>;
}

export async function withExclusiveExamPublishLock<T>(
    locks: ExamPublishLockManager | null | undefined,
    scopedDraftKey: string,
    operation: () => T | Promise<T>,
): Promise<
    | { status: "acquired"; value: T }
    | { status: "busy" | "unsupported" }
> {
    if (!locks) return { status: "unsupported" };
    const safeKey = scopedDraftKey.trim();
    if (!safeKey) return { status: "unsupported" };
    return locks.request(
        `omr-exam-publish:${safeKey}`,
        { mode: "exclusive", ifAvailable: true },
        async lock => lock
            ? { status: "acquired" as const, value: await operation() }
            : { status: "busy" as const },
    );
}

export function readNewExamPublishTarget(storage: KeyValueStorage, draftKey: string): string {
    const key = publishTargetKey(draftKey);
    try {
        const stored = cleanSafeId(storage.getItem(key));
        if (stored) return stored;
    } catch {
        // Fall through to the volatile map.
    }
    return cleanSafeId(volatilePublishTargets.get(storage)?.get(key));
}

export function getOrCreateNewExamPublishTarget(
    storage: KeyValueStorage,
    draftKey: string,
    createId: () => string,
    inMemoryFallback?: string | null,
): string {
    const key = publishTargetKey(draftKey);
    try {
        const stored = cleanSafeId(storage.getItem(key));
        if (stored) {
            let volatile = volatilePublishTargets.get(storage);
            if (!volatile) {
                volatile = new Map();
                volatilePublishTargets.set(storage, volatile);
            }
            volatile.set(key, stored);
            return stored;
        }
    } catch {
        // Fall through to the per-tab module map.
    }
    const volatile = volatilePublishTargets.get(storage)?.get(key);
    const targetId = cleanSafeId(inMemoryFallback) || cleanSafeId(volatile) || cleanSafeId(createId());
    if (!targetId) throw new Error("Unable to create a safe exam publish target");
    let targets = volatilePublishTargets.get(storage);
    if (!targets) {
        targets = new Map();
        volatilePublishTargets.set(storage, targets);
    }
    targets.set(key, targetId);
    try {
        storage.setItem(key, targetId);
    } catch {
        // The per-tab module map still keeps retries stable.
    }
    return targetId;
}

export function clearNewExamPublishTarget(storage: KeyValueStorage, draftKey: string): void {
    const key = publishTargetKey(draftKey);
    volatilePublishTargets.get(storage)?.delete(key);
    try {
        storage.removeItem(key);
    } catch {
        // A confirmed save must not be failed by unavailable browser storage.
    }
}

export async function discardNewExamPublishTarget(
    storage: KeyValueStorage,
    draftKey: string,
    release: (targetId: string) => void | Promise<void>,
): Promise<string> {
    const targetId = readNewExamPublishTarget(storage, draftKey);
    try {
        if (targetId) await release(targetId);
    } finally {
        clearNewExamPublishTarget(storage, draftKey);
    }
    return targetId;
}

function pdfUploadNonceKey(examId: string, kind: TeacherPdfKind): string {
    return `omr_teacher_pdf_upload:${examId}:${kind}`;
}

function pdfFingerprint(file: File): string {
    return JSON.stringify([file.name, file.size, file.lastModified, file.type]);
}

function writePdfUploadAttemptNonce(
    storage: KeyValueStorage,
    examId: string,
    kind: TeacherPdfKind,
    file: File,
    nonce: string,
): string {
    const safeNonce = cleanSafeId(nonce);
    if (!safeNonce) throw new Error("Unable to create a safe PDF upload nonce");
    const key = pdfUploadNonceKey(examId, kind);
    const value = { fingerprint: pdfFingerprint(file), nonce: safeNonce };
    let volatile = volatilePdfUploadNonces.get(storage);
    if (!volatile) {
        volatile = new Map();
        volatilePdfUploadNonces.set(storage, volatile);
    }
    volatile.set(key, value);
    try {
        storage.setItem(key, JSON.stringify(value));
    } catch {
        // The per-tab module map preserves retry identity when storage is blocked.
    }
    return safeNonce;
}

export function getOrCreatePdfUploadAttemptNonce(
    storage: KeyValueStorage,
    examId: string,
    kind: TeacherPdfKind,
    file: File,
    createNonce: () => string,
): string {
    const key = pdfUploadNonceKey(examId, kind);
    const fingerprint = pdfFingerprint(file);
    try {
        const parsed = JSON.parse(storage.getItem(key) || "null") as {
            fingerprint?: unknown;
            nonce?: unknown;
        } | null;
        const storedNonce = cleanSafeId(parsed?.nonce);
        if (storedNonce && parsed?.fingerprint === fingerprint) return storedNonce;
    } catch {
        // Fall through to the per-tab module map.
    }
    const volatile = volatilePdfUploadNonces.get(storage)?.get(key);
    if (volatile?.fingerprint === fingerprint && cleanSafeId(volatile.nonce)) return volatile.nonce;
    return writePdfUploadAttemptNonce(storage, examId, kind, file, createNonce());
}

export function rotatePdfUploadAttemptNonce(
    storage: KeyValueStorage,
    examId: string,
    kind: TeacherPdfKind,
    file: File,
    createNonce: () => string,
): string {
    return writePdfUploadAttemptNonce(storage, examId, kind, file, createNonce());
}

export function isEditDraftNewerThanExam(
    draftSavedAt: string | undefined,
    examUpdatedAt: string | undefined,
): boolean {
    if (!draftSavedAt) return false;
    const draftTime = Date.parse(draftSavedAt);
    if (Number.isNaN(draftTime)) return false;
    const parsedExamTime = examUpdatedAt ? Date.parse(examUpdatedAt) : 0;
    const examTime = Number.isNaN(parsedExamTime) ? 0 : parsedExamTime;
    return draftTime > examTime;
}

export function shouldUploadExamPdf(
    file: File | null,
    explicitlyReplaced: boolean,
    existingRef?: { store?: string; key?: string },
    inlineData?: string,
): file is File {
    if (!file) return false;
    const hasLegacyInlinePdf = typeof inlineData === "string"
        && /^data:/i.test(inlineData.trim());
    return explicitlyReplaced || existingRef?.store === "indexeddb" || hasLegacyInlinePdf;
}

type PdfHydrationOutcome<T> =
    | { status: "loaded"; value: T }
    | { status: "failed"; error: unknown };

export async function resolvePdfHydrationPairSequentially<TProblem, TAnswer>(input: {
    problem: () => Promise<TProblem>;
    answer: () => Promise<TAnswer>;
}): Promise<{
    problem: PdfHydrationOutcome<TProblem>;
    answer: PdfHydrationOutcome<TAnswer>;
}> {
    const settle = async <T,>(load: () => Promise<T>): Promise<PdfHydrationOutcome<T>> => {
        try {
            return { status: "loaded", value: await load() };
        } catch (error) {
            return { status: "failed", error };
        }
    };
    const problem = await settle(input.problem);
    const answer = await settle(input.answer);
    return { problem, answer };
}

export function shouldApplyPdfHydrationOutcome(input: {
    runGeneration: number;
    currentGeneration: number;
    replaced: boolean;
}): boolean {
    return input.runGeneration === input.currentGeneration && !input.replaced;
}

type PdfAssetUploadOutcome<T> =
    | { status: "skipped" }
    | { status: "uploaded"; value: T }
    | { status: "failed"; error: unknown };

export async function runPdfAssetUploadsSequentially<TProblem, TAnswer>(uploads: {
    problem?: () => Promise<TProblem>;
    answer?: () => Promise<TAnswer>;
    rollback?: () => Promise<void>;
}): Promise<{
    problem: PdfAssetUploadOutcome<TProblem>;
    answer: PdfAssetUploadOutcome<TAnswer>;
}> {
    const settle = async <T,>(upload?: () => Promise<T>): Promise<PdfAssetUploadOutcome<T>> => {
        if (!upload) return { status: "skipped" };
        try {
            return { status: "uploaded", value: await upload() };
        } catch (error) {
            return { status: "failed", error };
        }
    };
    const problem = await settle(uploads.problem);
    const answer = await settle(uploads.answer);
    if ((problem.status === "failed" || answer.status === "failed") && uploads.rollback) {
        await uploads.rollback();
    }
    return { problem, answer };
}
