"use client";

import { FileText, UploadCloud } from "lucide-react";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";

const PDF_ACCEPT = "application/pdf,.pdf";

export interface CreatePdfUploadPlaceholderProps {
    onFileSelect: (file: File) => void;
    onInvalidFile?: (file: File) => void;
    title?: string;
    ariaLabel?: string;
    kindLabel?: string;
}

export function isPdfUploadFile(file: Pick<File, "name" | "type">): boolean {
    return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
}

export default function CreatePdfUploadPlaceholder({
    onFileSelect,
    onInvalidFile,
    title = "PDF 업로드",
    ariaLabel = "문제지 PDF 업로드",
    kindLabel = "문제지 · 정답지 PDF",
}: CreatePdfUploadPlaceholderProps) {
    const inputRef = useRef<HTMLInputElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const selectFile = (file: File | null | undefined) => {
        if (!file) return;

        if (!isPdfUploadFile(file)) {
            setError("PDF 파일만 업로드할 수 있습니다.");
            onInvalidFile?.(file);
            return;
        }

        setError(null);
        onFileSelect(file);
    };

    const handleInputChange = (event: ChangeEvent<HTMLInputElement>) => {
        selectFile(event.currentTarget.files?.[0]);
        event.currentTarget.value = "";
    };

    const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setIsDragging(true);
    };

    const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setIsDragging(false);
    };

    const handleDrop = (event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setIsDragging(false);
        selectFile(event.dataTransfer.files[0]);
    };

    return (
        <div
            className="pdf-viewer-container"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            style={{
                height: "100%",
                display: "flex",
                flexDirection: "column",
                background: "#525659",
                borderRight: "1px solid #333",
                position: "relative",
                overflow: "hidden",
            }}
        >
            <div
                className="pdf-viewer-toolbar"
                style={{
                    padding: "0.5rem 1rem",
                    background: "#323639",
                    color: "white",
                    display: "flex",
                    alignItems: "center",
                    fontSize: "0.9rem",
                    borderBottom: "1px solid #000",
                }}
            >
                <div className="pdf-viewer-file" style={{ display: "flex", alignItems: "center", gap: "0.55rem", minWidth: 0 }}>
                    <FileText size={15} aria-hidden="true" style={{ color: "#94a3b8", flexShrink: 0 }} />
                    <span className="pdf-viewer-file-name">PDF 없음</span>
                </div>
            </div>

            <div
                className="pdf-viewer-scroll scroll-custom"
                style={{ flex: 1, overflow: "auto", display: "flex", alignItems: "center", justifyContent: "center" }}
            >
                <button
                    type="button"
                    className="pdf-upload-empty"
                    aria-label={ariaLabel}
                    aria-describedby="create-pdf-upload-guidance"
                    onClick={() => inputRef.current?.click()}
                    style={isDragging ? {
                        borderColor: "#a5b4fc",
                        background: "rgba(79, 70, 229, 0.28)",
                    } : undefined}
                >
                    <div className="pdf-upload-empty-icon">
                        <UploadCloud size={30} aria-hidden="true" />
                    </div>
                    <p>{isDragging ? "PDF 파일을 여기에 놓으세요" : title}</p>
                    <span id="create-pdf-upload-guidance">클릭하거나 PDF 파일을 드래그하세요</span>
                    <strong>{kindLabel}</strong>
                    {error ? (
                        <span role="alert" aria-live="assertive" style={{ color: "#fecaca", marginTop: "0.25rem" }}>
                            {error}
                        </span>
                    ) : null}
                </button>
            </div>

            <input
                ref={inputRef}
                type="file"
                accept={PDF_ACCEPT}
                onChange={handleInputChange}
                tabIndex={-1}
                aria-hidden="true"
                style={{ display: "none" }}
            />
        </div>
    );
}
