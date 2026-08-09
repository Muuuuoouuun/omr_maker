import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guards the versioned worker URL fix in PDFViewer.tsx:
//   pdfjs.GlobalWorkerOptions.workerSrc = `/react-pdf.worker.min.mjs?v=${pdfjs.version}`
// The `?v=` query only busts the service-worker cache correctly if the worker
// shipped in public/ actually corresponds to the installed pdfjs-dist version.
// pdf.js throws "The API version X does not match the Worker version Y" when the
// page code and worker drift apart, so keep them locked together here.
describe("public/react-pdf.worker.min.mjs version", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");
  const worker = readFileSync(path.join(repoRoot, "public", "react-pdf.worker.min.mjs"), "utf8");

  it("uses the patched react-pdf runtime floor and ships its exact worker", async () => {
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
    expect(worker).toContain(`"${runtimeVersion}"`);
  });
});
