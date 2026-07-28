"use client";

import { useEffect } from "react";
import { submitAttempt } from "@/app/actions/studentExam";
import {
    flushPendingSubmissionReceipts,
    pendingSubmissionReceiptIds,
} from "@/lib/studentAttemptReceipt";
import { saveLocalAttempt } from "@/lib/omrPersistence";

/**
 * Invisible app-wide helper: when connectivity or tab visibility returns,
 * retries the exact idempotent student submission server request whose remote
 * confirmation failed. Canonical grading never falls back to browser Supabase
 * CRUD here.
 */
export default function SyncFlusher() {
    useEffect(() => {
        let running = false;
        const flush = () => {
            if (running) return;
            if (pendingSubmissionReceiptIds().length === 0) return;
            running = true;
            void flushPendingSubmissionReceipts({
                submitSignedSessionAttempt: submitAttempt,
                onAuthoritativeAttempt: saveLocalAttempt,
            }).finally(() => {
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
