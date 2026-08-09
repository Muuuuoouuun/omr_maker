import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_CHECKOUT_IMPLEMENTED, isLiveCheckoutUiEnabled } from "./billingCheckoutGate";

const publicProvider = readFileSync(new URL("./paymentProvider.ts", import.meta.url), "utf8");
const serverContract = readFileSync(new URL("./billingProviderContract.server.ts", import.meta.url), "utf8");
const billingPage = readFileSync(new URL("../app/teacher/billing/page.tsx", import.meta.url), "utf8");

function productionTypeScriptFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return productionTypeScriptFiles(path);
        if (![".ts", ".tsx"].includes(extname(entry.name))) return [];
        if (entry.name.includes(".test.")) return [];
        return [path];
    });
}

describe("billing provider module boundary", () => {
    it("keeps client-imported provider code limited to public key, config, and readiness", () => {
        for (const serverOnlyTerm of [
            "PaymentProviderAdapter",
            "RawPaymentWebhookRequest",
            "NormalizedSubscriptionWebhookEvent",
            "VerifiedPaymentWebhookEventEnvelope",
            "BillingAuthorityStore",
            "organizationId",
            "targetPlan",
            "priceKey",
            "node:crypto",
        ]) {
            expect(publicProvider).not.toContain(serverOnlyTerm);
        }
        expect(publicProvider).toContain("PaymentProviderKey");
        expect(publicProvider).toContain("PaymentProviderConfig");
        expect(publicProvider).toContain("getPaymentProviderReadiness");
    });

    it("compiler-poisons the adapter, webhook, event, catalog, and store contract", () => {
        expect(serverContract.startsWith('import "next/dist/compiled/server-only";')).toBe(true);
        expect(serverContract).toContain("PaymentProviderAdapter");
        expect(serverContract).toContain("BillingAuthorityStore");
        expect(serverContract).toContain("SERVER_PRICE_CATALOG");
        expect(billingPage).not.toContain("billingProviderContract.server");
    });

    it("has no production call site for deterministic billing fakes", () => {
        const sourceRoot = new URL("..", import.meta.url).pathname;
        const callSites = productionTypeScriptFiles(sourceRoot)
            .filter(path => !path.endsWith("billingProviderContract.fake.server.ts"))
            .filter(path => readFileSync(path, "utf8").includes("billingProviderContract.fake.server"));
        expect(callSites).toEqual([]);
    });

    it("keeps live checkout and every billing CTA disabled", () => {
        expect(LIVE_CHECKOUT_IMPLEMENTED).toBe(false);
        expect(isLiveCheckoutUiEnabled(true)).toBe(false);
        expect(isLiveCheckoutUiEnabled(false)).toBe(false);
    });
});
