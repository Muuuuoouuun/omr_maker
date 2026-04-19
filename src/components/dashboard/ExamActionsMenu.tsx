"use client";

import { useEffect, useRef, useState } from "react";
import { MoreVertical, Pencil, Copy, Archive, Trash2 } from "lucide-react";

export type ExamActionKind = "edit" | "duplicate" | "archive" | "delete";

interface Props {
    exam: { id: string; title: string; archived?: boolean };
    onAction: (kind: ExamActionKind, examId: string) => void;
}

export default function ExamActionsMenu({ exam, onAction }: Props) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);

    // Close on outside click / Escape
    useEffect(() => {
        if (!open) return;
        const handleDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            document.removeEventListener("mousedown", handleDown);
            document.removeEventListener("keydown", handleKey);
        };
    }, [open]);

    const handleClick = (kind: ExamActionKind) => {
        setOpen(false);
        onAction(kind, exam.id);
    };

    const items: { kind: ExamActionKind; label: string; icon: React.ReactNode; danger?: boolean }[] = [
        { kind: "edit", label: "편집", icon: <Pencil size={14} /> },
        { kind: "duplicate", label: "복제", icon: <Copy size={14} /> },
        { kind: "archive", label: exam.archived ? "보관 해제" : "보관", icon: <Archive size={14} /> },
        { kind: "delete", label: "삭제", icon: <Trash2 size={14} />, danger: true },
    ];

    return (
        <div ref={wrapRef} style={{ position: "relative", display: "inline-block" }}>
            <button
                type="button"
                aria-label="시험 작업 메뉴"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(e) => {
                    e.stopPropagation();
                    setOpen((v) => !v);
                }}
                style={{
                    width: 32,
                    height: 32,
                    borderRadius: "var(--radius-md)",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    color: "var(--muted)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    cursor: "pointer",
                    transition: "all 0.15s",
                }}
                className="hover:border-primary hover:text-primary"
            >
                <MoreVertical size={16} />
            </button>

            {open && (
                <div
                    role="menu"
                    style={{
                        position: "absolute",
                        right: 0,
                        top: "calc(100% + 6px)",
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--radius-md)",
                        boxShadow: "0 10px 28px rgba(0,0,0,0.12)",
                        padding: "6px",
                        minWidth: 160,
                        zIndex: 50,
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px",
                    }}
                >
                    {items.map((it) => (
                        <button
                            key={it.kind}
                            role="menuitem"
                            type="button"
                            onClick={(e) => {
                                e.stopPropagation();
                                handleClick(it.kind);
                            }}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "0.5rem",
                                padding: "0.5rem 0.7rem",
                                fontSize: "0.85rem",
                                fontWeight: 600,
                                borderRadius: "var(--radius-sm, 6px)",
                                background: "transparent",
                                border: "none",
                                color: it.danger ? "var(--error, #ef4444)" : "var(--foreground)",
                                textAlign: "left",
                                cursor: "pointer",
                                transition: "background 0.15s",
                            }}
                            onMouseEnter={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.background = it.danger
                                    ? "rgba(239,68,68,0.08)"
                                    : "rgba(99,102,241,0.08)";
                            }}
                            onMouseLeave={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.background = "transparent";
                            }}
                        >
                            <span style={{ display: "inline-flex" }}>{it.icon}</span>
                            {it.label}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
