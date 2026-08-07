import { PAYMENT_PROVIDER_ROADMAP } from "@/lib/serviceRoadmap";
import type { PlanKey } from "@/types/omr";

export type PaymentProviderKey = typeof PAYMENT_PROVIDER_ROADMAP[number]["key"];
export type PaymentProviderMode = "disabled" | "simulation" | "live";
export type PaymentProviderReadinessStatus = "disabled" | "simulation" | "ready" | "blocked";

export interface PaymentProviderConfig {
    key: PaymentProviderKey;
    label: string;
    priority: number;
    publicEnvKey: string;
}

export interface PaymentProviderReadiness {
    provider: PaymentProviderConfig;
    mode: PaymentProviderMode;
    status: PaymentProviderReadinessStatus;
    label: string;
    detail: string;
    publicKeyPresent: boolean;
    canRecordLocalPlanChange: boolean;
    canStartLiveCheckout: boolean;
    missing: string[];
}

export interface PaymentProviderRolloutReadiness {
    provider: PaymentProviderConfig;
    active: boolean;
    publicKeyPresent: boolean;
    missing: string[];
    label: string;
}

/**
 * Provider-neutral server contracts. A checkout session records purchase
 * intent only; the organization's authoritative plan can change only after a
 * provider adapter verifies and normalizes a webhook event.
 */
export type PaidPlanKey = Exclude<PlanKey, "free">;
export type BillingCycle = "monthly" | "annual";

export interface CheckoutSessionRequest {
    organizationId: string;
    requestedByUserId: string;
    requestedPlan: PaidPlanKey;
    billingCycle: BillingCycle;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
}

export type CheckoutSessionResult =
    | {
        status: "created";
        provider: PaymentProviderKey;
        checkoutSessionId: string;
        redirectUrl: string;
        expiresAt?: string;
    }
    | { status: "unavailable"; error: "provider_adapter_not_configured" }
    | { status: "rejected"; error: "invalid_request" | "invalid_provider_response" | "provider_error" };

export interface RawPaymentWebhookRequest {
    headers: Readonly<Record<string, string | undefined>>;
    body: string;
}

export type SubscriptionLifecycleStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";
export type SubscriptionWebhookEventType = "subscription.created" | "subscription.updated" | "subscription.canceled";

export interface NormalizedSubscriptionWebhookEvent {
    eventId: string;
    eventType: SubscriptionWebhookEventType;
    occurredAt: string;
    organizationId: string;
    subscriptionId: string;
    subscriptionStatus: SubscriptionLifecycleStatus;
    targetPlan: PlanKey;
}

/** Produced only by a trusted server adapter after provider signature checks. */
export interface VerifiedPaymentWebhookEventEnvelope {
    signatureVerified: true;
    provider: PaymentProviderKey;
    event: NormalizedSubscriptionWebhookEvent;
}

export type PaymentWebhookVerificationResult =
    | { ok: true; envelope: VerifiedPaymentWebhookEventEnvelope }
    | { ok: false; error: "invalid_signature" | "malformed_event" | "unsupported_event" };

export interface PaymentProviderAdapter {
    readonly key: PaymentProviderKey;
    createCheckoutSession(request: CheckoutSessionRequest): Promise<CheckoutSessionResult>;
    verifyWebhook(request: RawPaymentWebhookRequest): Promise<PaymentWebhookVerificationResult>;
}

type Env = Record<string, string | undefined>;

const PROVIDER_PUBLIC_ENV_KEYS: Record<PaymentProviderKey, string> = {
    toss: "NEXT_PUBLIC_TOSS_PAYMENTS_CLIENT_KEY",
    naver: "NEXT_PUBLIC_NAVER_PAY_CLIENT_ID",
    kakao: "NEXT_PUBLIC_KAKAO_PAY_PUBLIC_KEY",
};

export const PAYMENT_PROVIDER_CONFIGS: PaymentProviderConfig[] = PAYMENT_PROVIDER_ROADMAP.map(provider => ({
    ...provider,
    publicEnvKey: PROVIDER_PUBLIC_ENV_KEYS[provider.key],
}));

function clean(value: string | undefined): string {
    return value?.trim() || "";
}

function paymentMode(value: string | undefined): PaymentProviderMode {
    const normalized = clean(value).toLowerCase();
    if (normalized === "disabled") return "disabled";
    if (normalized === "live") return "live";
    return "simulation";
}

function paymentProvider(value: string | undefined): PaymentProviderConfig {
    const normalized = clean(value).toLowerCase();
    return PAYMENT_PROVIDER_CONFIGS.find(provider => provider.key === normalized) || PAYMENT_PROVIDER_CONFIGS[0];
}

export function getPaymentProviderReadiness(env: Env = process.env): PaymentProviderReadiness {
    const provider = paymentProvider(env.NEXT_PUBLIC_PAYMENT_PROVIDER);
    const mode = paymentMode(env.NEXT_PUBLIC_PAYMENT_PROVIDER_MODE);
    const publicKeyPresent = !!clean(env[provider.publicEnvKey]);

    if (mode === "disabled") {
        return {
            provider,
            mode,
            status: "disabled",
            label: "결제 비활성",
            detail: "결제 provider가 꺼져 있어 플랜 변경 기록도 잠시 막아둔 상태입니다.",
            publicKeyPresent,
            canRecordLocalPlanChange: false,
            canStartLiveCheckout: false,
            missing: [],
        };
    }

    if (mode === "simulation") {
        return {
            provider,
            mode,
            status: "simulation",
            label: `${provider.label} 시뮬레이션`,
            detail: "실제 결제는 발생하지 않고 플랜 변경 기록만 이 브라우저에 저장합니다.",
            publicKeyPresent,
            canRecordLocalPlanChange: true,
            canStartLiveCheckout: false,
            missing: [],
        };
    }

    const missing = publicKeyPresent ? [] : [provider.publicEnvKey];
    if (missing.length > 0) {
        return {
            provider,
            mode,
            status: "blocked",
            label: `${provider.label} 연결 필요`,
            detail: "Live 모드가 켜져 있지만 공개 결제 식별자가 없어 플랜 변경을 진행하지 않습니다.",
            publicKeyPresent,
            canRecordLocalPlanChange: false,
            canStartLiveCheckout: false,
            missing,
        };
    }

    return {
        provider,
        mode,
        status: "blocked",
        label: `${provider.label} checkout 서버 연동 필요`,
        detail: "공개 결제 식별자만 확인했습니다. 서버 checkout, webhook 검증, 결제 취소 연동 전에는 결제나 플랜 변경을 시작하지 않습니다.",
        publicKeyPresent,
        canRecordLocalPlanChange: false,
        canStartLiveCheckout: false,
        missing: ["server checkout adapter", "webhook verification"],
    };
}

export function getPaymentProviderRolloutReadiness(env: Env = process.env): PaymentProviderRolloutReadiness[] {
    const activeProvider = paymentProvider(env.NEXT_PUBLIC_PAYMENT_PROVIDER);

    return PAYMENT_PROVIDER_CONFIGS.map(provider => {
        const publicKeyPresent = !!clean(env[provider.publicEnvKey]);
        const active = provider.key === activeProvider.key;
        return {
            provider,
            active,
            publicKeyPresent,
            missing: publicKeyPresent ? [] : [provider.publicEnvKey],
            label: publicKeyPresent
                ? (active ? "연결 대상 · 공개키 확인 · checkout 미연동" : "공개키 확인 · checkout 미연동")
                : (active ? "연결 대상 · 공개키 필요" : "공개키 필요"),
        };
    });
}
