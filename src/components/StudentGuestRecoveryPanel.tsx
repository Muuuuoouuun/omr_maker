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
    const [discarding, setDiscarding] = useState(false);

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

    const discard = async () => {
        const wholeStore = recovery.status === "attempt_store_corrupt";
        const prompt = wholeStore
            ? "전체 응시 저장소가 손상되었습니다. 다른 학생의 캐시가 포함될 수 있습니다. 원문을 격리한 뒤 활성 저장소에서 제거할까요?"
            : recovery.status === "marker_corrupt"
                ? "손상된 복구 표식만 이 기기에서 폐기할까요? 응시 기록 저장소는 변경하지 않습니다."
                : "선택된 게스트의 미검증 로컬 기록을 이 기기에서 폐기할까요?";
        if (!window.confirm(prompt)) return;
        setDiscarding(true);
        const result = await discardGuestRecovery(
            recovery,
            window.localStorage,
            { quarantineWholeAttemptStore: wholeStore },
        );
        setDiscarding(false);
        if (result.status === "discarded" || result.status === "quarantined") {
            setRecovery(null);
            setMessage("");
        } else if (result.status === "stale") {
            refresh();
            setMessage("다른 탭에서 로컬 기록이 변경되었습니다. 최신 상태를 다시 확인한 뒤 재시도해주세요.");
        } else if (result.status === "blocked") {
            setMessage("기존 격리 데이터가 있어 현재 저장소를 변경하지 않았습니다. 먼저 복구 파일을 내보내주세요.");
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
                    : recovery.status === "marker_corrupt"
                        ? ` 복구 표식 손상 감지 (${recovery.byteLength}바이트). 응시 저장소는 이 작업에 포함되지 않습니다.`
                        : ` 전체 응시 저장소 손상 감지 (${recovery.byteLength}바이트). 다른 학생의 캐시가 포함될 수 있습니다.`}
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.55rem", marginTop: "0.85rem" }}>
                <button type="button" className="btn" onClick={exportRecovery}>복구 파일 내보내기</button>
                <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void retryServerClaims()}
                    disabled={retrying || recovery.status !== "unverified" || recovery.attemptIds.length === 0}
                >
                    {retrying ? "확인 중…" : "서버 소유 기록 다시 확인"}
                </button>
                <button
                    type="button"
                    className="btn"
                    onClick={() => void discard()}
                    disabled={discarding}
                    style={{ color: "var(--error)" }}
                >
                    {discarding
                        ? "처리 중…"
                        : recovery.status === "attempt_store_corrupt" ? "손상 저장소 격리" : "로컬 기록 폐기"}
                </button>
            </div>
            {message && <p role="status" style={{ marginTop: "0.7rem", fontSize: "0.8rem", color: "var(--muted)" }}>{message}</p>}
        </section>
    );
}
