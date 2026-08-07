export interface DurableAttemptResumeCredential {
    ticket: string;
    leaseToken: string;
}

interface SessionStorageLike {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

function segment(value: string): string {
    return encodeURIComponent(value.trim().slice(0, 512));
}

export function durableAttemptResumeKey(examId: string, actorId: string, scopeKey = "base"): string {
    return `omr_attempt_lease:${segment(examId)}:${segment(actorId)}:${segment(scopeKey)}`;
}

export function readDurableAttemptResumeCredential(
    storage: SessionStorageLike,
    key: string,
): DurableAttemptResumeCredential | null {
    try {
        const parsed = JSON.parse(storage.getItem(key) || "null") as Partial<DurableAttemptResumeCredential> | null;
        return parsed && typeof parsed.ticket === "string" && parsed.ticket.length <= 32_768
            && typeof parsed.leaseToken === "string" && parsed.leaseToken.length <= 512
            && parsed.ticket.length > 0 && parsed.leaseToken.length > 0
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
        storage.setItem(key, JSON.stringify(credential));
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
