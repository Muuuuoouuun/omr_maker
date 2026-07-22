/**
 * Per-tab cache of the problem PDF a student attached during solving, keyed by
 * exam id. Retakes reuse it so the student doesn't re-upload the same file;
 * deliberately in-memory only — PDFs are too large for web storage quotas.
 */
const cache = new Map<string, File>();

export function rememberSolvePdf(examId: string, file: File): void {
    if (!examId) return;
    cache.set(examId, file);
}

export function recallSolvePdf(examId: string): File | null {
    return cache.get(examId) || null;
}

export function forgetSolvePdf(examId: string): void {
    cache.delete(examId);
}
