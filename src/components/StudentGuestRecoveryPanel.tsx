"use client";

import { useEffect, useState } from "react";
import { retryGuestServerClaims } from "@/app/actions/studentSession";
import {
    buildGuestRecoveryExport,
    clearGuestRecoveryMarker,
    discardGuestRecovery,
    readGuestRecoveryState,
    type GuestRecoveryState,
} from "@/lib/studentGuestRecovery";
import { getSession, mergeGuestAttempts } from "@/utils/storage";

export default function StudentGuestRecoveryPanel() {
    const [recovery, setRecovery] = useState<GuestRecoveryState | null>(null);
    const [message, setMessage] = useState("");
    const [retrying, setRetrying] = useState(false);

    const refresh = () => setRecovery(readGuestRecoveryState(window.localStorage));
    useEffect(() => { refresh(); }, []);

    if (!recovery) return null;

    const exportRecovery = () => {
        const blob = new Blob([buildGuestRecoveryExport(recovery)], { type: "application/json;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `omr-guest-recovery-${recovery.guestId || "unknown"}.json`;
        anchor.click();
        URL.revokeObjectURL(url);
        setMessage("복구 파일을 내보냈습니다. 이 파일은 공식 성적표가 아닌 미검증 로컬 기록입니다.");
    };

    const retryServerClaims = async () => {
        if (recovery.status !== "unverified" || recovery.attemptIds.length === 0) return;
        const session = getSession();
        if (!session || session.isGuest) {
            setMessage("학생 계정으로 로그인한 뒤 다시 확인할 수 있습니다.");
            return;
        }
        setRetrying(true);
        try {
            const result = await retryGuestServerClaims(recovery.attemptIds);
            const acknowledgedAttemptIds = result.status === "claimed" || result.status === "partial"
                ? result.acknowledgedAttemptIds
                : [];
            if (acknowledgedAttemptIds.length > 0) {
                mergeGuestAttempts(recovery.guestId, {
                    studentId: session.studentId,
                    name: session.name,
                    groupId: session.groupId,
                    groupName: session.groupName,
                    regionId: session.regionId,
                    regionName: session.regionName,
                    identityType: session.identityType,
                }, { attemptIds: acknowledgedAttemptIds });
            }
            const next = readGuestRecoveryState(window.localStorage);
            if (next?.status === "unverified" && next.attemptIds.length === 0) {
                clearGuestRecoveryMarker(window.localStorage);
                setRecovery(null);
                setMessage("");
                return;
            }
            setRecovery(next);
            setMessage(acknowledgedAttemptIds.length > 0
                ? `서버가 소유권을 확인한 ${acknowledgedAttemptIds.length}건만 학생 기록으로 연결했습니다.`
                : "서버가 소유권을 확인한 기록이 없습니다. 로컬 기록은 계속 분리 보관됩니다.");
        } finally {
            setRetrying(false);
        }
    };

    const discard = () => {
        if (!window.confirm("미검증 로컬 기록을 이 기기에서 폐기할까요? 내보내지 않은 데이터는 복구할 수 없습니다.")) return;
        if (discardGuestRecovery(recovery, window.localStorage)) {
            setRecovery(null);
            setMessage("");
        } else {
            setMessage("로컬 기록을 폐기하지 못했습니다. 브라우저 저장공간을 확인해주세요.");
        }
    };

    return (
        <section
            aria-label="미검증 로컬 기록 복구"
            style={{
                margin: "1rem 0 1.5rem",
                padding: "1rem",
                border: "1px solid rgba(245,158,11,0.35)",
                borderRadius: "var(--radius-lg)",
                background: "rgba(245,158,11,0.08)",
            }}
        >
            <h2 style={{ fontSize: "1rem", fontWeight: 850, color: "var(--foreground)" }}>
                미검증 로컬 기록 복구
            </h2>
            <p style={{ marginTop: "0.4rem", color: "var(--muted)", fontSize: "0.85rem", lineHeight: 1.55 }}>
                이 기기의 기록은 서버가 발급한 제출 증명이 없어 공식 학생 기록과 분리되어 있습니다.
                {recovery.status === "unverified"
                    ? ` 서버 소유권 확인 대기 ${recovery.attemptIds.length}건`
                    : ` 저장 데이터 손상 감지 (${recovery.byteLength}바이트)`}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.55rem", marginTop: "0.85rem" }}>
                <button type="button" className="btn" onClick={exportRecovery}>복구 파일 내보내기</button>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void retryServerClaims()}
                    disabled={retrying || recovery.status === "corrupt" || recovery.attemptIds.length === 0}
                >
                    {retrying ? "확인 중…" : "서버 소유 기록 다시 확인"}
                </button>
                <button type="button" className="btn" onClick={discard} style={{ color: "var(--error)" }}>
                    로컬 기록 폐기
                </button>
            </div>
            {message && <p role="status" style={{ marginTop: "0.7rem", fontSize: "0.8rem", color: "var(--muted)" }}>{message}</p>}
        </section>
    );
}
