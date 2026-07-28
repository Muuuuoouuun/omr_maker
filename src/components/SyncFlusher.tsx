"use client";

import { useEffect } from "react";
import { submitAttempt } from "@/app/actions/studentExam";
import {
    flushPendingSubmissionReceipts,
    pendingSubmissionReceiptIds,
} from "@/lib/studentAttemptReceipt";
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
        const flush = () => {
            if (running) return;
            if (pendingSubmissionReceiptIds({ automaticOnly: true }).length === 0) return;
            running = true;
            void flushPendingSubmissionReceipts({
                submitSignedSessionAttempt: submitAttempt,
            }).finally(() => {
                running = false;
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
            window.removeEventListener("online", flush);
            window.removeEventListener(STUDENT_SESSION_CHANGED_EVENT, flush);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);

    return null;
}
