"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Legacy `/groups` route — superseded by the consolidated teacher console
 * at `/teacher/users` which has a dedicated "반 · 그룹" tab.
 * We redirect here and hint the tab via a query param.
 */
export default function LegacyGroupsRedirect() {
    const router = useRouter();

    useEffect(() => {
        router.replace("/teacher/users?tab=groups");
    }, [router]);

    return (
        <div
            style={{
                minHeight: '60vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#64748b',
                fontSize: '0.95rem',
            }}
        >
            그룹 관리 페이지로 이동 중...
        </div>
    );
}
