import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pdfWorkerSrc } from "@/lib/pdfjsRuntime";

// Guards the versioned legacy worker URLs (src/lib/pdfjsRuntime.ts):
//   pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc(pdfjs.version, ...)
// The `?v=<version>-legacy` query only busts the service-worker cache correctly
// if the workers shipped in public/ are exactly the installed pdfjs-dist LEGACY
// worker. The worker runs in its own global, so the main-thread legacy alias
// (next.config.ts) cannot polyfill it: a modern worker still crashes on browsers
// without Map.prototype.getOrInsertComputed. pdf.js also throws "The API version
// X does not match the Worker version Y" when page code and worker drift apart.
const repoRoot = path.resolve(__dirname, "..", "..");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const legacyWorker = path.join(repoRoot, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.min.mjs");
const modernWorker = path.join(repoRoot, "node_modules", "pdfjs-dist", "build", "pdf.worker.min.mjs");
const publicWorkers = ["pdf.worker.min.mjs", "react-pdf.worker.min.mjs"].map(name => path.join(repoRoot, "public", name));

describe("public PDF.js workers", () => {
  it.each(publicWorkers)("%s is byte-identical to the installed legacy worker", workerPath => {
    expect(sha256(workerPath)).toBe(sha256(legacyWorker));
    expect(sha256(workerPath)).not.toBe(sha256(modernWorker));
    // The legacy worker carries the core-js polyfill for the API that crashed
    // the modern worker on Chromium 141.
    expect(readFileSync(workerPath, "utf8")).toContain("getOrInsertComputed:function");
  });

  it("uses the patched react-pdf runtime floor and a versioned legacy worker URL", async () => {
    // pdf.js only needs the constructor to initialize its Node-side display
    // module; the assertion below still reads the actual react-pdf export.
    const previousDOMMatrix = Object.getOwnPropertyDescriptor(globalThis, "DOMMatrix");
    if (!previousDOMMatrix) {
      Object.defineProperty(globalThis, "DOMMatrix", {
        configurable: true,
        value: class DOMMatrix {},
      });
    }
    const { pdfjs } = await import("react-pdf").finally(() => {
      if (previousDOMMatrix) Object.defineProperty(globalThis, "DOMMatrix", previousDOMMatrix);
      else Reflect.deleteProperty(globalThis, "DOMMatrix");
    });
    const runtimeVersion = pdfjs.version;
    const numericVersion = runtimeVersion.split(".").map(Number);

    expect(numericVersion).toHaveLength(3);
    expect(numericVersion.every(Number.isSafeInteger)).toBe(true);
    expect(numericVersion[0] > 6 || (numericVersion[0] === 6 && (
      numericVersion[1] > 2 || (numericVersion[1] === 2 && numericVersion[2] >= 108)
    ))).toBe(true);
    for (const workerPath of publicWorkers) {
      expect(readFileSync(workerPath, "utf8")).toContain(`"${runtimeVersion}"`);
    }
    expect(pdfWorkerSrc(runtimeVersion, "reactPdf")).toBe(`/react-pdf.worker.min.mjs?v=${runtimeVersion}-legacy`);

    const viewer = readFileSync(path.join(repoRoot, "src", "components", "PDFViewer.tsx"), "utf8");
    expect(viewer).toContain("pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc(pdfjs.version, 'reactPdf');");
  });
});
