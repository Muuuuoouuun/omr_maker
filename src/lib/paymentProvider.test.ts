import { describe, expect, it } from "vitest";
import { getPaymentProviderReadiness, getPaymentProviderRolloutReadiness, PAYMENT_PROVIDER_CONFIGS } from "./paymentProvider";

describe("payment provider readiness", () => {
    it("defaults to Toss simulation without enabling live checkout", () => {
        expect(getPaymentProviderReadiness({})).toMatchObject({
            provider: { key: "toss", label: "토스페이먼츠", priority: 1 },
            mode: "simulation",
            status: "simulation",
            label: "토스페이먼츠 시뮬레이션",
            canRecordLocalPlanChange: true,
            canStartLiveCheckout: false,
            missing: [],
        });
    });

    it("keeps providers in the requested rollout order", () => {
        expect(PAYMENT_PROVIDER_CONFIGS.map(provider => provider.key)).toEqual(["toss", "naver", "kakao"]);
        expect(PAYMENT_PROVIDER_CONFIGS.map(provider => provider.publicEnvKey)).toEqual([
            "NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY",
            "NEXT_PUBLIC_NAVER_PAY_CLIENT_ID",
            "NEXT_PUBLIC_KAKAO_PAY_PUBLIC_KEY",
        ]);
    });

    it("reports per-provider rollout readiness in the requested order", () => {
        expect(getPaymentProviderRolloutReadiness({
            NEXT_PUBLIC_PAYMENT_PROVIDER: "naver",
            NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY: "toss-public",
            NEXT_PUBLIC_NAVER_PAY_CLIENT_ID: "naver-public",
        })).toEqual([
            expect.objectContaining({
                provider: expect.objectContaining({ key: "toss", label: "토스페이먼츠" }),
                active: false,
                publicKeyPresent: true,
                missing: [],
                label: "공개키 확인 · checkout 미연동",
            }),
            expect.objectContaining({
                provider: expect.objectContaining({ key: "naver", label: "네이버페이" }),
                active: true,
                publicKeyPresent: true,
                missing: [],
                label: "연결 대상 · 공개키 확인 · checkout 미연동",
            }),
            expect.objectContaining({
                provider: expect.objectContaining({ key: "kakao", label: "카카오페이" }),
                active: false,
                publicKeyPresent: false,
                missing: ["NEXT_PUBLIC_KAKAO_PAY_PUBLIC_KEY"],
                label: "공개키 필요",
            }),
        ]);
    });

    it("blocks live mode when the active provider public key is missing", () => {
        expect(getPaymentProviderReadiness({
            NEXT_PUBLIC_PAYMENT_PROVIDER_MODE: "live",
            NEXT_PUBLIC_PAYMENT_PROVIDER: "naver",
        })).toMatchObject({
            provider: { key: "naver", label: "네이버페이" },
            mode: "live",
            status: "blocked",
            label: "네이버페이 연결 필요",
            canRecordLocalPlanChange: false,
            canStartLiveCheckout: false,
            missing: ["NEXT_PUBLIC_NAVER_PAY_CLIENT_ID"],
        });
    });

    it("blocks live mode until the server checkout adapter and webhook exist", () => {
        expect(getPaymentProviderReadiness({
            NEXT_PUBLIC_PAYMENT_PROVIDER_MODE: "live",
            NEXT_PUBLIC_PAYMENT_PROVIDER: "kakao",
            NEXT_PUBLIC_KAKAO_PAY_PUBLIC_KEY: "public-key",
        })).toMatchObject({
            provider: { key: "kakao", label: "카카오페이" },
            mode: "live",
            status: "blocked",
            label: "카카오페이 checkout 서버 연동 필요",
            publicKeyPresent: true,
            canRecordLocalPlanChange: false,
            canStartLiveCheckout: false,
            missing: ["server checkout adapter", "webhook verification"],
        });
    });

    it("can disable all local plan change actions", () => {
        expect(getPaymentProviderReadiness({
            NEXT_PUBLIC_PAYMENT_PROVIDER_MODE: "disabled",
        })).toMatchObject({
            mode: "disabled",
            status: "disabled",
            label: "결제 비활성",
            canRecordLocalPlanChange: false,
            canStartLiveCheckout: false,
        });
    });
});
