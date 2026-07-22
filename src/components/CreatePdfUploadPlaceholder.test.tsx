import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const componentModuleUrl = new URL("./CreatePdfUploadPlaceholder.tsx", import.meta.url).href;

async function loadComponent() {
    return import(/* @vite-ignore */ componentModuleUrl) as Promise<
        typeof import("./CreatePdfUploadPlaceholder")
    >;
}

describe("CreatePdfUploadPlaceholder", () => {
    it("recognizes PDFs by MIME type or a case-insensitive file extension", async () => {
        const { isPdfUploadFile } = await loadComponent();

        expect(isPdfUploadFile({ name: "exam.bin", type: "application/pdf" })).toBe(true);
        expect(isPdfUploadFile({ name: "answer-key.PDF", type: "" })).toBe(true);
        expect(isPdfUploadFile({ name: "notes.txt", type: "text/plain" })).toBe(false);
    });

    it("renders a native keyboard-operable upload control with PDF input guidance", async () => {
        const { default: CreatePdfUploadPlaceholder } = await loadComponent();
        const markup = renderToStaticMarkup(
            <CreatePdfUploadPlaceholder onFileSelect={() => undefined} />,
        );

        expect(markup).toContain('<button type="button"');
        expect(markup).toContain('aria-label="문제지 PDF 업로드"');
        expect(markup).toContain('aria-describedby="create-pdf-upload-guidance"');
        expect(markup).toContain('accept="application/pdf,.pdf"');
        expect(markup).toContain("클릭하거나 PDF 파일을 드래그하세요");
    });
});
