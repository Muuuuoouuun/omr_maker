export interface PdfRenderIdentity {
    file: unknown;
    pageNumber: number;
    scale: number;
    containerWidth: number;
}

export interface PdfRenderRequest extends PdfRenderIdentity {
    generation: number;
}

export interface PdfRenderReadinessState {
    currentRequest: PdfRenderRequest;
    completedRequest: PdfRenderRequest | null;
    renderVersion: number;
}

function isSamePdfRenderIdentity(
    firstIdentity: PdfRenderIdentity,
    secondIdentity: PdfRenderIdentity,
): boolean {
    return firstIdentity.file === secondIdentity.file
        && firstIdentity.pageNumber === secondIdentity.pageNumber
        && firstIdentity.scale === secondIdentity.scale
        && firstIdentity.containerWidth === secondIdentity.containerWidth;
}

function isSamePdfRenderRequest(
    currentRequest: PdfRenderRequest,
    completedRequest: PdfRenderRequest,
): boolean {
    return currentRequest.generation === completedRequest.generation
        && isSamePdfRenderIdentity(currentRequest, completedRequest);
}

export function createPdfRenderReadinessState(
    identity: PdfRenderIdentity,
): PdfRenderReadinessState {
    return {
        currentRequest: { ...identity, generation: 0 },
        completedRequest: null,
        renderVersion: 0,
    };
}

export function updatePdfRenderRequest(
    state: PdfRenderReadinessState,
    identity: PdfRenderIdentity,
): PdfRenderReadinessState {
    if (isSamePdfRenderIdentity(state.currentRequest, identity)) return state;

    return {
        ...state,
        currentRequest: {
            ...identity,
            generation: state.currentRequest.generation + 1,
        },
    };
}

export function isPdfRenderReady(
    currentRequest: PdfRenderRequest,
    completedRequest: PdfRenderRequest | null,
): boolean {
    return completedRequest !== null
        && isSamePdfRenderRequest(currentRequest, completedRequest);
}

export function canCompletePdfRender(
    currentRequest: PdfRenderRequest,
    completedRequest: PdfRenderRequest,
    backingCanvasWidth: number,
    backingCanvasHeight: number,
): boolean {
    return backingCanvasWidth > 0
        && backingCanvasHeight > 0
        && isSamePdfRenderRequest(currentRequest, completedRequest);
}

export function completePdfRenderRequest(
    state: PdfRenderReadinessState,
    completedRequest: PdfRenderRequest,
    backingCanvasWidth: number,
    backingCanvasHeight: number,
): PdfRenderReadinessState {
    if (!canCompletePdfRender(
        state.currentRequest,
        completedRequest,
        backingCanvasWidth,
        backingCanvasHeight,
    )) return state;

    return {
        ...state,
        completedRequest,
        renderVersion: state.renderVersion + 1,
    };
}
