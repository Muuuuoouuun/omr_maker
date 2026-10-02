"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { uploadStudentAttemptHandwriting } from "@/app/actions/remoteAssets";
import type { PdfDrawings } from "@/types/omr";
import { deleteStoredData, loadJsonRecord } from "@/utils/blobStore";
import { getSession, STUDENT_SESSION_CHANGED_EVENT } from "@/utils/storage";
import {
    clearHandwritingUploadRecovery,
    fingerprintHandwritingUploadOwner,
    readHandwritingUploadRecovery,
    runHandwritingUploadRecovery,
    shouldDeleteHandwritingUploadRecovery,
    updateHandwritingUploadRecovery,
    type HandwritingUploadRecoveryManifest,
    type HandwritingUploadRetryProgress,
} from "@/lib/studentHandwritingUploadRecovery";

type RecoveryViewState = "loading" | "pending" | "waiting" | "uploading" | "succeeded" | "failed";

interface RecoveryViewCopy {
    title: string;
    detail: string;
}

function copyForState(state: RecoveryViewState, terminal: boolean): RecoveryViewCopy {
    if (state === "waiting") return {
        title: "재시도 대기 중",
        detail: "네트워크 부담을 줄이기 위해 잠시 기다린 뒤 다시 시도합니다.",
    };
    if (state === "uploading") return {
        title: "필기 업로드 중",
        detail: "답안은 이미 제출됐습니다. 이 화면을 닫아도 필기 원본은 이 기기에 유지됩니다.",
    };
    if (state === "succeeded") return {
        title: "필기 저장 완료",
        detail: "서버에 필기 원본이 안전하게 연결되었습니다.",
    };
    if (state === "failed") return terminal ? {
        title: "필기 업로드 실패",
        detail: "현재 계정이나 보관 플랜으로는 이 필기를 다시 업로드할 수 없습니다.",
    } : {
        title: "필기 업로드 실패",
        detail: "필기 원본은 이 기기에 남아 있습니다. 네트워크를 확인한 뒤 직접 다시 시도해주세요.",
    };
    return {
        title: "필기 업로드 다시 시도",
        detail: "답안은 정상 제출됐지만 필기 원본은 아직 이 기기에만 있습니다.",
    };
}

function containsDrawings(value: PdfDrawings | null): value is PdfDrawings {
    return !!value && Object.values(value).some(paths => Array.isArray(paths) && paths.length > 0);
}

export default function HandwritingUploadRecoveryCard({
    attemptId,
    examId,
    onRecovered,
}: {
    attemptId: string;
    examId: string;
    onRecovered: () => void;
}) {
    const [manifest, setManifest] = useState<HandwritingUploadRecoveryManifest | null>(null);
    const [drawings, setDrawings] = useState<PdfDrawings | null>(null);
    const [state, setState] = useState<RecoveryViewState>("loading");
    const [terminal, setTerminal] = useState(false);
    const [attemptNumber, setAttemptNumber] = useState(0);
    const restoreGenerationRef = useRef(0);
    const manifestRef = useRef<HandwritingUploadRecoveryManifest | null>(null);
    const completionTimerRef = useRef<number | null>(null);

    const restore = useCallback(async () => {
        const generation = ++restoreGenerationRef.current;
        manifestRef.current = null;
        setManifest(null);
        setDrawings(null);
        setTerminal(false);
        setState("loading");
        const session = getSession();
        const ownerId = session?.studentId || session?.guestId || "";
        if (!attemptId || !examId || !ownerId) return;
        try {
            const ownerFingerprint = await fingerprintHandwritingUploadOwner({
                examId,
                ownerId,
            });
            const recovered = await readHandwritingUploadRecovery(window.localStorage, {
                attemptId,
                ownerFingerprint,
                deleteSource: deleteStoredData,
            });
            if (generation !== restoreGenerationRef.current || !recovered) return;
            const source = await loadJsonRecord<PdfDrawings>(recovered.sourceRef);
            if (generation !== restoreGenerationRef.current) return;
            if (!containsDrawings(source)) {
                await clearHandwritingUploadRecovery(window.localStorage, recovered, deleteStoredData);
                setTerminal(true);
                setState("failed");
                return;
            }
            manifestRef.current = recovered;
            setManifest(recovered);
            setDrawings(source);
            const retryAt = recovered.nextRetryAt ? Date.parse(recovered.nextRetryAt) : 0;
            if (retryAt > Date.now()) {
                setState("waiting");
                window.setTimeout(() => {
                    if (generation === restoreGenerationRef.current) setState("pending");
                }, Math.min(retryAt - Date.now(), 2_000));
            } else {
                setState(recovered.failureCategory ? "failed" : "pending");
            }
        } catch {
            if (generation === restoreGenerationRef.current) setState("loading");
        }
    }, [attemptId, examId]);

    useEffect(() => {
        const initialRestore = window.setTimeout(() => { void restore(); }, 0);
        const handleSessionChange = () => { void restore(); };
        const handleStorage = (event: StorageEvent) => {
            if (event.key?.includes(attemptId)) void restore();
        };
        window.addEventListener(STUDENT_SESSION_CHANGED_EVENT, handleSessionChange);
        window.addEventListener("storage", handleStorage);
        return () => {
            restoreGenerationRef.current += 1;
            window.clearTimeout(initialRestore);
            if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current);
            window.removeEventListener(STUDENT_SESSION_CHANGED_EVENT, handleSessionChange);
            window.removeEventListener("storage", handleStorage);
        };
    }, [attemptId, restore]);

    const updateProgress = (progress: HandwritingUploadRetryProgress) => {
        setAttemptNumber(progress.attempt);
        if (progress.phase === "waiting") setState("waiting");
        else if (progress.phase === "uploading") setState("uploading");
        else if (progress.phase === "succeeded") setState("succeeded");
        else setState("failed");
        const current = manifestRef.current;
        if (!current) return;
        const updated = updateHandwritingUploadRecovery(window.localStorage, current, {
            retryCount: Math.min(progress.attempt, 3),
            nextRetryAt: progress.phase === "waiting"
                ? new Date(Date.now() + progress.delayMs).toISOString()
                : null,
            failureCategory: progress.phase === "failed" ? progress.status : current.failureCategory,
        }) || current;
        manifestRef.current = updated;
        setManifest(updated);
    };

    const retry = async () => {
        if (!manifest || !drawings || state === "waiting" || state === "uploading") return;
        setTerminal(false);
        const result = await runHandwritingUploadRecovery(manifest.attemptId,
            () => uploadStudentAttemptHandwriting({
                sessionId: manifest.sessionId,
                attemptId: manifest.attemptId,
                drawings,
            }),
            { onProgress: updateProgress },
        );
        if (result.status === "uploaded") {
            await clearHandwritingUploadRecovery(window.localStorage, manifest, deleteStoredData);
            manifestRef.current = null;
            setState("succeeded");
            completionTimerRef.current = window.setTimeout(onRecovered, 900);
            return;
        }
        if (shouldDeleteHandwritingUploadRecovery(result.status)) {
            await clearHandwritingUploadRecovery(window.localStorage, manifest, deleteStoredData);
            manifestRef.current = null;
            setManifest(null);
            setDrawings(null);
            setTerminal(true);
        }
        setState("failed");
    };

    if (state === "loading" || (!manifest && !terminal && state !== "succeeded")) return null;
    const copy = copyForState(state, terminal);
    const showRetry = !!manifest && !!drawings && !terminal && state !== "succeeded";

    return (
        <section className={`student-handwriting-recovery is-${state}`} aria-labelledby="student-handwriting-recovery-title">
            <div className="student-handwriting-recovery-copy" aria-live="polite">
                <strong id="student-handwriting-recovery-title">{copy.title}</strong>
                <p>{copy.detail}</p>
                {(state === "waiting" || state === "uploading") && attemptNumber > 0 && (
                    <small>{attemptNumber}/3회 처리 중</small>
                )}
            </div>
            {showRetry && (
                <div className="student-handwriting-recovery-actions">
                    <button
                        type="button"
                        className="btn btn-primary student-handwriting-recovery-button"
                        onClick={() => { void retry(); }}
                        disabled={state === "waiting" || state === "uploading"}
                    >
                        {state === "waiting" || state === "uploading" ? "처리 중…" : "필기 업로드 다시 시도"}
                    </button>
                </div>
            )}
        </section>
    );
}
