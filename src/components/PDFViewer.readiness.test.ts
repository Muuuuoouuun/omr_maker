import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
    canCompletePdfRender,
    isPdfRenderReady,
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
        expect(isPdfRenderReady(completedIdentity, null)).toBe(false);
    });

    it("is true only for the exact identity that completed", () => {
        expect(isPdfRenderReady(completedIdentity, completedIdentity)).toBe(true);
    });

    it.each([
        ["file", { ...completedIdentity, file: {} }],
        ["page", { ...completedIdentity, pageNumber: 2 }],
        ["scale", { ...completedIdentity, scale: 1.1 }],
        ["width", { ...completedIdentity, containerWidth: 801 }],
    ])("is false when the current %s changes", (_field, currentIdentity) => {
        expect(isPdfRenderReady(currentIdentity, completedIdentity)).toBe(false);
    });

    it("rejects a stale old completion for the current identity", () => {
        const currentIdentity = { ...completedIdentity, pageNumber: 2 };

        expect(canCompletePdfRender(currentIdentity, completedIdentity, 800, 1000)).toBe(false);
    });

    it("accepts only current completions with nonzero backing dimensions", () => {
        const currentIdentity = { ...completedIdentity, pageNumber: 2 };

        expect(canCompletePdfRender(currentIdentity, currentIdentity, 0, 1000)).toBe(false);
        expect(canCompletePdfRender(currentIdentity, currentIdentity, 800, 0)).toBe(false);
        expect(canCompletePdfRender(currentIdentity, currentIdentity, 800, 1000)).toBe(true);
    });
});

describe("PDFViewer readiness wiring", () => {
    const source = readFileSync(new URL("./PDFViewer.tsx", import.meta.url), "utf8");

    it("exposes the derived current-render readiness on the drawing overlay", () => {
        expect(source).toContain("isPdfRenderReady(currentPdfRenderIdentity, completedPdfRenderIdentity)");
        expect(source).toContain("canCompletePdfRender(");
        expect(source).toContain('data-pdf-ready={pdfRenderReady ? "true" : "false"}');
    });
});
