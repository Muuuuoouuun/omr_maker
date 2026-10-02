// Single entry point for browser-side PDF.js.
//
// The modern pdfjs-dist build calls very new built-ins (for example
// Map.prototype.getOrInsertComputed) on the main thread and in its worker, so
// it crashes on browsers that lack them (Chromium 141, older iOS Safari and
// Android WebViews). The legacy build bundles core-js polyfills for both.
// - Main thread: next.config.ts aliases `pdfjs-dist` to the legacy build for
//   browser bundles (this also covers react-pdf's internal import), and
//   loadPdfJs() imports the legacy entry explicitly.
// - Worker: the worker runs in its own global, so public/*.worker.min.mjs must
//   be the legacy worker too (guarded by PDFViewer.workerVersion.test.ts).
import type * as PdfJs from "pdfjs-dist/legacy/build/pdf.mjs";

export type PdfJsModule = typeof PdfJs;

export const PDF_WORKER_ASSETS = {
    pdf: "/pdf.worker.min.mjs",
    reactPdf: "/react-pdf.worker.min.mjs",
} as const;

export type PdfWorkerAsset = keyof typeof PDF_WORKER_ASSETS;

/**
 * Versioned worker URL. The `-legacy` suffix makes the switch from the modern
 * worker a cache miss for the service worker's cache-first worker entries, so
 * returning PWA users never pair the legacy main thread with a stale worker.
 */
export function pdfWorkerSrc(version: string, asset: PdfWorkerAsset = "pdf"): string {
    return `${PDF_WORKER_ASSETS[asset]}?v=${encodeURIComponent(version)}-legacy`;
}

/** Point PDF.js at the bundled legacy worker unless a worker was already chosen. */
export function ensurePdfWorker(
    pdfjs: Pick<PdfJsModule, "GlobalWorkerOptions" | "version">,
    asset: PdfWorkerAsset = "pdf",
): void {
    if (typeof window === "undefined") return;
    if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc(pdfjs.version, asset);
    }
}

let pdfJsLoad: Promise<PdfJsModule> | null = null;

/** Lazily load the legacy PDF.js build with its worker configured. */
export function loadPdfJs(): Promise<PdfJsModule> {
    pdfJsLoad ??= import("pdfjs-dist/legacy/build/pdf.mjs")
        .then(pdfjs => {
            ensurePdfWorker(pdfjs);
            return pdfjs;
        })
        .catch(error => {
            // A failed chunk load must not poison every later attempt.
            pdfJsLoad = null;
            throw error;
        });
    return pdfJsLoad;
}
