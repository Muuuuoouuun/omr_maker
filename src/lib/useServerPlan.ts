"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
    const requestVersion = useRef(0);

    const loadSnapshot = useCallback(() => {
        const version = ++requestVersion.current;
        return getServerPlanSnapshot().then(nextSnapshot => {
            if (version === requestVersion.current) setSnapshot(nextSnapshot);
        }).catch((error: unknown) => {
            if (version === requestVersion.current) {
                setSnapshot({
                    ...INITIAL_SERVER_PLAN,
                    error: error instanceof Error ? error.message : "서버 플랜을 확인하지 못했습니다.",
                });
            }
        }).finally(() => {
            if (version === requestVersion.current) setLoading(false);
        });
    }, []);

    const refresh = useCallback(() => {
        setLoading(true);
        return loadSnapshot();
    }, [loadSnapshot]);

    useEffect(() => {
        void loadSnapshot();
        return () => { requestVersion.current += 1; };
    }, [loadSnapshot]);

    return { snapshot, plan: snapshot.plan, loading, refresh };
}

