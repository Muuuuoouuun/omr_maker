import { describe, expect, it } from "vitest";
import { getKakaoProviderReadiness } from "./kakaoProvider";

describe("kakao provider readiness", () => {
    it("defaults to simulation mode so local service flows never send live messages", () => {
        expect(getKakaoProviderReadiness({})).toMatchObject({
            mode: "simulation",
            status: "simulation",
            label: "시뮬레이션 모드",
            canQueueDispatch: true,
            canMarkOutcomes: true,
            canLiveSend: false,
            missing: [],
        });
    });

    it("blocks live mode until a public channel id is configured", () => {
        expect(getKakaoProviderReadiness({
            NEXT_PUBLIC_KAKAO_PROVIDER_MODE: "live",
        })).toMatchObject({
            mode: "live",
            status: "blocked",
            label: "카카오 연결 필요",
            canQueueDispatch: false,
            canMarkOutcomes: false,
            canLiveSend: false,
            missing: ["NEXT_PUBLIC_KAKAO_CHANNEL_ID"],
        });
    });

    it("reports live readiness without exposing server-side credentials", () => {
        expect(getKakaoProviderReadiness({
            NEXT_PUBLIC_KAKAO_PROVIDER_MODE: "live",
            NEXT_PUBLIC_KAKAO_CHANNEL_ID: "channel-1",
        })).toMatchObject({
            mode: "live",
            status: "ready",
            label: "카카오 Live 준비",
            channelId: "channel-1",
            canQueueDispatch: true,
            canMarkOutcomes: true,
            canLiveSend: false,
            missing: [],
        });
    });

    it("can be disabled from the public runtime flag", () => {
        expect(getKakaoProviderReadiness({
            NEXT_PUBLIC_KAKAO_PROVIDER_MODE: "disabled",
        })).toMatchObject({
            mode: "disabled",
            status: "disabled",
            label: "카카오 비활성",
            canQueueDispatch: false,
            canMarkOutcomes: false,
            canLiveSend: false,
        });
    });
});
