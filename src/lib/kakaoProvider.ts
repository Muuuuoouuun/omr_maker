export type KakaoProviderMode = "disabled" | "simulation" | "live";
export type KakaoProviderReadinessStatus = "disabled" | "simulation" | "ready" | "blocked";

export interface KakaoProviderReadiness {
    mode: KakaoProviderMode;
    status: KakaoProviderReadinessStatus;
    label: string;
    detail: string;
    channelId?: string;
    canQueueDispatch: boolean;
    canMarkOutcomes: boolean;
    canLiveSend: boolean;
    missing: string[];
}

type Env = Record<string, string | undefined>;

function clean(value: string | undefined): string {
    return value?.trim() || "";
}

function providerMode(value: string | undefined): KakaoProviderMode {
    const normalized = clean(value).toLowerCase();
    if (normalized === "disabled") return "disabled";
    if (normalized === "live") return "live";
    return "simulation";
}

export function getKakaoProviderReadiness(env: Env = process.env): KakaoProviderReadiness {
    const mode = providerMode(env.NEXT_PUBLIC_KAKAO_PROVIDER_MODE);
    const channelId = clean(env.NEXT_PUBLIC_KAKAO_CHANNEL_ID);

    if (mode === "disabled") {
        return {
            mode,
            status: "disabled",
            label: "카카오 비활성",
            detail: "카카오 발송 후보와 로그는 숨기지 않지만 새 대기 기록은 운영 설정 후 사용하는 상태입니다.",
            channelId: channelId || undefined,
            canQueueDispatch: false,
            canMarkOutcomes: false,
            canLiveSend: false,
            missing: [],
        };
    }

    if (mode === "simulation") {
        return {
            mode,
            status: "simulation",
            label: "시뮬레이션 모드",
            detail: "실제 카카오 메시지는 보내지 않고 후보 검토, 대기 기록, 완료/실패 로그만 남깁니다.",
            channelId: channelId || undefined,
            canQueueDispatch: true,
            canMarkOutcomes: true,
            canLiveSend: false,
            missing: [],
        };
    }

    const missing = channelId ? [] : ["NEXT_PUBLIC_KAKAO_CHANNEL_ID"];
    if (missing.length > 0) {
        return {
            mode,
            status: "blocked",
            label: "카카오 연결 필요",
            detail: "Live 모드가 켜져 있지만 공개 채널 식별자가 없어 발송 대기 기록만 준비 상태로 둘 수 없습니다.",
            canQueueDispatch: false,
            canMarkOutcomes: false,
            canLiveSend: false,
            missing,
        };
    }

    return {
        mode,
        status: "ready",
        label: "카카오 Live 준비",
        detail: "공개 채널 식별자는 확인되었습니다. 실제 provider 호출은 서버 어댑터 연결 후 활성화합니다.",
        channelId,
        canQueueDispatch: true,
        canMarkOutcomes: true,
        canLiveSend: false,
        missing: [],
    };
}
