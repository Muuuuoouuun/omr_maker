"use client";

import { useEffect } from "react";
import { reportError } from "@/lib/reportError";

/**
 * Last-resort boundary: catches errors thrown by the ROOT layout itself, where
 * segment-level error.tsx cannot help. Must render its own <html>/<body> and
 * cannot rely on globals.css, so everything here is self-contained.
 */
export default function GlobalError({
    error,
    reset,
}: {
    error: Error & { digest?: string };
    reset: () => void;
}) {
    useEffect(() => {
        reportError("global-error-boundary", error);
    }, [error]);

    return (
        <html lang="ko">
            <body style={{
                margin: 0,
                minHeight: "100vh",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "#f8fafc",
                color: "#0f172a",
                fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
            }}>
                <div style={{ maxWidth: 480, padding: "2rem", textAlign: "center" }}>
                    <div style={{
                        width: 72,
                        height: 72,
                        borderRadius: "50%",
                        background: "rgba(239,68,68,0.1)",
                        color: "#ef4444",
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginBottom: "1.25rem",
                        fontSize: "2rem",
                    }}>
                        !
                    </div>
                    <h1 style={{ fontSize: "1.4rem", fontWeight: 800, margin: "0 0 0.5rem" }}>
                        앱을 표시할 수 없습니다
                    </h1>
                    <p style={{ color: "#64748b", fontSize: "0.95rem", lineHeight: 1.6, margin: "0 0 1.25rem" }}>
                        예상치 못한 오류로 화면을 그리지 못했습니다. 다시 시도해도 반복되면
                        브라우저를 새로고침해주세요. 저장된 시험과 답안 기록은 안전합니다.
                    </p>
                    {error.digest && (
                        <code style={{
                            display: "inline-block",
                            fontSize: "0.72rem",
                            color: "#64748b",
                            padding: "0.25rem 0.6rem",
                            background: "#fff",
                            border: "1px solid #e2e8f0",
                            borderRadius: 6,
                            marginBottom: "1.25rem",
                        }}>
                            {error.digest}
                        </code>
                    )}
                    <div>
                        <button
                            onClick={reset}
                            style={{
                                padding: "0.75rem 1.6rem",
                                background: "#4f46e5",
                                color: "#fff",
                                border: "none",
                                borderRadius: 999,
                                fontWeight: 700,
                                fontSize: "0.95rem",
                                cursor: "pointer",
                            }}
                        >
                            다시 시도
                        </button>
                    </div>
                </div>
            </body>
        </html>
    );
}
