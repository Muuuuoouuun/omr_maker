import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Guards the versioned worker URL fix in PDFViewer.tsx:
//   pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs?v=${pdfjs.version}`
// The `?v=` query only busts the service-worker cache correctly if the worker
// shipped in public/ actually corresponds to the installed pdfjs-dist version.
// pdf.js throws "The API version X does not match the Worker version Y" when the
// page code and worker drift apart, so keep them locked together here.
describe("public/pdf.worker.min.mjs version", () => {
  const repoRoot = path.resolve(__dirname, "..", "..");

  const pkgVersion = JSON.parse(
    readFileSync(path.join(repoRoot, "node_modules", "pdfjs-dist", "package.json"), "utf8"),
  ).version as string;

  const worker = readFileSync(path.join(repoRoot, "public", "pdf.worker.min.mjs"), "utf8");

  it("matches the installed pdfjs-dist version", () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(worker).toContain(`"${pkgVersion}"`);
  });
});
