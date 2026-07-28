import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("PDFViewer rendered-canvas readiness contract", () => {
    const source = readFileSync(new URL("./PDFViewer.tsx", import.meta.url), "utf8");

    it("exposes readiness only after a non-empty react-pdf canvas render", () => {
        expect(source).toContain("const [pdfRenderReady, setPdfRenderReady] = useState(false);");
        expect(source).toContain("setPdfRenderReady(false);");
        expect(source).toContain('querySelector<HTMLCanvasElement>(".react-pdf__Page__canvas")');
        expect(source).toContain("backingCanvas.width > 0 && backingCanvas.height > 0");
        expect(source).toContain('data-pdf-ready={pdfRenderReady ? "true" : "false"}');
    });
});
