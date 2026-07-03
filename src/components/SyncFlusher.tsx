"use client";

import { useEffect } from "react";
import { flushPendingAttemptSync, readPendingAttemptSyncIds } from "@/lib/omrPersistence";

/**
 * Invisible app-wide helper: when connectivity or tab visibility returns,
 * retries attempt saves whose remote sync failed (see queueAttemptPendingSync).
 */
export default function SyncFlusher() {
    useEffect(() => {
        let running = false;
        const flush = () => {
            if (running) return;
            if (readPendingAttemptSyncIds().length === 0) return;
            running = true;
            void flushPendingAttemptSync().finally(() => {
                running = false;
            });
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") flush();
        };

        flush();
        window.addEventListener("online", flush);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            window.removeEventListener("online", flush);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);

    return null;
}
