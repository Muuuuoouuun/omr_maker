"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, ShieldCheck } from "lucide-react";
import {
    buildTeacherSessionDisplay,
    readTeacherSession,
    type TeacherSessionDisplay,
} from "@/lib/teacherSession";

interface TeacherSessionChipProps {
    compact?: boolean;
}

function readDisplay(): TeacherSessionDisplay {
    if (typeof window === "undefined") return buildTeacherSessionDisplay(null);
    return buildTeacherSessionDisplay(readTeacherSession());
}

function toneForLevel(level: TeacherSessionDisplay["level"]): { color: string; background: string; border: string } {
    if (level === "expired") {
        return { color: "var(--error)", background: "rgba(239,68,68,0.08)", border: "rgba(239,68,68,0.22)" };
    }
    if (level === "expiring") {
        return { color: "var(--warning)", background: "rgba(245,158,11,0.1)", border: "rgba(245,158,11,0.25)" };
    }
    return { color: "var(--success)", background: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.22)" };
}

export default function TeacherSessionChip({ compact = false }: TeacherSessionChipProps) {
    const [display, setDisplay] = useState<TeacherSessionDisplay>(() => buildTeacherSessionDisplay(null));

    useEffect(() => {
        const update = () => setDisplay(readDisplay());
        const initialTimer = window.setTimeout(update, 0);
        const interval = window.setInterval(update, 60 * 1000);
        const handleFocus = () => update();
        const handleVisibilityChange = () => {
            if (document.visibilityState === "visible") update();
        };

        window.addEventListener("focus", handleFocus);
        document.addEventListener("visibilitychange", handleVisibilityChange);
        return () => {
            window.clearTimeout(initialTimer);
            window.clearInterval(interval);
            window.removeEventListener("focus", handleFocus);
            document.removeEventListener("visibilitychange", handleVisibilityChange);
        };
    }, []);

    const tone = toneForLevel(display.level);
    const Icon = display.level === "active" ? ShieldCheck : AlertTriangle;

    return (
        <span
            className={`teacher-session-chip ${compact ? "is-compact" : ""} ${display.level === "expiring" ? "is-expiring" : ""} ${display.level === "expired" ? "is-expired" : ""}`}
            title={display.detail}
            aria-label={`교사 세션 ${display.actorLabel} ${display.label}`}
            style={{
                color: tone.color,
                background: tone.background,
                border: `1px solid ${tone.border}`,
            }}
        >
            <Icon size={compact ? 13 : 14} aria-hidden="true" />
            {!compact && <span className="teacher-session-chip-prefix">{display.actorLabel}</span>}
            <strong>{display.label}</strong>
        </span>
    );
}
