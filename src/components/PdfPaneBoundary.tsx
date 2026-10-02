"use client";

import { useEffect } from "react";
import { catchError, type ErrorInfo } from "next/error";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Non-blocking stand-in for the PDF pane. The OMR answer sheet lives outside
 * this pane, so a PDF.js failure (unsupported browser API, worker load error,
 * corrupt file) must only replace the PDF — never the marking/submit UI.
 */
export function PdfPaneErrorCard({ onRetry }: { onRetry: () => void }) {
    return (
        <div
            data-testid="pdf-pane-error"
            style={{
                flex: 1,
                minHeight: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: "1.5rem",
                background: "var(--background)",
            }}
        >
            <div
                role="alert"
                style={{
                    maxWidth: 360,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "0.75rem",
                    padding: "1.5rem",
                    textAlign: "center",
                    background: "var(--surface)",
                    border: "1px solid color-mix(in srgb, var(--error) 28%, transparent)",
                    borderRadius: "var(--radius-lg)",
                    boxShadow: "var(--shadow-sm)",
                }}
            >
                <span
                    aria-hidden="true"
                    style={{
                        width: 44,
                        height: 44,
                        borderRadius: "var(--radius-full)",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "var(--error)",
                        background: "color-mix(in srgb, var(--error) 10%, transparent)",
                    }}
                >
                    <AlertTriangle size={22} />
                </span>
                <p style={{ margin: 0, fontSize: "var(--type-heading-sm)", fontWeight: 700, color: "var(--foreground)" }}>
                    문제지를 표시하지 못했습니다.
                </p>
                <p style={{ margin: 0, fontSize: "var(--type-body-sm)", color: "var(--muted)" }}>
                    답안 마킹과 제출은 계속할 수 있습니다.
                </p>
                <button type="button" className="btn btn-secondary" onClick={onRetry} style={{ gap: "0.4rem", fontSize: "var(--type-label)" }}>
                    <RotateCcw size={16} aria-hidden="true" /> 다시 시도
                </button>
            </div>
        </div>
    );
}

function PdfPaneFallback({ onRetry }: { onRetry?: () => void }, { error, reset }: ErrorInfo) {
    useEffect(() => {
        console.error("PDF pane failed", error);
    }, [error]);

    return (
        <PdfPaneErrorCard
            onRetry={() => {
                // Remount the viewer (parent key bump) and clear the boundary.
                // reset() rather than retry(): this is a client-only failure, so
                // there is nothing to re-fetch from the server.
                onRetry?.();
                reset();
            }}
        />
    );
}

/** Error boundary for render-time PDF failures. Async load/render failures are
 *  reported through PDFViewer's onLoadError/onRenderError into the same card. */
const PdfPaneBoundary = catchError(PdfPaneFallback);

export default PdfPaneBoundary;
