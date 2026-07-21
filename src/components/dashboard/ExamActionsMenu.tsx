"use client";

import { useEffect, useId, useRef, useState } from "react";
import { MoreVertical, Pencil, Copy, Archive, Trash2 } from "lucide-react";

export type ExamActionKind = "edit" | "duplicate" | "archive" | "delete";

interface Props {
    exam: { id: string; title: string; archived?: boolean };
    onAction: (kind: ExamActionKind, examId: string) => void;
}

export default function ExamActionsMenu({ exam, onAction }: Props) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef<HTMLDivElement | null>(null);
    const triggerRef = useRef<HTMLButtonElement | null>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const initialFocusIndexRef = useRef(0);
    const menuId = useId();

    // Close on outside click / Escape and keep menu-key navigation contained.
    useEffect(() => {
        if (!open) return;
        const handleDown = (e: MouseEvent) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                setOpen(false);
                triggerRef.current?.focus();
                return;
            }

            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
            const availableItems = itemRefs.current.filter((item): item is HTMLButtonElement => Boolean(item));
            if (availableItems.length === 0) return;
            e.preventDefault();

            const currentIndex = availableItems.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "Home") availableItems[0].focus();
            else if (e.key === "End") availableItems[availableItems.length - 1].focus();
            else if (currentIndex < 0) {
                availableItems[e.key === "ArrowDown" ? 0 : availableItems.length - 1].focus();
            } else if (e.key === "ArrowDown") {
                availableItems[(currentIndex + 1) % availableItems.length].focus();
            } else {
                availableItems[(currentIndex - 1 + availableItems.length) % availableItems.length].focus();
            }
        };
        const focusTimer = window.setTimeout(() => {
            const requestedIndex = initialFocusIndexRef.current < 0
                ? itemRefs.current.length - 1
                : initialFocusIndexRef.current;
            itemRefs.current[requestedIndex]?.focus();
        }, 0);
        document.addEventListener("mousedown", handleDown);
        document.addEventListener("keydown", handleKey);
        return () => {
            window.clearTimeout(focusTimer);
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
                ref={triggerRef}
                type="button"
                aria-label="시험 작업 메뉴"
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                onClick={(e) => {
                    e.stopPropagation();
                    initialFocusIndexRef.current = 0;
                    setOpen((v) => !v);
                }}
                onKeyDown={(e) => {
                    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                    e.preventDefault();
                    initialFocusIndexRef.current = e.key === "ArrowUp" ? -1 : 0;
                    setOpen(true);
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
                onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "var(--primary)";
                    e.currentTarget.style.color = "var(--primary)";
                }}
                onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "var(--border)";
                    e.currentTarget.style.color = "var(--muted)";
                }}
            >
                <MoreVertical size={16} />
            </button>

            {open && (
                <div
                    id={menuId}
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
                    {items.map((it, index) => (
                        <button
                            ref={(element) => {
                                itemRefs.current[index] = element;
                            }}
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
