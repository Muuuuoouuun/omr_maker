"use client";

import { useEffect } from "react";
import { toast } from "@/components/Toast";
import { askAttemptQuestion, submitAttempt } from "@/app/actions/studentExam";
import {
    checkpointDurableStudentAttemptSession,
    submitDurableStudentAttemptSession,
} from "@/app/actions/studentAttemptSession";
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
import {
    acknowledgeSecureSubmissionRecoveryNotice,
    maintainSecureSubmissionOutbox,
    readSecureSubmissionRecoveryNotices,
    replaySecureSubmissionsForOwner,
    secureSubmissionOwnerFingerprint,
} from "@/lib/studentSecureSubmissionOutbox";
import { getSession, STUDENT_SESSION_CHANGED_EVENT } from "@/utils/storage";
import { deleteStoredData } from "@/utils/blobStore";
import {
    isHandwritingUploadRecoveryStorageKey,
    maintainHandwritingUploadRecovery,
} from "@/lib/studentHandwritingUploadRecovery";

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
        const displayedRecoveryNoticeIds = new Set<string>();
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
            const secureSubmissionRecovery = maintainSecureSubmissionOutbox()
                .then(async maintenance => {
                    const notices = await readSecureSubmissionRecoveryNotices();
                    for (const notice of notices) {
                        if (displayedRecoveryNoticeIds.has(notice.id)) continue;
                        displayedRecoveryNoticeIds.add(notice.id);
                        const title = notice.kind === "expired"
                            ? "제출 재시도 기한 만료"
                            : "제출 재시도 정보 손상";
                        const detail = notice.kind === "expired"
                            ? "보관 기한이 지난 제출 답안은 자동 전송할 수 없습니다. 제출 여부를 선생님에게 문의해주세요."
                            : "안전하게 읽을 수 없는 제출 재시도 정보를 정리했습니다. 제출 여부를 선생님에게 문의해주세요.";
                        toast.action("error", title, detail, {
                            actionLabel: "확인",
                            durationMs: 60_000,
                            onAction: () => {
                                void acknowledgeSecureSubmissionRecoveryNotice(notice.id)
                                    .finally(() => displayedRecoveryNoticeIds.delete(notice.id));
                            },
                        });
                    }
                    if (!session?.studentId) return { maintenance, replay: { status: "empty" as const, submitted: [] } };
                    const ownerFingerprint = await secureSubmissionOwnerFingerprint(session.studentId);
                    const replay = await replaySecureSubmissionsForOwner(ownerFingerprint, {
                        checkpoint: checkpointDurableStudentAttemptSession,
                        submit: submitDurableStudentAttemptSession,
                    });
                    return { maintenance, replay };
                });
            const handwritingRecoveryMaintenance = maintainHandwritingUploadRecovery(window.localStorage, {
                deleteSource: deleteStoredData,
            });
            void Promise.all([
                receiptMaintenance,
                questionRecovery.catch(() => ({ status: "retryable_error" as const, sentCount: 0 })),
                secureSubmissionRecovery.catch(() => ({
                    maintenance: { expiredCount: 0, invalidCount: 0 },
                    replay: { status: "storage_error" as const, submitted: [], blockedCount: 0 },
                })),
                handwritingRecoveryMaintenance.catch(() => ({ expiredCount: 0, invalidCount: 0 })),
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
                    && !isHandwritingUploadRecoveryStorageKey(event.key)
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
