export interface DurableAttemptResumeCredential {
    ticket: string;
    leaseToken: string;
}

export interface DurableAttemptResumeScope {
    examId: string;
    actorId: string;
    assignmentId?: string;
    assignmentRevision?: number;
    retakeSegment?: string;
}

interface SessionStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function bounded(value: string): string {
    return value.trim().slice(0, 512);
}

export function durableAttemptResumeKey(scope: DurableAttemptResumeScope): string | null;
export function durableAttemptResumeKey(examId: string, actorId: string, scopeKey?: string): string;
export function durableAttemptResumeKey(
    scopeOrExamId: DurableAttemptResumeScope | string,
    legacyActorId?: string,
    legacyScopeKey = "base",
): string | null {
    const scope: DurableAttemptResumeScope = typeof scopeOrExamId === "string"
        ? { examId: scopeOrExamId, actorId: legacyActorId || "", retakeSegment: legacyScopeKey }
        : scopeOrExamId;
    const examId = bounded(scope.examId);
    const actorId = bounded(scope.actorId);
    const assignmentId = bounded(scope.assignmentId || "");
    const revision = Number.isSafeInteger(scope.assignmentRevision) && Number(scope.assignmentRevision) > 0
        ? Number(scope.assignmentRevision)
        : null;
    const retakeSegment = bounded(scope.retakeSegment || "base");
    if (!examId || !actorId || !retakeSegment || (assignmentId && !revision)) return null;
    const tuple = ["student-attempt-resume", 2, examId, actorId, assignmentId || null, revision, retakeSegment] as const;
    return `omr_attempt_lease:v2:${encodeURIComponent(JSON.stringify(tuple))}`;
}

export function readDurableAttemptResumeCredential(
    storage: SessionStorageLike,
    key: string,
): DurableAttemptResumeCredential | null {
    try {
        const parsed = JSON.parse(storage.getItem(key) || "null") as (Partial<DurableAttemptResumeCredential> & {
            schemaVersion?: unknown;
            scopeBinding?: unknown;
        }) | null;
        return parsed && typeof parsed.ticket === "string" && parsed.ticket.length <= 32_768
            && typeof parsed.leaseToken === "string" && parsed.leaseToken.length <= 512
            && parsed.ticket.length > 0 && parsed.leaseToken.length > 0
            && parsed.schemaVersion === 2 && parsed.scopeBinding === key
            ? { ticket: parsed.ticket, leaseToken: parsed.leaseToken }
            : null;
    } catch {
        return null;
    }
}

export function writeDurableAttemptResumeCredential(
    storage: SessionStorageLike,
    key: string,
    credential: DurableAttemptResumeCredential,
): boolean {
    try {
        storage.setItem(key, JSON.stringify({ schemaVersion: 2, scopeBinding: key, ...credential }));
        return true;
    } catch {
        return false;
    }
}

export function clearDurableAttemptResumeCredential(storage: SessionStorageLike, key: string): void {
    try {
        storage.removeItem(key);
    } catch {
        // Storage can be blocked in private/restricted browser contexts.
    }
}
