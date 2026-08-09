import { afterEach, describe, expect, it, vi } from "vitest";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
    MAX_BILLING_PROVIDER_REFERENCE_BYTES,
    SERVER_PRICE_CATALOG,
    createBillingCheckoutSession,
    hashBillingProviderReference,
    processVerifiedBillingWebhook,
    type BillingAuthorityCommand,
    type BillingAuthorityStore,
    type PaymentProviderAdapter,
    type RawPaymentWebhookRequest,
    type VerifiedPaymentWebhookEventEnvelope,
} from "./billingProviderContract.server";
import {
    createFakeBillingAuthorityStore,
    createFakePaymentProviderAdapter,
} from "./billingProviderContract.fake.server";
import { PLAN_BY_KEY } from "@/utils/plans";

const REFERENCE_SECRET = new TextEncoder().encode("test-only-billing-reference-secret-32-bytes");

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
    body: new TextEncoder().encode('{"providerPayload":"untrusted"}'),
};

afterEach(() => {
    vi.unstubAllEnvs();
});

function verifiedEnvelope(
    overrides: Readonly<Record<string, unknown>> = {},
): VerifiedPaymentWebhookEventEnvelope {
    return {
        signatureVerified: true,
        provider: "toss",
        event: {
            eventRef: "evt_01JABCDEF0123456789",
            eventType: "subscription.updated",
            occurredAt: "2026-08-07T00:00:00.000Z",
            customerRef: "customer_01JABCDEF0123456789",
            subscriptionRef: "subscription_01JABCDEF0123456789",
            subscriptionStatus: "active",
            priceKey: "toss_pro_monthly_v1",
            ...overrides,
        },
    };
}

function dependencies(params: {
    envelope?: unknown;
    store?: BillingAuthorityStore;
    adapter?: PaymentProviderAdapter;
} = {}) {
    const adapter = params.adapter ?? createFakePaymentProviderAdapter({
        provider: "toss",
        verificationResult: { ok: true, envelope: params.envelope ?? verifiedEnvelope() },
    });
    return {
        adapter,
        store: params.store ?? createFakeBillingAuthorityStore(),
        referenceSecret: REFERENCE_SECRET,
    };
}

describe("provider-neutral billing server authority", () => {
    it("fails closed when no checkout provider adapter is configured", async () => {
        await expect(createBillingCheckoutSession(checkoutRequest)).resolves.toEqual({
            status: "unavailable",
            error: "provider_adapter_not_configured",
        });
    });

    it("returns purchase intent only and never treats checkout as entitlement authority", async () => {
        const adapter = createFakePaymentProviderAdapter({
            provider: "toss",
            checkoutResult: {
                status: "created",
                provider: "toss",
                checkoutSessionId: "checkout_provider_01",
                redirectUrl: "https://pay.example/checkout/checkout_provider_01",
                expiresAt: "2026-08-07T00:15:00.000Z",
            },
        });

        const result = await createBillingCheckoutSession(checkoutRequest, adapter);

        expect(result).toEqual(expect.objectContaining({
            status: "created",
            provider: "toss",
            checkoutSessionId: "checkout_provider_01",
        }));
        expect(result).not.toHaveProperty("currentPlan");
        expect(result).not.toHaveProperty("planTransition");
        expect(adapter.calls.checkout).toHaveLength(1);
        expect(adapter.calls.checkout[0]).not.toBe(checkoutRequest);
        expect(Object.isFrozen(adapter.calls.checkout[0])).toBe(true);
    });

    it("snapshots checkout authority once and rejects getters, proxies, and extras", async () => {
        const adapter = createFakePaymentProviderAdapter({ provider: "toss" });
        const organizationGetter = vi.fn(() => checkoutRequest.organizationId);
        const accessorRequest = { ...checkoutRequest };
        Object.defineProperty(accessorRequest, "organizationId", {
            enumerable: true,
            get: organizationGetter,
        });

        for (const request of [
            accessorRequest,
            new Proxy({ ...checkoutRequest }, {}),
            { ...checkoutRequest, targetPlan: "academy" },
        ]) {
            await expect(createBillingCheckoutSession(
                request as typeof checkoutRequest,
                adapter,
            )).resolves.toEqual({ status: "rejected", error: "invalid_request" });
        }
        expect(organizationGetter).not.toHaveBeenCalled();
        expect(adapter.calls.checkout).toHaveLength(0);
    });

    it("keeps the exact server catalog deeply frozen and aligned with public UI prices", () => {
        expect(Object.isFrozen(SERVER_PRICE_CATALOG)).toBe(true);
        expect(SERVER_PRICE_CATALOG.length).toBeGreaterThan(0);
        for (const descriptor of SERVER_PRICE_CATALOG) {
            expect(Object.isFrozen(descriptor)).toBe(true);
            const monthly = PLAN_BY_KEY[descriptor.plan].priceNum;
            expect(descriptor.currency).toBe("KRW");
            expect(descriptor.amount).toBe(
                descriptor.interval === "monthly"
                    ? monthly
                    : Math.round(monthly * 12 * 0.8),
            );
        }
        expect(new Set(SERVER_PRICE_CATALOG.map(item => `${item.provider}:${item.priceKey}`)).size)
            .toBe(SERVER_PRICE_CATALOG.length);
    });

    it("derives an RPC/store-ready command without payload tenant or target-plan authority", async () => {
        let received: BillingAuthorityCommand | undefined;
        const store: BillingAuthorityStore = {
            recordAuthorityCommand: vi.fn(async command => {
                received = command;
                return { status: "recorded" as const };
            }),
        };

        await expect(processVerifiedBillingWebhook(rawWebhook, dependencies({ store }))).resolves.toEqual({
            status: "recorded",
        });

        expect(received).toEqual({
            version: 1,
            provider: "toss",
            eventKey: expect.stringMatching(/^hmac-sha256-v1:[a-f0-9]{64}$/),
            customerKey: expect.stringMatching(/^hmac-sha256-v1:[a-f0-9]{64}$/),
            subscriptionKey: expect.stringMatching(/^hmac-sha256-v1:[a-f0-9]{64}$/),
            eventType: "subscription.updated",
            occurredAt: "2026-08-07T00:00:00.000Z",
            subscriptionStatus: "active",
            priceKey: "toss_pro_monthly_v1",
            webhookBodyDigest: expect.stringMatching(/^sha256-v1:[a-f0-9]{64}$/),
            source: "verified_webhook",
        });
        expect(received).not.toHaveProperty("organizationId");
        expect(received).not.toHaveProperty("targetPlan");
        expect(JSON.stringify(received)).not.toContain("evt_01JABCDEF0123456789");
        expect(JSON.stringify(received)).not.toContain("customer_01JABCDEF0123456789");
        expect(JSON.stringify(received)).not.toContain("subscription_01JABCDEF0123456789");
    });

    it("requires an exact catalog price key for active or trialing events", async () => {
        for (const subscriptionStatus of ["active", "trialing"] as const) {
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope: verifiedEnvelope({ subscriptionStatus, priceKey: null }) }),
            )).resolves.toEqual({ status: "rejected", error: "invalid_verified_event" });

            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope: verifiedEnvelope({ subscriptionStatus, priceKey: "unknown_price" }) }),
            )).resolves.toEqual({ status: "rejected", error: "unknown_price_key" });
        }
    });

    it("requires null priceKey for non-entitling lifecycle states", async () => {
        for (const subscriptionStatus of ["past_due", "canceled", "expired"] as const) {
            const store = createFakeBillingAuthorityStore();
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope: verifiedEnvelope({ subscriptionStatus, priceKey: null }), store }),
            )).resolves.toEqual({ status: "recorded" });

            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope: verifiedEnvelope({ subscriptionStatus, priceKey: "toss_pro_monthly_v1" }) }),
            )).resolves.toEqual({ status: "rejected", error: "invalid_verified_event" });
        }
    });

    it("rejects tenant and target-plan assertions even inside a signed provider envelope", async () => {
        for (const authorityClaim of [
            { organizationId: "org_attacker" },
            { targetPlan: "academy" },
        ]) {
            const store = createFakeBillingAuthorityStore();
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope: verifiedEnvelope(authorityClaim), store }),
            )).resolves.toEqual({ status: "rejected", error: "invalid_verified_event" });
            expect(store.attempts).toHaveLength(0);
        }
    });

    it("accepts only canonical UTC timestamps without trimming or coercion", async () => {
        for (const occurredAt of [
            " 2026-08-07T00:00:00.000Z",
            "2026-08-07T00:00:00Z",
            "2026-08-07T09:00:00.000+09:00",
            "2026-02-30T00:00:00.000Z",
            "9999-12-31T23:59:59.999Z",
            1_786_060_800_000,
        ]) {
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope: verifiedEnvelope({ occurredAt }) }),
            )).resolves.toEqual({ status: "rejected", error: "invalid_verified_event" });
        }
    });

    it("rejects extra keys, accessors, and proxies before the store boundary", async () => {
        const accessorEvent = verifiedEnvelope().event as unknown as Record<string, unknown>;
        const eventRefGetter = vi.fn(() => "evt_accessor");
        Object.defineProperty(accessorEvent, "eventRef", {
            enumerable: true,
            get: eventRefGetter,
        });

        const proxyEnvelope = new Proxy(verifiedEnvelope(), {});
        for (const envelope of [
            verifiedEnvelope({ extra: "not-allowed" }),
            { ...verifiedEnvelope(), event: accessorEvent },
            proxyEnvelope,
        ]) {
            const store = createFakeBillingAuthorityStore();
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ envelope, store }),
            )).resolves.toEqual({ status: "rejected", error: "invalid_verified_event" });
            expect(store.attempts).toHaveLength(0);
        }
        expect(eventRefGetter).not.toHaveBeenCalled();
    });

    it("reads each normalized event field once through descriptors, never property access", async () => {
        const event = verifiedEnvelope().event as unknown as Record<string, unknown>;
        const fieldReads = new Map<string, number>();
        const oneReadEvent = new Proxy(event, {
            getOwnPropertyDescriptor(target, property) {
                const key = String(property);
                fieldReads.set(key, (fieldReads.get(key) ?? 0) + 1);
                return Reflect.getOwnPropertyDescriptor(target, property);
            },
        });

        await expect(processVerifiedBillingWebhook(
            rawWebhook,
            dependencies({ envelope: { ...verifiedEnvelope(), event: oneReadEvent } }),
        )).resolves.toEqual({ status: "rejected", error: "invalid_verified_event" });
        expect([...fieldReads.values()].every(count => count <= 1)).toBe(true);
    });

    it("takes exactly one descriptor snapshot per adapter envelope object", async () => {
        const envelope = verifiedEnvelope();
        const verificationResult = { ok: true, envelope };
        const adapter = createFakePaymentProviderAdapter({
            provider: "toss",
            verificationResult,
        });
        const descriptorSpy = vi.spyOn(Object, "getOwnPropertyDescriptors");

        try {
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ adapter }),
            )).resolves.toEqual({ status: "recorded" });
            for (const object of [verificationResult, envelope, envelope.event]) {
                expect(descriptorSpy.mock.calls.filter(([candidate]) => candidate === object)).toHaveLength(1);
            }
        } finally {
            descriptorSpy.mockRestore();
        }
    });

    it("domain-separates opaque provider references with an explicit bounded secret", () => {
        const eventKey = hashBillingProviderReference(REFERENCE_SECRET, "toss", "event", "same-ref");
        const customerKey = hashBillingProviderReference(REFERENCE_SECRET, "toss", "customer", "same-ref");
        const subscriptionKey = hashBillingProviderReference(REFERENCE_SECRET, "toss", "subscription", "same-ref");
        const otherProviderKey = hashBillingProviderReference(REFERENCE_SECRET, "naver", "event", "same-ref");

        expect(eventKey).toMatch(/^hmac-sha256-v1:[a-f0-9]{64}$/);
        expect(new Set([eventKey, customerKey, subscriptionKey, otherProviderKey]).size).toBe(4);
        expect(eventKey).not.toContain("same-ref");
        expect(() => hashBillingProviderReference(
            new Uint8Array(8),
            "toss",
            "event",
            "same-ref",
        )).toThrowError("billing_reference_secret_invalid");
        expect(() => hashBillingProviderReference(
            REFERENCE_SECRET,
            "toss",
            "event",
            "x".repeat(MAX_BILLING_PROVIDER_REFERENCE_BYTES + 1),
        )).toThrowError("billing_provider_reference_invalid");
        expect(hashBillingProviderReference(
            Buffer.from(REFERENCE_SECRET),
            "toss",
            "event",
            "same-ref",
        )).toBe(eventKey);
    });

    it("specifies deterministic duplicate, conflict, and out-of-order semantics", async () => {
        const store = createFakeBillingAuthorityStore();
        const base = dependencies({ store });

        await expect(processVerifiedBillingWebhook(rawWebhook, base)).resolves.toEqual({ status: "recorded" });
        await expect(processVerifiedBillingWebhook(rawWebhook, base)).resolves.toEqual({ status: "duplicate" });

        await expect(processVerifiedBillingWebhook(rawWebhook, dependencies({
            store,
            envelope: verifiedEnvelope({ subscriptionStatus: "past_due", priceKey: null }),
        }))).resolves.toEqual({ status: "conflict" });

        await expect(processVerifiedBillingWebhook(rawWebhook, dependencies({
            store,
            envelope: verifiedEnvelope({
                eventRef: "evt_older",
                occurredAt: "2026-08-06T23:59:59.999Z",
            }),
        }))).resolves.toEqual({ status: "out_of_order" });
    });

    it("copies exact raw bytes once, rejects mutable buffer variants, and never invokes request accessors", async () => {
        const bodyGetter = vi.fn(() => rawWebhook.body);
        const accessorRequest = { headers: rawWebhook.headers } as Record<string, unknown>;
        Object.defineProperty(accessorRequest, "body", {
            enumerable: true,
            get: bodyGetter,
        });
        await expect(processVerifiedBillingWebhook(
            accessorRequest as unknown as RawPaymentWebhookRequest,
            dependencies(),
        )).resolves.toEqual({ status: "rejected", error: "malformed_event" });
        expect(bodyGetter).not.toHaveBeenCalled();

        const sharedBody = new Uint8Array(new SharedArrayBuffer(8));
        await expect(processVerifiedBillingWebhook(
            { headers: {}, body: sharedBody },
            dependencies(),
        )).resolves.toEqual({ status: "rejected", error: "malformed_event" });

        const shadowedSharedBody = new Uint8Array(new SharedArrayBuffer(8));
        const bufferGetter = vi.fn(() => new ArrayBuffer(8));
        Object.defineProperty(shadowedSharedBody, "buffer", {
            configurable: true,
            get: bufferGetter,
        });
        await expect(processVerifiedBillingWebhook(
            { headers: {}, body: shadowedSharedBody },
            dependencies(),
        )).resolves.toEqual({ status: "rejected", error: "malformed_event" });
        expect(bufferGetter).not.toHaveBeenCalled();

        const detachedBuffer = new ArrayBuffer(8);
        const detachedBody = new Uint8Array(detachedBuffer);
        structuredClone(detachedBuffer, { transfer: [detachedBuffer] });
        await expect(processVerifiedBillingWebhook(
            { headers: {}, body: detachedBody },
            dependencies(),
        )).resolves.toEqual({ status: "rejected", error: "malformed_event" });

        const resizableBuffer = new ArrayBuffer(8, { maxByteLength: 16 });
        const resizableGetter = vi.fn(() => false);
        Object.defineProperty(resizableBuffer, "resizable", {
            configurable: true,
            get: resizableGetter,
        });
        const resizableBody = new Uint8Array(resizableBuffer);
        await expect(processVerifiedBillingWebhook(
            { headers: {}, body: resizableBody },
            dependencies(),
        )).resolves.toEqual({ status: "rejected", error: "malformed_event" });
        expect(resizableGetter).not.toHaveBeenCalled();

        const adapter = createFakePaymentProviderAdapter({
            provider: "toss",
            verificationResult: { ok: true, envelope: verifiedEnvelope() },
        });
        const originalFrom = Uint8Array.from;
        Uint8Array.from = vi.fn(() => {
            throw new Error("overridable_copy_path_used");
        }) as typeof Uint8Array.from;
        try {
            await expect(processVerifiedBillingWebhook(
                rawWebhook,
                dependencies({ adapter }),
            )).resolves.toEqual({ status: "recorded" });
            expect(adapter.calls.webhook).toHaveLength(1);
            expect(adapter.calls.webhook[0]?.body).not.toBe(rawWebhook.body);
        } finally {
            Uint8Array.from = originalFrom;
        }
    });

    it("isolates the adapter and digest from mutation of the caller's raw byte view", async () => {
        const originalBody = new TextEncoder().encode("exact-provider-payload");
        const originalBytes = [...originalBody];
        const expectedDigest = `sha256-v1:${createHash("sha256").update(originalBody).digest("hex")}`;
        let releaseVerification: ((value: unknown) => void) | undefined;
        let adapterBody: Readonly<Uint8Array> | undefined;
        const adapter: PaymentProviderAdapter = {
            key: "toss",
            async createCheckoutSession() {
                return { status: "unavailable", error: "provider_adapter_not_configured" };
            },
            verifyWebhook(request) {
                adapterBody = request.body;
                return new Promise(resolve => { releaseVerification = resolve; });
            },
        };
        let command: BillingAuthorityCommand | undefined;
        const store: BillingAuthorityStore = {
            async recordAuthorityCommand(input) {
                command = input;
                return { status: "recorded" };
            },
        };

        const processing = processVerifiedBillingWebhook(
            { headers: {}, body: originalBody },
            { adapter, store, referenceSecret: REFERENCE_SECRET },
        );
        originalBody.fill(0);
        releaseVerification?.({ ok: true, envelope: verifiedEnvelope() });

        await expect(processing).resolves.toEqual({ status: "recorded" });
        expect([...(adapterBody ?? [])]).toEqual(originalBytes);
        expect(command?.webhookBodyDigest).toBe(expectedDigest);
    });

    it("makes deterministic fake adapters and stores fail closed in production", () => {
        vi.stubEnv("NODE_ENV", "production");
        expect(() => createFakePaymentProviderAdapter({ provider: "toss" }))
            .toThrowError("billing_test_fake_forbidden_in_production");
        expect(() => createFakeBillingAuthorityStore())
            .toThrowError("billing_test_fake_forbidden_in_production");
    });

    it("fails closed before verification when adapter, store, or secret is missing", async () => {
        await expect(processVerifiedBillingWebhook(rawWebhook)).resolves.toEqual({
            status: "unavailable",
            error: "billing_backend_not_configured",
        });

        const adapter = createFakePaymentProviderAdapter({
            provider: "toss",
            verificationResult: { ok: true, envelope: verifiedEnvelope() },
        });
        await expect(processVerifiedBillingWebhook(rawWebhook, {
            adapter,
            store: createFakeBillingAuthorityStore(),
            referenceSecret: new Uint8Array(16),
        })).resolves.toEqual({
            status: "unavailable",
            error: "billing_backend_not_configured",
        });
        expect(adapter.calls.webhook).toHaveLength(0);

        const shadowedSharedSecret = new Uint8Array(new SharedArrayBuffer(32));
        const secretBufferGetter = vi.fn(() => new ArrayBuffer(32));
        Object.defineProperty(shadowedSharedSecret, "buffer", {
            configurable: true,
            get: secretBufferGetter,
        });
        await expect(processVerifiedBillingWebhook(rawWebhook, {
            adapter,
            store: createFakeBillingAuthorityStore(),
            referenceSecret: shadowedSharedSecret,
        })).resolves.toEqual({
            status: "unavailable",
            error: "billing_backend_not_configured",
        });
        expect(secretBufferGetter).not.toHaveBeenCalled();
        expect(adapter.calls.webhook).toHaveLength(0);
    });
});
