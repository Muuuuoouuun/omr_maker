"use client";

import { useEffect } from "react";
import { submitAttempt } from "@/app/actions/studentExam";
import {
    flushPendingSubmissionReceipts,
    legacySubmissionReceiptCleanupDelayMs,
    migrateLegacySubmissionReceipts,
    pendingSubmissionReceiptIds,
} from "@/lib/studentAttemptReceipt";
import { maintainAndFlushPendingSubmissionReceipts } from "@/lib/studentSubmissionFlush";
import { STUDENT_SESSION_CHANGED_EVENT } from "@/utils/storage";

/**
 * Invisible app-wide helper: when connectivity or tab visibility returns,
 * retries the exact idempotent student submission server request whose remote
 * confirmation failed. Canonical grading never falls back to browser Supabase
 * CRUD here.
 */
export default function SyncFlusher() {
    useEffect(() => {
        let running = false;
        let rerunRequested = false;
        let disposed = false;
        let cleanupTimer: number | null = null;
        const flush = () => {
            if (running) {
                rerunRequested = true;
                return;
            }
            running = true;
            void maintainAndFlushPendingSubmissionReceipts(
                () => flushPendingSubmissionReceipts({
                    submitSignedSessionAttempt: submitAttempt,
                }),
                {
                    migrateLegacySubmissionReceipts,
                    pendingSubmissionReceiptIds,
                    legacySubmissionReceiptCleanupDelayMs,
                },
            )
                .then(cleanupDelayMs => {
                    if (disposed) return;
                    if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
                    cleanupTimer = null;
                    if (cleanupDelayMs !== null) {
                        cleanupTimer = window.setTimeout(flush, cleanupDelayMs);
                    }
                })
                .catch(() => {
                    // Best-effort app boot maintenance retries on the next
                    // online, visibility, or student-session event.
                })
                .finally(() => {
                    running = false;
                    if (rerunRequested && !disposed) {
                        rerunRequested = false;
                        flush();
                    }
                });
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === "visible") flush();
        };

        flush();
        window.addEventListener("online", flush);
        window.addEventListener(STUDENT_SESSION_CHANGED_EVENT, flush);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            disposed = true;
            if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
            window.removeEventListener("online", flush);
            window.removeEventListener(STUDENT_SESSION_CHANGED_EVENT, flush);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);

    return null;
}
