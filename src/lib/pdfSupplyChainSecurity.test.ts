import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function sourceFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(path);
        return /\.(?:ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

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

    it("loads browser PDF.js only through the legacy runtime and versioned legacy workers", () => {
        const offenders: string[] = [];
        for (const file of sourceFiles(join(root, "src"))) {
            const rel = relative(root, file);
            const source = readFileSync(file, "utf8");
            // Runtime imports of the bare package bypass the legacy entry point
            // (type-only imports are erased and therefore allowed).
            if (/(?:import\s*\(\s*|(?<!type\s[^;]*)from\s*)["']pdfjs-dist["']/.test(source)) offenders.push(`${rel}: bare pdfjs-dist import`);
            if (/["'`]\/(?:react-)?pdf\.worker\.min\.mjs/.test(source) && rel !== join("src", "lib", "pdfjsRuntime.ts")) {
                offenders.push(`${rel}: hard-coded worker path`);
            }
            if (/GlobalWorkerOptions\.workerSrc\s*=(?!=)/.test(source) && !/workerSrc\s*=\s*pdfWorkerSrc\(/.test(source)) {
                offenders.push(`${rel}: unversioned workerSrc assignment`);
            }
        }
        expect(offenders).toEqual([]);

        const runtime = readFileSync(join(root, "src/lib/pdfjsRuntime.ts"), "utf8");
        expect(runtime).toContain('import("pdfjs-dist/legacy/build/pdf.mjs")');
        expect(runtime).toContain("-legacy`");
    });

    it("aliases every browser pdfjs-dist import (including react-pdf's) to the legacy build", () => {
        const config = readFileSync(join(root, "next.config.ts"), "utf8");

        expect(config).toContain('"pdfjs-dist": { browser: "pdfjs-dist/legacy/build/pdf.mjs" }');
        // Turbopack is the only bundler; a webpack hook would silently skip the alias.
        expect(config).not.toMatch(/\bwebpack\s*[:(]/);
    });
});
