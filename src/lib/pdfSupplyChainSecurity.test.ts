import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function versionTuple(version: string): [number, number, number] {
    const [major = 0, minor = 0, patch = 0] = version.split(".").map(Number);
    return [major, minor, patch];
}

function isAtLeast(version: string, minimum: string): boolean {
    const actual = versionTuple(version);
    const required = versionTuple(minimum);
    return actual.some((part, index) => (
        part > required[index]
        && actual.slice(0, index).every((earlier, earlierIndex) => earlier === required[earlierIndex])
    )) || actual.every((part, index) => part === required[index]);
}

describe("PDF.js supply-chain security contract", () => {
    it("resolves the patched PDF.js release or newer", () => {
        const installed = JSON.parse(
            readFileSync(join(root, "node_modules/pdfjs-dist/package.json"), "utf8"),
        ) as { version: string };

        expect(isAtLeast(installed.version, "6.2.108")).toBe(true);
    });

    it("requires a Node runtime supported by the patched PDF.js release", () => {
        const project = JSON.parse(
            readFileSync(join(root, "package.json"), "utf8"),
        ) as { engines?: { node?: string } };

        expect(project.engines?.node).toBe(">=22.13.0");
    });

    it("does not render the PDF annotation scripting surface", () => {
        const viewer = readFileSync(join(root, "src/components/PDFViewer.tsx"), "utf8");

        expect(viewer).toContain("renderAnnotationLayer={false}");
        expect(viewer).not.toContain("renderAnnotationLayer={true}");
    });

    it("destroys the teacher auto-detection loading task on every exit path", () => {
        const createPage = readFileSync(join(root, "src/app/create/page.tsx"), "utf8");

        expect(createPage).toContain("let pdfLoadingTask: PDFDocumentLoadingTask | null = null;");
        expect(createPage).toContain("await pdfLoadingTask?.destroy();");
    });
});
