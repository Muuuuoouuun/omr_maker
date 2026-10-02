import "next/dist/compiled/server-only";

import type {
    BillingAuthorityCommand,
    BillingAuthorityStore,
    BillingAuthorityStoreResult,
    CheckoutSessionRequest,
    PaymentProviderAdapter,
    RawPaymentWebhookRequest,
} from "./billingProviderContract.server";
import type { PaymentProviderKey } from "./paymentProvider";

function assertTestFakeRuntime(): void {
    if (process.env.NODE_ENV === "production") {
        throw new Error("billing_test_fake_forbidden_in_production");
    }
}

export interface FakePaymentProviderAdapter extends PaymentProviderAdapter {
    readonly calls: {
        checkout: CheckoutSessionRequest[];
        webhook: RawPaymentWebhookRequest[];
    };
}

export function createFakePaymentProviderAdapter(config: {
    provider: PaymentProviderKey;
    checkoutResult?: unknown;
    verificationResult?: unknown;
}): FakePaymentProviderAdapter {
    assertTestFakeRuntime();
    const calls = {
        checkout: [] as CheckoutSessionRequest[],
        webhook: [] as RawPaymentWebhookRequest[],
    };
    return {
        key: config.provider,
        calls,
        async createCheckoutSession(request) {
            calls.checkout.push(request);
            return config.checkoutResult ?? { status: "unavailable", error: "provider_adapter_not_configured" };
        },
        async verifyWebhook(request) {
            calls.webhook.push(request);
            return config.verificationResult ?? { ok: false, error: "unsupported_event" };
        },
    };
}

export interface FakeBillingAuthorityStore extends BillingAuthorityStore {
    /** Every command that reached the store, including rejected attempts. */
    readonly attempts: BillingAuthorityCommand[];
    /** Commands accepted as the latest durable simulation state. */
    readonly recorded: BillingAuthorityCommand[];
}

function exactCommandFingerprint(command: BillingAuthorityCommand): string {
    return JSON.stringify(command);
}

export function createFakeBillingAuthorityStore(): FakeBillingAuthorityStore {
    assertTestFakeRuntime();
    const attempts: BillingAuthorityCommand[] = [];
    const recorded: BillingAuthorityCommand[] = [];
    const byEventKey = new Map<string, string>();
    const latestTimestampBySubscription = new Map<string, string>();

    return {
        attempts,
        recorded,
        async recordAuthorityCommand(command): Promise<BillingAuthorityStoreResult> {
            attempts.push(command);
            const fingerprint = exactCommandFingerprint(command);
            const existing = byEventKey.get(command.eventKey);
            if (existing !== undefined) {
                return existing === fingerprint ? { status: "duplicate" } : { status: "conflict" };
            }

            const latest = latestTimestampBySubscription.get(command.subscriptionKey);
            if (latest !== undefined && command.occurredAt <= latest) return { status: "out_of_order" };

            byEventKey.set(command.eventKey, fingerprint);
            latestTimestampBySubscription.set(command.subscriptionKey, command.occurredAt);
            recorded.push(command);
            return { status: "recorded" };
        },
    };
}
