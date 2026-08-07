import { describe, expect, it, vi } from "vitest";
import {
    createBillingCheckoutSession,
    processVerifiedBillingWebhook,
    type BillingPlanTransitionStore,
    type OrganizationPlanTransitionInput,
} from "./billingProviderContract.server";
import type {
    PaymentProviderAdapter,
    RawPaymentWebhookRequest,
    VerifiedPaymentWebhookEventEnvelope,
} from "./paymentProvider";

const checkoutRequest = {
    organizationId: "org_01JABCDEF0123456789",
    requestedByUserId: "user_01JABCDEF0123456789",
    requestedPlan: "pro" as const,
    billingCycle: "monthly" as const,
    successUrl: "https://omr.example/teacher/billing?checkout=success",
    cancelUrl: "https://omr.example/teacher/billing?checkout=cancel",
    idempotencyKey: "checkout_01JABCDEF0123456789",
};

const rawWebhook: RawPaymentWebhookRequest = {
    headers: { "x-provider-signature": "opaque-signature" },
    body: "{\"providerPayload\":\"untrusted\"}",
};

function verifiedEnvelope(eventId = "evt_01JABCDEF0123456789"): VerifiedPaymentWebhookEventEnvelope {
    return {
        signatureVerified: true,
        provider: "toss",
        event: {
            eventId,
            eventType: "subscription.updated",
            occurredAt: "2026-08-07T00:00:00.000Z",
            organizationId: "org_01JABCDEF0123456789",
            subscriptionId: "sub_01JABCDEF0123456789",
            subscriptionStatus: "active",
            targetPlan: "pro",
        },
    };
}

describe("provider-neutral billing server contract", () => {
    it("fails closed when no checkout provider adapter is configured", async () => {
        await expect(createBillingCheckoutSession(checkoutRequest)).resolves.toEqual({
            status: "unavailable",
            error: "provider_adapter_not_configured",
        });
    });

    it("returns only a checkout redirect and never treats browser intent as a plan transition", async () => {
        const adapter: PaymentProviderAdapter = {
            key: "toss",
            createCheckoutSession: vi.fn(async () => ({
                status: "created" as const,
                provider: "toss" as const,
                checkoutSessionId: "checkout_provider_01",
                redirectUrl: "https://pay.example/checkout/checkout_provider_01",
                expiresAt: "2026-08-07T00:15:00.000Z",
            })),
            verifyWebhook: vi.fn(),
        };

        const result = await createBillingCheckoutSession(checkoutRequest, adapter);

        expect(result).toEqual(expect.objectContaining({
            status: "created",
            provider: "toss",
            checkoutSessionId: "checkout_provider_01",
        }));
        expect(result).not.toHaveProperty("currentPlan");
        expect(result).not.toHaveProperty("planTransition");
        expect(adapter.createCheckoutSession).toHaveBeenCalledWith(checkoutRequest);
    });

    it("rejects raw or unverifiable webhook payloads before a plan store is reached", async () => {
        const applyPlanTransitionOnceByEventId = vi.fn();
        const store: BillingPlanTransitionStore = { applyPlanTransitionOnceByEventId };
        const adapter: PaymentProviderAdapter = {
            key: "toss",
            createCheckoutSession: vi.fn(),
            verifyWebhook: vi.fn(async () => ({ ok: false as const, error: "invalid_signature" as const })),
        };

        await expect(processVerifiedBillingWebhook(rawWebhook, { adapter, store })).resolves.toEqual({
            status: "rejected",
            error: "invalid_signature",
        });
        expect(applyPlanTransitionOnceByEventId).not.toHaveBeenCalled();
        expect(adapter.verifyWebhook).toHaveBeenCalledWith(rawWebhook);
    });

    it("derives a server-authoritative transition only from a verified normalized envelope", async () => {
        const envelope = verifiedEnvelope();
        const applyPlanTransitionOnceByEventId = vi.fn(async (input: OrganizationPlanTransitionInput) => {
            void input;
            return { status: "applied" as const };
        });
        const store: BillingPlanTransitionStore = { applyPlanTransitionOnceByEventId };
        const adapter: PaymentProviderAdapter = {
            key: "toss",
            createCheckoutSession: vi.fn(),
            verifyWebhook: vi.fn(async () => ({ ok: true as const, envelope })),
        };

        await expect(processVerifiedBillingWebhook(rawWebhook, { adapter, store })).resolves.toEqual({
            status: "applied",
        });
        expect(applyPlanTransitionOnceByEventId).toHaveBeenCalledWith({
            eventIdempotencyKey: "toss:evt_01JABCDEF0123456789",
            provider: "toss",
            providerEventId: "evt_01JABCDEF0123456789",
            organizationId: "org_01JABCDEF0123456789",
            subscriptionId: "sub_01JABCDEF0123456789",
            subscriptionStatus: "active",
            targetPlan: "pro",
            effectiveAt: "2026-08-07T00:00:00.000Z",
            source: "verified_webhook",
        });
        expect(JSON.stringify(applyPlanTransitionOnceByEventId.mock.calls[0]?.[0])).not.toContain("providerPayload");
    });

    it("uses the provider event id as the atomic idempotency boundary", async () => {
        const applied = new Set<string>();
        const store: BillingPlanTransitionStore = {
            applyPlanTransitionOnceByEventId: vi.fn(async input => {
                if (applied.has(input.eventIdempotencyKey)) return { status: "duplicate" as const };
                applied.add(input.eventIdempotencyKey);
                return { status: "applied" as const };
            }),
        };
        const adapter: PaymentProviderAdapter = {
            key: "toss",
            createCheckoutSession: vi.fn(),
            verifyWebhook: vi.fn(async () => ({ ok: true as const, envelope: verifiedEnvelope() })),
        };

        await expect(processVerifiedBillingWebhook(rawWebhook, { adapter, store })).resolves.toEqual({ status: "applied" });
        await expect(processVerifiedBillingWebhook(rawWebhook, { adapter, store })).resolves.toEqual({ status: "duplicate" });
    });

    it("fails closed before verification when either the adapter or atomic store is missing", async () => {
        await expect(processVerifiedBillingWebhook(rawWebhook)).resolves.toEqual({
            status: "unavailable",
            error: "billing_backend_not_configured",
        });
    });
});
