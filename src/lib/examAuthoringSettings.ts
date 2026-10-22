import type { Exam } from '@/types/omr';

/** Teacher-only setup metadata; never changes student scoring by itself. */
export function normalizeExamAuthoringSettings(value: unknown): Exam['authoringSettings'] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    const targetTotalScore = typeof record.targetTotalScore === 'number'
        && Number.isFinite(record.targetTotalScore) && record.targetTotalScore > 0 && record.targetTotalScore <= 10000
        ? record.targetTotalScore : undefined;
    const pdfPageRange = typeof record.pdfPageRange === 'string' && record.pdfPageRange.trim().length <= 512
        && /^[\d\s,~–-]*$/.test(record.pdfPageRange)
        ? record.pdfPageRange.trim() || undefined : undefined;
    return targetTotalScore !== undefined || pdfPageRange !== undefined
        ? { ...(targetTotalScore !== undefined ? { targetTotalScore } : {}), ...(pdfPageRange ? { pdfPageRange } : {}) }
        : undefined;
}
