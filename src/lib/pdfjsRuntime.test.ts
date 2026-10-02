import { afterEach, describe, expect, it, vi } from "vitest";
import { ensurePdfWorker, pdfWorkerSrc } from "./pdfjsRuntime";

describe("pdfjsRuntime", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("versions both public workers with a legacy suffix", () => {
        expect(pdfWorkerSrc("6.2.108")).toBe("/pdf.worker.min.mjs?v=6.2.108-legacy");
        expect(pdfWorkerSrc("6.2.108", "reactPdf")).toBe("/react-pdf.worker.min.mjs?v=6.2.108-legacy");
    });

    it("sets the legacy worker only in the browser and never overrides an existing choice", () => {
        const pdfjs = { version: "6.2.108", GlobalWorkerOptions: { workerSrc: "" } };

        ensurePdfWorker(pdfjs as never);
        expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("");

        vi.stubGlobal("window", {});
        ensurePdfWorker(pdfjs as never);
        expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/pdf.worker.min.mjs?v=6.2.108-legacy");

        pdfjs.GlobalWorkerOptions.workerSrc = "/react-pdf.worker.min.mjs?v=6.2.108-legacy";
        ensurePdfWorker(pdfjs as never);
        expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/react-pdf.worker.min.mjs?v=6.2.108-legacy");
    });
});
