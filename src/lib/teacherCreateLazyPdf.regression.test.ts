import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relativePath: string): string {
    return readFileSync(path.join(process.cwd(), relativePath), "utf8");
}

describe("teacher create PDF startup performance", () => {
    it("does not mount the heavy PDF viewer before a PDF is selected", () => {
        const createPage = source("src/app/create/page.tsx");

        expect(createPage).toContain("CreatePdfUploadPlaceholder");
        expect(createPage).toContain("activePdfFile ? (");
        expect(createPage).toContain("<PDFViewer");
    });
});
