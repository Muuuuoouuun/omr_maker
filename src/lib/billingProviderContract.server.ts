import type { PlanKey } from "@/types/omr";
import type {
    CheckoutSessionRequest,
    CheckoutSessionResult,
    PaymentProviderAdapter,
    PaymentProviderKey,
    RawPaymentWebhookRequest,
    SubscriptionLifecycleStatus,
    VerifiedPaymentWebhookEventEnvelope,
} from "./paymentProvider";

const SAFE_BILLING_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;

export interface OrganizationPlanTransitionInput {
    /** The store must atomically deduplicate this key with the plan update. */
    eventIdempotencyKey: string;
    provider: PaymentProviderKey;
    providerEventId: string;
    organizationId: string;
    subscriptionId: string;
    subscriptionStatus: SubscriptionLifecycleStatus;
    targetPlan: PlanKey;
    effectiveAt: string;
    source: "verified_webhook";
}

export type OrganizationPlanTransitionResult =
    | { status: "applied" }
    | { status: "duplicate" }
    | { status: "rejected"; error: "transition_rejected" };

export interface BillingPlanTransitionStore {
    /**
     * Persist the event id and authoritative organization plan transition in
     * one atomic operation. A repeated event id must return `duplicate`.
     */
    applyPlanTransitionOnceByEventId(
        input: OrganizationPlanTransitionInput,
    ): Promise<OrganizationPlanTransitionResult>;
}

export type BillingWebhookProcessingResult = OrganizationPlanTransitionResult
    | { status: "unavailable"; error: "billing_backend_not_configured" }
    | {
        status: "rejected";
        error: "invalid_signature" | "malformed_event" | "unsupported_event" | "invalid_verified_event" | "transition_store_error";
    };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function isSafeId(value: unknown): value is string {
    return SAFE_BILLING_ID.test(clean(value));
}

function isHttpsUrl(value: unknown): boolean {
    try {
        const url = new URL(clean(value));
        return url.protocol === "https:"
            && !url.username
            && !url.password
            && url.href.length <= 2_048;
    } catch {
        return false;
    }
}

function isIsoTimestamp(value: unknown): value is string {
    const timestamp = clean(value);
    return !!timestamp && Number.isFinite(Date.parse(timestamp));
}

function isPlanKey(value: unknown): value is PlanKey {
    return value === "free" || value === "pro" || value === "academy";
}

function validCheckoutRequest(input: CheckoutSessionRequest): boolean {
    return isSafeId(input.organizationId)
        && isSafeId(input.requestedByUserId)
        && (input.requestedPlan === "pro" || input.requestedPlan === "academy")
        && (input.billingCycle === "monthly" || input.billingCycle === "annual")
        && isHttpsUrl(input.successUrl)
        && isHttpsUrl(input.cancelUrl)
        && isSafeId(input.idempotencyKey);
}

function validCreatedCheckoutResult(
    result: CheckoutSessionResult,
    provider: PaymentProviderKey,
): boolean {
    if (result.status !== "created") return true;
    return result.provider === provider
        && isSafeId(result.checkoutSessionId)
        && isHttpsUrl(result.redirectUrl)
        && (result.expiresAt === undefined || isIsoTimestamp(result.expiresAt));
}

/**
 * Creates purchase intent only. With no real adapter, or with an invalid
 * adapter response, this function fails closed and never changes a plan.
 */
export async function createBillingCheckoutSession(
    request: CheckoutSessionRequest,
    adapter?: PaymentProviderAdapter,
): Promise<CheckoutSessionResult> {
    if (!adapter) return { status: "unavailable", error: "provider_adapter_not_configured" };
    if (!validCheckoutRequest(request)) return { status: "rejected", error: "invalid_request" };
    try {
        const result = await adapter.createCheckoutSession(request);
        if (!validCreatedCheckoutResult(result, adapter.key)) {
            return { status: "rejected", error: "invalid_provider_response" };
        }
        return result;
    } catch {
        return { status: "rejected", error: "provider_error" };
    }
}

function transitionFromVerifiedEnvelope(
    envelope: VerifiedPaymentWebhookEventEnvelope,
    expectedProvider: PaymentProviderKey,
): OrganizationPlanTransitionInput | null {
    const event = envelope.event;
    if (
        envelope.signatureVerified !== true
        || envelope.provider !== expectedProvider
        || !isSafeId(event.eventId)
        || !isSafeId(event.organizationId)
        || !isSafeId(event.subscriptionId)
        || !isIsoTimestamp(event.occurredAt)
        || !isPlanKey(event.targetPlan)
        || !["subscription.created", "subscription.updated", "subscription.canceled"].includes(event.eventType)
        || !["trialing", "active", "past_due", "canceled", "expired"].includes(event.subscriptionStatus)
    ) return null;

    return {
        eventIdempotencyKey: `${expectedProvider}:${event.eventId}`,
        provider: expectedProvider,
        providerEventId: event.eventId,
        organizationId: event.organizationId,
        subscriptionId: event.subscriptionId,
        subscriptionStatus: event.subscriptionStatus,
        targetPlan: event.targetPlan,
        effectiveAt: event.occurredAt,
        source: "verified_webhook",
    };
}

/**
 * Raw provider payloads are passed only to the signature-verifying adapter.
 * The plan store receives a bounded normalized transition and never raw JSON.
 */
export async function processVerifiedBillingWebhook(
    request: RawPaymentWebhookRequest,
    dependencies?: { adapter: PaymentProviderAdapter; store: BillingPlanTransitionStore },
): Promise<BillingWebhookProcessingResult> {
    if (!dependencies?.adapter || !dependencies.store) {
        return { status: "unavailable", error: "billing_backend_not_configured" };
    }

    let verification;
    try {
        verification = await dependencies.adapter.verifyWebhook(request);
    } catch {
        return { status: "rejected", error: "invalid_signature" };
    }
    if (!verification.ok) return { status: "rejected", error: verification.error };

    const transition = transitionFromVerifiedEnvelope(verification.envelope, dependencies.adapter.key);
    if (!transition) return { status: "rejected", error: "invalid_verified_event" };

    try {
        return await dependencies.store.applyPlanTransitionOnceByEventId(transition);
    } catch {
        return { status: "rejected", error: "transition_store_error" };
    }
}
