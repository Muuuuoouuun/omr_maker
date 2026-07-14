import { describe, expect, it } from "vitest";
import { buildRasterPdfFromJpegPages } from "@/lib/annotatedPdfExport";

async function blobText(blob: Blob): Promise<string> {
    return new TextDecoder("latin1").decode(await blob.arrayBuffer());
}

describe("annotated PDF export", () => {
    it("builds a raster PDF container from JPEG page bytes", async () => {
        const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
        const blob = buildRasterPdfFromJpegPages([
            {
                jpegBytes,
                imageWidth: 2,
                imageHeight: 2,
                pageWidth: 100,
                pageHeight: 120,
            },
        ]);

        const pdf = await blobText(blob);

        expect(blob.type).toBe("application/pdf");
        expect(pdf.startsWith("%PDF-1.4")).toBe(true);
        expect(pdf).toContain("/Type /Catalog");
        expect(pdf).toContain("/Type /Page");
        expect(pdf).toContain("/Filter /DCTDecode");
        expect(pdf).toContain("/MediaBox [0 0 100.00 120.00]");
        expect(pdf.trim().endsWith("%%EOF")).toBe(true);
    });

    it("requires at least one rendered page", () => {
        expect(() => buildRasterPdfFromJpegPages([])).toThrow("At least one page is required");
    });
});
