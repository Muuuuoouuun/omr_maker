import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
    canCompletePdfRender,
    completePdfRenderRequest,
    createPdfRenderReadinessState,
    isPdfRenderReady,
    updatePdfRenderRequest,
    type PdfRenderIdentity,
} from "./pdfRenderReadiness";

const file = {};
const completedIdentity: PdfRenderIdentity = {
    file,
    pageNumber: 1,
    scale: 1,
    containerWidth: 800,
};

describe("PDF render identity readiness", () => {
    it("is false before any render completes", () => {
        const state = createPdfRenderReadinessState(completedIdentity);

        expect(isPdfRenderReady(state.currentRequest, state.completedRequest)).toBe(false);
    });

    it("is true only for the exact identity that completed", () => {
        const initialState = createPdfRenderReadinessState(completedIdentity);
        const completedState = completePdfRenderRequest(
            initialState,
            initialState.currentRequest,
            800,
            1000,
        );

        expect(isPdfRenderReady(
            completedState.currentRequest,
            completedState.completedRequest,
        )).toBe(true);
    });

    it.each([
        ["file", { ...completedIdentity, file: {} }],
        ["page", { ...completedIdentity, pageNumber: 2 }],
        ["scale", { ...completedIdentity, scale: 1.1 }],
        ["width", { ...completedIdentity, containerWidth: 801 }],
    ])("is false when the current %s changes", (_field, currentIdentity) => {
        const initialState = createPdfRenderReadinessState(completedIdentity);
        const completedState = completePdfRenderRequest(
            initialState,
            initialState.currentRequest,
            800,
            1000,
        );
        const changedState = updatePdfRenderRequest(completedState, currentIdentity);

        expect(changedState.currentRequest.generation).toBe(1);
        expect(isPdfRenderReady(
            changedState.currentRequest,
            changedState.completedRequest,
        )).toBe(false);
    });

    it("rejects a stale old completion for the current identity", () => {
        const stateA0 = createPdfRenderReadinessState(completedIdentity);
        const stateB1 = updatePdfRenderRequest(
            stateA0,
            { ...completedIdentity, pageNumber: 2 },
        );

        expect(canCompletePdfRender(
            stateB1.currentRequest,
            stateA0.currentRequest,
            800,
            1000,
        )).toBe(false);
    });

    it("does not reuse an old completion when identity values recur", () => {
        const stateA0 = createPdfRenderReadinessState(completedIdentity);
        const completedA0 = completePdfRenderRequest(
            stateA0,
            stateA0.currentRequest,
            800,
            1000,
        );
        const stateB1 = updatePdfRenderRequest(
            completedA0,
            { ...completedIdentity, pageNumber: 2 },
        );
        const stateA2 = updatePdfRenderRequest(stateB1, completedIdentity);
        const staleA0 = completePdfRenderRequest(
            stateA2,
            stateA0.currentRequest,
            800,
            1000,
        );
        const completedA2 = completePdfRenderRequest(
            staleA0,
            stateA2.currentRequest,
            800,
            1000,
        );

        expect(stateA0.currentRequest.generation).toBe(0);
        expect(stateB1.currentRequest.generation).toBe(1);
        expect(stateA2.currentRequest.generation).toBe(2);
        expect(isPdfRenderReady(
            stateB1.currentRequest,
            stateB1.completedRequest,
        )).toBe(false);
        expect(isPdfRenderReady(
            stateA2.currentRequest,
            stateA2.completedRequest,
        )).toBe(false);
        expect(staleA0).toBe(stateA2);
        expect(isPdfRenderReady(
            staleA0.currentRequest,
            staleA0.completedRequest,
        )).toBe(false);
        expect(isPdfRenderReady(
            completedA2.currentRequest,
            completedA2.completedRequest,
        )).toBe(true);
    });

    it("accepts only current completions with nonzero backing dimensions", () => {
        const state = createPdfRenderReadinessState(completedIdentity);
        const currentRequest = state.currentRequest;

        expect(canCompletePdfRender(currentRequest, currentRequest, 0, 1000)).toBe(false);
        expect(canCompletePdfRender(currentRequest, currentRequest, 800, 0)).toBe(false);
        expect(canCompletePdfRender(currentRequest, currentRequest, 800, 1000)).toBe(true);
    });
});

describe("PDFViewer readiness wiring", () => {
    const source = readFileSync(new URL("./PDFViewer.tsx", import.meta.url), "utf8");

    it("exposes the derived current-render readiness on the drawing overlay", () => {
        expect(source).toContain("updatePdfRenderRequest(pdfRenderState, currentPdfRenderIdentity)");
        expect(source).toContain("if (nextPdfRenderState !== pdfRenderState)");
        expect(source).toContain("setPdfRenderState(nextPdfRenderState);");
        expect(source).toContain("completePdfRenderRequest(");
        expect(source).toContain('data-pdf-ready={pdfRenderReady ? "true" : "false"}');
    });
});
