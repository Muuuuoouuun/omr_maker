import type { PersistenceResult } from "@/lib/omrPersistence";

export type PersistenceFeedbackLevel = "success" | "info" | "error";

export interface PersistenceFeedback {
    ok: boolean;
    level: PersistenceFeedbackLevel;
    title: string;
    detail: string;
}

export interface PersistenceFeedbackLabels {
    target: string;
    action: string;
    successTitle?: string;
    failureTitle?: string;
    failureDetail?: string;
}

export function summarizePersistenceWrite(
    result: PersistenceResult,
    labels: PersistenceFeedbackLabels,
): PersistenceFeedback {
    const successTitle = labels.successTitle || `${labels.target} ${labels.action} 완료`;
    const failureTitle = labels.failureTitle || `${labels.target} ${labels.action} 실패`;
    const failureDetail = labels.failureDetail || "브라우저 저장소와 Supabase 저장에 모두 실패했습니다.";

    if (result.localSaved && result.remoteSaved) {
        return {
            ok: true,
            level: "success",
            title: successTitle,
            detail: "이 기기와 Supabase에 모두 반영됐습니다.",
        };
    }

    if (result.localSaved) {
        return {
            ok: true,
            level: result.remoteError ? "info" : "success",
            title: result.remoteError ? "로컬 저장 완료" : successTitle,
            detail: result.remoteError
                ? "Supabase 동기화는 다음 로드 때 다시 시도됩니다."
                : "Supabase 미연결 상태라 이 기기에 저장됐습니다.",
        };
    }

    if (result.remoteSaved) {
        return {
            ok: true,
            level: "info",
            title: "Supabase 저장 완료",
            detail: "원격 저장은 완료됐지만 이 기기 캐시는 저장하지 못했습니다. 새로고침하면 서버 기준으로 다시 불러옵니다.",
        };
    }

    return {
        ok: false,
        level: "error",
        title: failureTitle,
        detail: result.remoteError || failureDetail,
    };
}
