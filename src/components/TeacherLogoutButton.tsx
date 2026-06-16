"use client";

import { LogOut } from "lucide-react";
import { clearTeacherSession } from "@/lib/teacherSession";

interface TeacherLogoutButtonProps {
    size?: "small" | "normal";
}

export default function TeacherLogoutButton({ size = "normal" }: TeacherLogoutButtonProps) {
    const dimension = size === "small" ? 34 : 36;

    const handleLogout = () => {
        clearTeacherSession();
        window.location.href = "/?role=teacher";
    };

    return (
        <button
            type="button"
            onClick={handleLogout}
            aria-label="교사 로그아웃"
            title="교사 로그아웃"
            style={{
                width: dimension,
                height: dimension,
                display: 'grid',
                placeItems: 'center',
                borderRadius: '50%',
                border: '1px solid var(--border)',
                background: 'var(--background)',
                color: 'var(--muted)',
                flexShrink: 0,
            }}
        >
            <LogOut size={size === "small" ? 14 : 15} />
        </button>
    );
}
