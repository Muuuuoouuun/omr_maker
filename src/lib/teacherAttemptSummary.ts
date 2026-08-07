import type { Attempt, StoredDataRef } from "@/types/omr";

/**
 * Scalar/list-safe teacher view of an attempt. Full answer maps, question
 * results, timing/focus events, handwriting bodies, and drawings are detail-only.
 */
export interface TeacherAttemptSummary extends Attempt {
    detailLevel: "summary";
    /** Canonical row version used to invalidate a previously loaded rich snapshot. */
    updatedAt?: string;
    /** Compatibility sentinel only; the summary query never selects answer JSON. */
    answers: Record<number, never>;
    handwritingQuestionCount?: number;
    handwritingStrokesRef?: StoredDataRef;
}
