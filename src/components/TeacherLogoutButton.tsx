"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { clearTeacherAuthSession } from "@/app/actions/auth";
import { toast } from "@/components/Toast";
import { clearTeacherSession } from "@/lib/teacherSession";

interface TeacherLogoutButtonProps {
    size?: "small" | "normal";
}

export default function TeacherLogoutButton({ size = "normal" }: TeacherLogoutButtonProps) {
    const dimension = 44;
    const iconSize = size === "small" ? 15 : 16;
    const [logoutPending, setLogoutPending] = useState(false);

    const handleLogout = async () => {
        if (logoutPending) return;
        setLogoutPending(true);
        try {
            const result = await clearTeacherAuthSession();
            if (!result.success) {
                toast.error("로그아웃 실패", result.error || "연결을 확인한 뒤 다시 시도해주세요.");
                return;
            }
            clearTeacherSession();
            window.location.href = "/?role=teacher";
        } catch {
            toast.error("로그아웃 실패", "서버 세션이 남아 있을 수 있습니다. 연결을 확인한 뒤 다시 시도해주세요.");
        } finally {
            setLogoutPending(false);
        }
    };

    return (
        <button
            type="button"
            onClick={() => void handleLogout()}
            disabled={logoutPending}
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
                opacity: logoutPending ? 0.6 : 1,
                cursor: logoutPending ? "wait" : "pointer",
            }}
        >
            <LogOut size={iconSize} />
        </button>
    );
}
