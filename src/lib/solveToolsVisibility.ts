import type { Exam } from "@/types/omr";

/**
 * Which secondary tools the solve page's "도구" menu offers.
 *
 * Teacher mode is a teacher preview (the answer-key tab behind a password
 * dialog). It is not a security boundary — the dialog verifies the teacher —
 * but students should not see it. It is offered only when this tab already
 * holds a teacher session or the URL explicitly asks for a teacher preview
 * (`/solve/<id>?preview=teacher`, linked from the teacher exam detail page).
 */
export const TEACHER_PREVIEW_PARAM = "preview";
export const TEACHER_PREVIEW_VALUE = "teacher";

export function teacherPreviewHref(examId: string): string {
    return `/solve/${encodeURIComponent(examId)}?${TEACHER_PREVIEW_PARAM}=${TEACHER_PREVIEW_VALUE}`;
}

export function isTeacherPreviewRequested(search: string): boolean {
    try {
        return new URLSearchParams(search).get(TEACHER_PREVIEW_PARAM) === TEACHER_PREVIEW_VALUE;
    } catch {
        return false;
    }
}

export function shouldOfferTeacherPreview({
    hasTeacherSession,
    search,
}: {
    hasTeacherSession: boolean;
    search: string;
}): boolean {
    return hasTeacherSession || isTeacherPreviewRequested(search);
}

/** True when the exam carries its own problem PDF (inline or stored ref). */
export function examHasAttachedPdf(exam: Pick<Exam, "pdfData" | "pdfDataRef"> | null | undefined): boolean {
    return !!(exam?.pdfData || exam?.pdfDataRef);
}

/**
 * Students only need "PDF 열기" when the teacher did not attach a problem PDF
 * (e.g. the paper was handed out separately). With an attached PDF the button
 * only invites replacing the official paper, so it is hidden.
 */
export function shouldOfferStudentPdfOpen(exam: Pick<Exam, "pdfData" | "pdfDataRef"> | null | undefined): boolean {
    return !examHasAttachedPdf(exam);
}
