"use client";

import { useEffect } from "react";
import { askAttemptQuestion, submitAttempt } from "@/app/actions/studentExam";
import {
    flushPendingSubmissionReceipts,
    isSubmissionReceiptStorageKey,
    legacySubmissionReceiptCleanupDelayMs,
    migrateLegacySubmissionReceipts,
    pendingSubmissionReceiptIds,
} from "@/lib/studentAttemptReceipt";
import {
    cleanupFollowUpDelayMs,
    maintainAndFlushPendingSubmissionReceipts,
} from "@/lib/studentSubmissionFlush";
import {
    flushPendingStudentQuestionsForStudent,
    isStudentQuestionOutboxStorageKey,
} from "@/lib/studentQuestionOutbox";
import { getSession, STUDENT_SESSION_CHANGED_EVENT } from "@/utils/storage";

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
        let maintenanceTimer: number | null = null;
        let consecutiveMaintenanceFailures = 0;
        const flush = () => {
            if (running) {
                rerunRequested = true;
                return;
            }
            running = true;
            const receiptMaintenance = maintainAndFlushPendingSubmissionReceipts(
                () => flushPendingSubmissionReceipts({
                    submitSignedSessionAttempt: submitAttempt,
                }),
                {
                    migrateLegacySubmissionReceipts,
                    pendingSubmissionReceiptIds,
                    legacySubmissionReceiptCleanupDelayMs,
                },
            );
            const session = getSession();
            const questionRecovery = session?.studentId
                ? flushPendingStudentQuestionsForStudent(session.studentId, askAttemptQuestion)
                : Promise.resolve({ status: "empty" as const, sentCount: 0 as const });
            void Promise.all([
                receiptMaintenance,
                questionRecovery.catch(() => ({ status: "retryable_error" as const, sentCount: 0 })),
            ])
                .then(([{ cleanupDelayMs, maintenanceFailed }]) => {
                    if (disposed) return;
                    consecutiveMaintenanceFailures = maintenanceFailed
                        ? consecutiveMaintenanceFailures + 1
                        : 0;
                    if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
                    cleanupTimer = null;
                    const followUpDelayMs = cleanupFollowUpDelayMs(
                        cleanupDelayMs,
                        maintenanceFailed,
                        consecutiveMaintenanceFailures,
                    );
                    if (followUpDelayMs !== null) {
                        cleanupTimer = window.setTimeout(flush, followUpDelayMs);
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
        const queueMaintenance = () => {
            if (disposed || maintenanceTimer !== null) return;
            maintenanceTimer = window.setTimeout(() => {
                maintenanceTimer = null;
                flush();
            }, 0);
        };
        const onStorage = (event: StorageEvent) => {
            // Native storage events are never delivered back to their source
            // document. Ignore unrelated/synthetic events and coalesce the
            // remaining cross-tab notification into one maintenance pass.
            if (
                event.storageArea !== window.localStorage
                || (
                    !isSubmissionReceiptStorageKey(event.key)
                    && !isStudentQuestionOutboxStorageKey(event.key)
                )
            ) return;
            queueMaintenance();
        };

        flush();
        window.addEventListener("online", flush);
        window.addEventListener(STUDENT_SESSION_CHANGED_EVENT, flush);
        window.addEventListener("storage", onStorage);
        document.addEventListener("visibilitychange", onVisibilityChange);
        return () => {
            disposed = true;
            if (cleanupTimer !== null) window.clearTimeout(cleanupTimer);
            if (maintenanceTimer !== null) window.clearTimeout(maintenanceTimer);
            window.removeEventListener("online", flush);
            window.removeEventListener(STUDENT_SESSION_CHANGED_EVENT, flush);
            window.removeEventListener("storage", onStorage);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, []);

    return null;
}
