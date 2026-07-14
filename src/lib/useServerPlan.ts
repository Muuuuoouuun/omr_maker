"use client";

import { useCallback, useEffect, useState } from "react";
import { getServerPlanSnapshot, type ServerPlanSnapshot } from "@/app/actions/premiumAccess";

const INITIAL_SERVER_PLAN: ServerPlanSnapshot = {
    authenticated: false,
    authoritative: false,
    plan: "free",
    source: "unavailable",
    limits: { exams: 5, students: 30, aiRecognition: 100 },
};

/**
 * Client display state derived from the signed-cookie server action. It starts
 * fail-closed as Free and never reads `omr_plan`; mutation actions still perform
 * their own final authorization to avoid TOCTOU/client-tampering bypasses.
 */
export function useServerPlan() {
    const [snapshot, setSnapshot] = useState<ServerPlanSnapshot>(INITIAL_SERVER_PLAN);
    const [loading, setLoading] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setSnapshot(await getServerPlanSnapshot());
        } catch (error) {
            setSnapshot({
                ...INITIAL_SERVER_PLAN,
                error: error instanceof Error ? error.message : "서버 플랜을 확인하지 못했습니다.",
            });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    return { snapshot, plan: snapshot.plan, loading, refresh };
}

