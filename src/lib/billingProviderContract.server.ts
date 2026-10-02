import "next/dist/compiled/server-only";

import { createHash, createHmac } from "node:crypto";
import { types as nodeTypes } from "node:util";
import type { PlanKey } from "@/types/omr";
import type { PaymentProviderKey } from "./paymentProvider";

export type PaidPlanKey = Exclude<PlanKey, "free">;
export type BillingCycle = "monthly" | "annual";
export type BillingCurrency = "KRW";
export type SubscriptionLifecycleStatus = "trialing" | "active" | "past_due" | "canceled" | "expired";
export type SubscriptionWebhookEventType = "subscription.created" | "subscription.updated" | "subscription.canceled";
export type BillingProviderReferenceDomain = "event" | "customer" | "subscription";
export type BillingProviderReferenceKey = `hmac-sha256-v1:${string}`;
export type BillingWebhookBodyDigest = `sha256-v1:${string}`;

export const MAX_BILLING_PROVIDER_REFERENCE_BYTES = 512;
export const MAX_BILLING_WEBHOOK_BODY_BYTES = 1_048_576;
export const MAX_BILLING_EVENT_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MIN_BILLING_REFERENCE_SECRET_BYTES = 32;
const MAX_BILLING_REFERENCE_SECRET_BYTES = 256;
const SafeUint8Array = Uint8Array;
const SafeArrayBuffer = ArrayBuffer;
const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const safeReflectApply = Reflect.apply;
const TypedArrayIntrinsicPrototype = Object.getPrototypeOf(SafeUint8Array.prototype) as object;
const typedArrayBufferGetter = safeGetOwnPropertyDescriptor(TypedArrayIntrinsicPrototype, "buffer")?.get;
const typedArrayByteLengthGetter = safeGetOwnPropertyDescriptor(TypedArrayIntrinsicPrototype, "byteLength")?.get;
const typedArrayByteOffsetGetter = safeGetOwnPropertyDescriptor(TypedArrayIntrinsicPrototype, "byteOffset")?.get;
const arrayBufferByteLengthGetter = safeGetOwnPropertyDescriptor(SafeArrayBuffer.prototype, "byteLength")?.get;
const arrayBufferResizableGetter = safeGetOwnPropertyDescriptor(SafeArrayBuffer.prototype, "resizable")?.get;
const SAFE_BILLING_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const SAFE_PROVIDER_REFERENCE = /^[\x21-\x7E]+$/;
const CANONICAL_UTC_TIMESTAMP = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d\.\d{3}Z$/;

export interface CheckoutSessionRequest {
    /** Must come from the authenticated server session, never browser authority. */
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
    /** Exact bytes received by the webhook route; adapters must verify these bytes. */
    body: Readonly<Uint8Array>;
}

interface NormalizedSubscriptionWebhookEventBase {
    eventRef: string;
    eventType: SubscriptionWebhookEventType;
    occurredAt: string;
    customerRef: string;
    subscriptionRef: string;
}

export type NormalizedSubscriptionWebhookEvent = NormalizedSubscriptionWebhookEventBase & (
    | {
        subscriptionStatus: "trialing" | "active";
        priceKey: string;
    }
    | {
        subscriptionStatus: "past_due" | "canceled" | "expired";
        priceKey: null;
    }
);

/** Produced only after a provider adapter verifies the raw request signature. */
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
    /** Adapter output is unknown until the server boundary validates exact descriptors. */
    createCheckoutSession(request: CheckoutSessionRequest): Promise<unknown>;
    verifyWebhook(request: RawPaymentWebhookRequest): Promise<unknown>;
}

export interface ServerBillingPriceDescriptor {
    readonly provider: PaymentProviderKey;
    readonly priceKey: string;
    readonly plan: PaidPlanKey;
    readonly currency: BillingCurrency;
    readonly amount: number;
    readonly interval: BillingCycle;
}

function deepFreezeCatalog<T extends readonly ServerBillingPriceDescriptor[]>(catalog: T): T {
    for (const descriptor of catalog) Object.freeze(descriptor);
    return Object.freeze(catalog);
}

/**
 * Server-only logical price keys. Provider price identifiers and credentials
 * are resolved by adapters and never enter the client bundle. Amounts mirror
 * the public billing copy exactly; they are validation data, not entitlement
 * authority. The durable database slice will own atomic catalog/binding apply.
 */
export const SERVER_PRICE_CATALOG = deepFreezeCatalog([
    { provider: "toss", priceKey: "toss_pro_monthly_v1", plan: "pro", currency: "KRW", amount: 19_000, interval: "monthly" },
    { provider: "toss", priceKey: "toss_pro_annual_v1", plan: "pro", currency: "KRW", amount: 182_400, interval: "annual" },
    { provider: "toss", priceKey: "toss_academy_monthly_v1", plan: "academy", currency: "KRW", amount: 99_000, interval: "monthly" },
    { provider: "toss", priceKey: "toss_academy_annual_v1", plan: "academy", currency: "KRW", amount: 950_400, interval: "annual" },
    { provider: "naver", priceKey: "naver_pro_monthly_v1", plan: "pro", currency: "KRW", amount: 19_000, interval: "monthly" },
    { provider: "naver", priceKey: "naver_pro_annual_v1", plan: "pro", currency: "KRW", amount: 182_400, interval: "annual" },
    { provider: "naver", priceKey: "naver_academy_monthly_v1", plan: "academy", currency: "KRW", amount: 99_000, interval: "monthly" },
    { provider: "naver", priceKey: "naver_academy_annual_v1", plan: "academy", currency: "KRW", amount: 950_400, interval: "annual" },
    { provider: "kakao", priceKey: "kakao_pro_monthly_v1", plan: "pro", currency: "KRW", amount: 19_000, interval: "monthly" },
    { provider: "kakao", priceKey: "kakao_pro_annual_v1", plan: "pro", currency: "KRW", amount: 182_400, interval: "annual" },
    { provider: "kakao", priceKey: "kakao_academy_monthly_v1", plan: "academy", currency: "KRW", amount: 99_000, interval: "monthly" },
    { provider: "kakao", priceKey: "kakao_academy_annual_v1", plan: "academy", currency: "KRW", amount: 950_400, interval: "annual" },
] as const);

export interface BillingAuthorityCommand {
    readonly version: 1;
    readonly provider: PaymentProviderKey;
    readonly eventKey: BillingProviderReferenceKey;
    /** Server-owned customer binding lookup key; it is not a tenant assertion. */
    readonly customerKey: BillingProviderReferenceKey;
    readonly subscriptionKey: BillingProviderReferenceKey;
    readonly eventType: SubscriptionWebhookEventType;
    readonly occurredAt: string;
    readonly subscriptionStatus: SubscriptionLifecycleStatus;
    readonly priceKey: string | null;
    readonly webhookBodyDigest: BillingWebhookBodyDigest;
    readonly source: "verified_webhook";
}

export type BillingAuthorityStoreResult =
    | { status: "recorded" }
    /** Same event key and byte-for-byte authority command. */
    | { status: "duplicate" }
    /** Same event key but a different authority command. */
    | { status: "conflict" }
    /** New event key at or before the latest accepted subscription timestamp. */
    | { status: "out_of_order" }
    | { status: "rejected"; error: "transition_rejected" };

export interface BillingAuthorityStore {
    /**
     * Future RPC boundary. The durable store must resolve customerKey against a
     * server-owned binding, resolve priceKey through its exact catalog, and
     * record ordering/idempotency atomically. It must never accept an
     * organization id or target plan from provider payloads.
     */
    recordAuthorityCommand(command: BillingAuthorityCommand): Promise<unknown>;
}

export type BillingWebhookProcessingResult = BillingAuthorityStoreResult
    | { status: "unavailable"; error: "billing_backend_not_configured" }
    | {
        status: "rejected";
        error:
            | "invalid_signature"
            | "malformed_event"
            | "unsupported_event"
            | "invalid_verified_event"
            | "unknown_price_key"
            | "transition_store_error";
    };

type ExactSnapshot = Readonly<Record<string, unknown>>;

function descriptorSnapshot(value: unknown): ExactSnapshot | null {
    if (typeof value !== "object" || value === null || Array.isArray(value) || nodeTypes.isProxy(value)) return null;
    let prototype: object | null;
    let descriptors: PropertyDescriptorMap;
    try {
        prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) return null;
        descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
        return null;
    }

    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== "string")) return null;
    const stringKeys = keys as string[];

    const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of stringKeys) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
        snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
}

function hasExactKeys(snapshot: ExactSnapshot, expectedKeys: readonly string[]): boolean {
    const keys = Object.keys(snapshot);
    if (keys.length !== expectedKeys.length) return false;
    const expected = new Set(expectedKeys);
    return keys.every(key => expected.has(key));
}

function isProviderKey(value: unknown): value is PaymentProviderKey {
    return value === "toss" || value === "naver" || value === "kakao";
}

function isSafeId(value: unknown): value is string {
    return typeof value === "string" && SAFE_BILLING_ID.test(value);
}

function isProviderReference(value: unknown): value is string {
    if (typeof value !== "string" || !SAFE_PROVIDER_REFERENCE.test(value)) return false;
    const bytes = Buffer.byteLength(value, "utf8");
    return bytes > 0 && bytes <= MAX_BILLING_PROVIDER_REFERENCE_BYTES;
}

function isHttpsUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > 2_048 || value !== value.trim()) return false;
    try {
        const url = new URL(value);
        return url.protocol === "https:"
            && !url.username
            && !url.password
            && url.href === value;
    } catch {
        return false;
    }
}

function isCanonicalUtcTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || !CANONICAL_UTC_TIMESTAMP.test(value)) return false;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return false;
    try {
        return new Date(timestamp).toISOString() === value;
    } catch {
        return false;
    }
}

function isEventType(value: unknown): value is SubscriptionWebhookEventType {
    return value === "subscription.created"
        || value === "subscription.updated"
        || value === "subscription.canceled";
}

function isInactiveStatus(value: unknown): value is "past_due" | "canceled" | "expired" {
    return value === "past_due" || value === "canceled" || value === "expired";
}

function parseCheckoutRequest(value: unknown): CheckoutSessionRequest | null {
    const snapshot = descriptorSnapshot(value);
    if (!snapshot || !hasExactKeys(snapshot, [
        "organizationId",
        "requestedByUserId",
        "requestedPlan",
        "billingCycle",
        "successUrl",
        "cancelUrl",
        "idempotencyKey",
    ])) return null;
    if (
        !isSafeId(snapshot.organizationId)
        || !isSafeId(snapshot.requestedByUserId)
        || (snapshot.requestedPlan !== "pro" && snapshot.requestedPlan !== "academy")
        || (snapshot.billingCycle !== "monthly" && snapshot.billingCycle !== "annual")
        || !isHttpsUrl(snapshot.successUrl)
        || !isHttpsUrl(snapshot.cancelUrl)
        || !isSafeId(snapshot.idempotencyKey)
    ) return null;
    return snapshot as unknown as CheckoutSessionRequest;
}

function parseCheckoutResult(value: unknown, provider: PaymentProviderKey): CheckoutSessionResult | null {
    const snapshot = descriptorSnapshot(value);
    if (!snapshot) return null;
    if (snapshot.status === "created" && (
        hasExactKeys(snapshot, ["status", "provider", "checkoutSessionId", "redirectUrl"])
        || hasExactKeys(snapshot, ["status", "provider", "checkoutSessionId", "redirectUrl", "expiresAt"])
    )) {
        if (
            snapshot.provider !== provider
            || !isSafeId(snapshot.checkoutSessionId)
            || !isHttpsUrl(snapshot.redirectUrl)
            || ("expiresAt" in snapshot && !isCanonicalUtcTimestamp(snapshot.expiresAt))
        ) return null;
        return snapshot as unknown as CheckoutSessionResult;
    }

    if (!hasExactKeys(snapshot, ["status", "error"])) return null;
    if (
        snapshot.status === "unavailable"
        && snapshot.error === "provider_adapter_not_configured"
    ) return snapshot as unknown as CheckoutSessionResult;
    if (
        snapshot.status === "rejected"
        && (snapshot.error === "invalid_request"
            || snapshot.error === "invalid_provider_response"
            || snapshot.error === "provider_error")
    ) return snapshot as unknown as CheckoutSessionResult;
    return null;
}

export async function createBillingCheckoutSession(
    request: CheckoutSessionRequest,
    adapter?: PaymentProviderAdapter,
): Promise<CheckoutSessionResult> {
    if (!adapter) return { status: "unavailable", error: "provider_adapter_not_configured" };
    const safeRequest = parseCheckoutRequest(request);
    if (!safeRequest || !isProviderKey(adapter.key)) {
        return { status: "rejected", error: "invalid_request" };
    }
    try {
        const result = parseCheckoutResult(await adapter.createCheckoutSession(safeRequest), adapter.key);
        return result ?? { status: "rejected", error: "invalid_provider_response" };
    } catch {
        return { status: "rejected", error: "provider_error" };
    }
}

function findServerPrice(provider: PaymentProviderKey, priceKey: string): ServerBillingPriceDescriptor | undefined {
    return SERVER_PRICE_CATALOG.find(descriptor => (
        descriptor.provider === provider && descriptor.priceKey === priceKey
    ));
}

type ParsedVerification =
    | { ok: false; error: "invalid_signature" | "malformed_event" | "unsupported_event" }
    | { ok: true; envelope: VerifiedPaymentWebhookEventEnvelope };

function parseVerificationResult(value: unknown): ParsedVerification | null {
    const result = descriptorSnapshot(value);
    if (!result) return null;
    if (result.ok === false && hasExactKeys(result, ["ok", "error"]) && (
        result.error === "invalid_signature"
        || result.error === "malformed_event"
        || result.error === "unsupported_event"
    )) return result as ParsedVerification;

    if (result.ok !== true || !hasExactKeys(result, ["ok", "envelope"])) return null;
    const envelope = descriptorSnapshot(result.envelope);
    if (
        !envelope
        || !hasExactKeys(envelope, ["signatureVerified", "provider", "event"])
        || envelope.signatureVerified !== true
        || !isProviderKey(envelope.provider)
    ) return null;
    return {
        ok: true,
        envelope: {
            signatureVerified: true,
            provider: envelope.provider,
            event: envelope.event as NormalizedSubscriptionWebhookEvent,
        },
    };
}

type ParsedEventResult =
    | { ok: true; event: NormalizedSubscriptionWebhookEvent }
    | { ok: false; error: "invalid_verified_event" | "unknown_price_key" };

function parseNormalizedEvent(
    value: unknown,
    provider: PaymentProviderKey,
    receivedAtMs: number,
): ParsedEventResult {
    const snapshot = descriptorSnapshot(value);
    if (!snapshot || !hasExactKeys(snapshot, [
        "eventRef",
        "eventType",
        "occurredAt",
        "customerRef",
        "subscriptionRef",
        "subscriptionStatus",
        "priceKey",
    ])) return { ok: false, error: "invalid_verified_event" };
    if (
        !isProviderReference(snapshot.eventRef)
        || !isEventType(snapshot.eventType)
        || !isCanonicalUtcTimestamp(snapshot.occurredAt)
        || Date.parse(snapshot.occurredAt) > receivedAtMs + MAX_BILLING_EVENT_FUTURE_SKEW_MS
        || !isProviderReference(snapshot.customerRef)
        || !isProviderReference(snapshot.subscriptionRef)
    ) return { ok: false, error: "invalid_verified_event" };

    if (snapshot.subscriptionStatus === "active" || snapshot.subscriptionStatus === "trialing") {
        if (!isSafeId(snapshot.priceKey)) return { ok: false, error: "invalid_verified_event" };
        if (!findServerPrice(provider, snapshot.priceKey)) return { ok: false, error: "unknown_price_key" };
        return { ok: true, event: snapshot as unknown as NormalizedSubscriptionWebhookEvent };
    }
    if (!isInactiveStatus(snapshot.subscriptionStatus) || snapshot.priceKey !== null) {
        return { ok: false, error: "invalid_verified_event" };
    }
    return { ok: true, event: snapshot as unknown as NormalizedSubscriptionWebhookEvent };
}

function copyFixedUint8Array(
    value: unknown,
    minimumBytes: number,
    maximumBytes: number,
    error: string,
): Uint8Array {
    if (!(value instanceof SafeUint8Array) || nodeTypes.isProxy(value)) {
        throw new Error(error);
    }
    for (const key of ["buffer", "byteLength", "byteOffset"] as const) {
        if (safeGetOwnPropertyDescriptor(value, key)) throw new Error(error);
    }
    if (
        !typedArrayBufferGetter
        || !typedArrayByteLengthGetter
        || !typedArrayByteOffsetGetter
        || !arrayBufferByteLengthGetter
        || !arrayBufferResizableGetter
    ) throw new Error(error);

    let buffer: ArrayBuffer;
    let byteLength: number;
    let byteOffset: number;
    let bufferByteLength: number;
    let resizable: boolean;
    try {
        buffer = safeReflectApply(typedArrayBufferGetter, value, []) as ArrayBuffer;
        byteLength = safeReflectApply(typedArrayByteLengthGetter, value, []) as number;
        byteOffset = safeReflectApply(typedArrayByteOffsetGetter, value, []) as number;
    } catch {
        throw new Error(error);
    }
    if (!(buffer instanceof SafeArrayBuffer) || nodeTypes.isProxy(buffer)) throw new Error(error);
    for (const key of ["byteLength", "resizable", "maxByteLength"] as const) {
        if (safeGetOwnPropertyDescriptor(buffer, key)) throw new Error(error);
    }
    try {
        bufferByteLength = safeReflectApply(arrayBufferByteLengthGetter, buffer, []) as number;
        resizable = safeReflectApply(arrayBufferResizableGetter, buffer, []) as boolean;
    } catch {
        throw new Error(error);
    }
    if (resizable
        || byteLength < minimumBytes
        || byteLength > maximumBytes
        || byteOffset < 0
        || byteOffset + byteLength > bufferByteLength) {
        throw new Error(error);
    }
    try {
        const copy = new SafeUint8Array(value);
        const copiedByteLength = safeReflectApply(typedArrayByteLengthGetter, copy, []) as number;
        if (copiedByteLength !== byteLength) throw new Error(error);
        return copy;
    } catch {
        throw new Error(error);
    }
}

function assertReferenceSecret(secret: Readonly<Uint8Array>): Uint8Array {
    return copyFixedUint8Array(
        secret,
        MIN_BILLING_REFERENCE_SECRET_BYTES,
        MAX_BILLING_REFERENCE_SECRET_BYTES,
        "billing_reference_secret_invalid",
    );
}

export function hashBillingProviderReference(
    secret: Readonly<Uint8Array>,
    provider: PaymentProviderKey,
    domain: BillingProviderReferenceDomain,
    reference: string,
): BillingProviderReferenceKey {
    const secretBytes = assertReferenceSecret(secret);
    if (!isProviderKey(provider)
        || (domain !== "event" && domain !== "customer" && domain !== "subscription")
        || !isProviderReference(reference)) {
        throw new Error("billing_provider_reference_invalid");
    }
    const referenceBytes = Buffer.from(reference, "utf8");
    const digest = createHmac("sha256", secretBytes)
        .update("omr.billing.provider-reference.v1\0", "utf8")
        .update(domain, "utf8")
        .update("\0", "utf8")
        .update(provider, "utf8")
        .update("\0", "utf8")
        .update(String(referenceBytes.byteLength), "utf8")
        .update("\0", "utf8")
        .update(referenceBytes)
        .digest("hex");
    return `hmac-sha256-v1:${digest}`;
}

function snapshotRawWebhook(request: RawPaymentWebhookRequest): RawPaymentWebhookRequest | null {
    const requestSnapshot = descriptorSnapshot(request);
    if (!requestSnapshot || !hasExactKeys(requestSnapshot, ["headers", "body"])) return null;
    const headerSnapshot = descriptorSnapshot(requestSnapshot.headers);
    if (!headerSnapshot) return null;
    let body: Uint8Array;
    try {
        body = copyFixedUint8Array(
            requestSnapshot.body,
            1,
            MAX_BILLING_WEBHOOK_BODY_BYTES,
            "billing_webhook_body_invalid",
        );
    } catch {
        return null;
    }
    const headers: Record<string, string | undefined> = Object.create(null) as Record<string, string | undefined>;
    for (const [key, value] of Object.entries(headerSnapshot)) {
        if (typeof value !== "string" && value !== undefined) return null;
        headers[key] = value;
    }
    return Object.freeze({
        headers: Object.freeze(headers),
        body,
    });
}

function bodyDigest(body: Readonly<Uint8Array>): BillingWebhookBodyDigest {
    return `sha256-v1:${createHash("sha256").update(body).digest("hex")}`;
}

function buildAuthorityCommand(
    provider: PaymentProviderKey,
    event: NormalizedSubscriptionWebhookEvent,
    webhookBodyDigest: BillingWebhookBodyDigest,
    secret: Readonly<Uint8Array>,
): BillingAuthorityCommand {
    return Object.freeze({
        version: 1,
        provider,
        eventKey: hashBillingProviderReference(secret, provider, "event", event.eventRef),
        customerKey: hashBillingProviderReference(secret, provider, "customer", event.customerRef),
        subscriptionKey: hashBillingProviderReference(secret, provider, "subscription", event.subscriptionRef),
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        subscriptionStatus: event.subscriptionStatus,
        priceKey: event.priceKey,
        webhookBodyDigest,
        source: "verified_webhook",
    });
}

function parseStoreResult(value: unknown): BillingAuthorityStoreResult | null {
    const result = descriptorSnapshot(value);
    if (!result) return null;
    if (hasExactKeys(result, ["status"]) && (
        result.status === "recorded"
        || result.status === "duplicate"
        || result.status === "conflict"
        || result.status === "out_of_order"
    )) return result as BillingAuthorityStoreResult;

    if (
        hasExactKeys(result, ["status", "error"])
        && result.status === "rejected"
        && result.error === "transition_rejected"
    ) {
        return result as BillingAuthorityStoreResult;
    }
    return null;
}

export async function processVerifiedBillingWebhook(
    request: RawPaymentWebhookRequest,
    dependencies?: {
        adapter: PaymentProviderAdapter;
        store: BillingAuthorityStore;
        referenceSecret: Readonly<Uint8Array>;
    },
): Promise<BillingWebhookProcessingResult> {
    if (!dependencies?.adapter || !dependencies.store || !dependencies.referenceSecret) {
        return { status: "unavailable", error: "billing_backend_not_configured" };
    }
    let referenceSecret: Uint8Array;
    try {
        referenceSecret = assertReferenceSecret(dependencies.referenceSecret);
    } catch {
        return { status: "unavailable", error: "billing_backend_not_configured" };
    }
    const provider = dependencies.adapter.key;
    if (!isProviderKey(provider)) return { status: "rejected", error: "invalid_verified_event" };
    const safeRequest = snapshotRawWebhook(request);
    if (!safeRequest) return { status: "rejected", error: "malformed_event" };
    const receivedAtMs = Date.now();
    const webhookBodyDigest = bodyDigest(safeRequest.body);

    let verification: ParsedVerification | null;
    try {
        verification = parseVerificationResult(await dependencies.adapter.verifyWebhook(safeRequest));
    } catch {
        return { status: "rejected", error: "invalid_signature" };
    }
    if (!verification) return { status: "rejected", error: "invalid_verified_event" };
    if (!verification.ok) return { status: "rejected", error: verification.error };
    if (verification.envelope.provider !== provider) {
        return { status: "rejected", error: "invalid_verified_event" };
    }

    const parsed = parseNormalizedEvent(verification.envelope.event, provider, receivedAtMs);
    if (!parsed.ok) return { status: "rejected", error: parsed.error };

    let command: BillingAuthorityCommand;
    try {
        command = buildAuthorityCommand(
            provider,
            parsed.event,
            webhookBodyDigest,
            referenceSecret,
        );
    } catch {
        return { status: "rejected", error: "invalid_verified_event" };
    }

    try {
        const result = parseStoreResult(await dependencies.store.recordAuthorityCommand(command));
        return result ?? { status: "rejected", error: "transition_store_error" };
    } catch {
        return { status: "rejected", error: "transition_store_error" };
    }
}
