import { existsSync, readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_CHECKOUT_IMPLEMENTED, isLiveCheckoutUiEnabled } from "./billingCheckoutGate";

const publicProvider = readFileSync(new URL("./paymentProvider.ts", import.meta.url), "utf8");
const serverContract = readFileSync(new URL("./billingProviderContract.server.ts", import.meta.url), "utf8");
const billingPage = readFileSync(new URL("../app/teacher/billing/page.tsx", import.meta.url), "utf8");
const releaseDesign = readFileSync(join(
    process.cwd(),
    "docs/superpowers/specs/2026-08-08-initial-operations-100-release-design.md",
), "utf8");
const releaseMasterPlan = readFileSync(join(
    process.cwd(),
    "docs/superpowers/plans/2026-08-08-initial-operations-100-release-master.md",
), "utf8");
const executionPlanSection = releaseMasterPlan.slice(
    releaseMasterPlan.indexOf("## Execution plans"),
    releaseMasterPlan.indexOf("## Dependency graph"),
);
const referencedExecutionPlanPaths = Array.from(
    executionPlanSection.matchAll(/`(docs\/superpowers\/plans\/[^`]+\.md)`/g),
    match => match[1],
);
const referencedExecutionPlans = new Map(referencedExecutionPlanPaths.map(path => [
    path,
    readFileSync(join(process.cwd(), path), "utf8"),
]));
const billingBoundaryPlan = referencedExecutionPlans.get(
    "docs/superpowers/plans/2026-08-08-billing-connection-boundary.md",
) || "";

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

    it("keeps the initial release billing scope to an unused server-only seam", () => {
        expect(referencedExecutionPlanPaths).toEqual([
            "docs/superpowers/plans/2026-08-08-release-runtime-operations.md",
            "docs/superpowers/plans/2026-08-08-provisioned-identity-roster.md",
            "docs/superpowers/plans/2026-08-08-core-distribution-load-states.md",
            "docs/superpowers/plans/2026-08-08-billing-connection-boundary.md",
            "docs/superpowers/plans/2026-08-08-release-qualification.md",
        ]);
        expect(releaseDesign.replace(/\s+/g, " ")).toContain(
            "Retain only the disabled server-only provider-neutral adapter, catalog, and authority contracts as an integration seam.",
        );
        expect(releaseMasterPlan.replace(/\s+/g, " ")).toContain(
            "No durable billing persistence, billing HTTP routes, or real payment integration belongs to this release.",
        );
        expect(billingBoundaryPlan.replace(/\s+/g, " ")).toContain(
            "This release retains only the disabled server-only provider-neutral adapter, catalog, and authority seam.",
        );

        for (const forbiddenDurablePlan of [
            "202608080012",
            "omr_billing_checkout_intents",
            "omr_apply_billing_event_v1",
            "src/app/api/billing/checkout/route.ts",
            "src/lib/billingStore.server.ts",
            "supabase/migrations/202608080012_billing_connection_boundary.sql",
        ]) {
            for (const [path, source] of [
                ["docs/superpowers/specs/2026-08-08-initial-operations-100-release-design.md", releaseDesign],
                ["docs/superpowers/plans/2026-08-08-initial-operations-100-release-master.md", releaseMasterPlan],
                ...referencedExecutionPlans.entries(),
            ]) {
                expect(source, `${path} retains ${forbiddenDurablePlan}`).not.toContain(forbiddenDurablePlan);
            }
        }

        const sourceRoot = new URL("..", import.meta.url).pathname;
        const serverSeamCallSites = productionTypeScriptFiles(sourceRoot)
            .filter(path => !path.endsWith("billingProviderContract.server.ts"))
            .filter(path => !path.endsWith("billingProviderContract.fake.server.ts"))
            .filter(path => readFileSync(path, "utf8").includes("billingProviderContract.server"));
        expect(serverSeamCallSites).toEqual([]);
        expect(existsSync(join(process.cwd(), "src/app/api/billing"))).toBe(false);

        const billingDurabilitySql = /\bomr_billing_(?:checkout_intents|customers|subscriptions|webhook_events)\b|\bomr_apply_billing_event_v\d+\b/;
        const protectedSqlPaths = [
            "supabase/schema.sql",
            "supabase/production-rls.sql",
            "supabase/production-server-boundary.sql",
            "supabase/production-server-boundary-rollback.sql",
            ...readdirSync(join(process.cwd(), "supabase/migrations"))
                .filter(file => file.endsWith(".sql"))
                .map(file => `supabase/migrations/${file}`),
        ];
        const durableBillingSqlFiles = protectedSqlPaths.filter(path => billingDurabilitySql.test(
            readFileSync(join(process.cwd(), path), "utf8"),
        ));
        expect(durableBillingSqlFiles).toEqual([]);
    });
});
