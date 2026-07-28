export interface PdfRenderIdentity {
    file: unknown;
    pageNumber: number;
    scale: number;
    containerWidth: number;
}

function isSamePdfRenderIdentity(
    currentIdentity: PdfRenderIdentity,
    completedIdentity: PdfRenderIdentity,
): boolean {
    return currentIdentity.file === completedIdentity.file
        && currentIdentity.pageNumber === completedIdentity.pageNumber
        && currentIdentity.scale === completedIdentity.scale
        && currentIdentity.containerWidth === completedIdentity.containerWidth;
}

export function isPdfRenderReady(
    currentIdentity: PdfRenderIdentity,
    completedIdentity: PdfRenderIdentity | null,
): boolean {
    return completedIdentity !== null
        && isSamePdfRenderIdentity(currentIdentity, completedIdentity);
}

export function canCompletePdfRender(
    currentIdentity: PdfRenderIdentity,
    completedIdentity: PdfRenderIdentity,
    backingCanvasWidth: number,
    backingCanvasHeight: number,
): boolean {
    return backingCanvasWidth > 0
        && backingCanvasHeight > 0
        && isSamePdfRenderIdentity(currentIdentity, completedIdentity);
}
