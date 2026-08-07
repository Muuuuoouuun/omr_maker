const DRAFT_KEY = "omr_exam_draft";

// New exams keep the legacy shared key; edits are isolated per exam.
export function examDraftStorageKey(editId: string | null | undefined): string {
    return editId ? `${DRAFT_KEY}_${editId}` : DRAFT_KEY;
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

export function shouldUploadExamPdf(file: File | null, explicitlyReplaced: boolean): file is File {
    return explicitlyReplaced && file !== null;
}

type PdfAssetUploadOutcome<T> =
    | { status: "skipped" }
    | { status: "uploaded"; value: T }
    | { status: "failed"; error: unknown };

export async function runPdfAssetUploadsConcurrently<TProblem, TAnswer>(uploads: {
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
    const [problem, answer] = await Promise.all([
        settle(uploads.problem),
        settle(uploads.answer),
    ]);
    if ((problem.status === "failed" || answer.status === "failed") && uploads.rollback) {
        await uploads.rollback();
    }
    return { problem, answer };
}
