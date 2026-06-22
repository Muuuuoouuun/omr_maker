"use client";

import { LogOut } from "lucide-react";
import { clearTeacherAuthSession } from "@/app/actions/auth";
import { clearTeacherSession } from "@/lib/teacherSession";

interface TeacherLogoutButtonProps {
    size?: "small" | "normal";
}

export default function TeacherLogoutButton({ size = "normal" }: TeacherLogoutButtonProps) {
    const dimension = 44;
    const iconSize = size === "small" ? 15 : 16;

    const handleLogout = () => {
        clearTeacherSession();
        void clearTeacherAuthSession().finally(() => {
            window.location.href = "/?role=teacher";
        });
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
            <LogOut size={iconSize} />
        </button>
    );
}
