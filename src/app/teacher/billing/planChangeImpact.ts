import { buildBillingUsageLimitViews, type BillingUsageLimitView, type BillingUsageSummary } from "@/lib/billingUsage";
import { PLAN_BY_KEY, getPlanEntitlementViews, type PlanEntitlementKey, type PlanEntitlementView } from "@/utils/plans";
import type { PlanKey } from "@/types/omr";

export interface PlanChangeImpact {
    isDowngrade: boolean;
    limitWarnings: BillingUsageLimitView[];
    lockedEntitlements: PlanEntitlementView[];
}

export function buildPlanChangeImpact(
    currentKey: PlanKey,
    targetKey: PlanKey,
    usage: BillingUsageSummary,
    entitlementKeys: readonly PlanEntitlementKey[],
): PlanChangeImpact {
    const currentEntry = PLAN_BY_KEY[currentKey];
    const targetEntry = PLAN_BY_KEY[targetKey];
    const isDowngrade = targetEntry.priceNum < currentEntry.priceNum;
    if (!isDowngrade) {
        return { isDowngrade: false, limitWarnings: [], lockedEntitlements: [] };
    }
    const limitWarnings = buildBillingUsageLimitViews(targetKey, usage)
        .filter(view => view.status === "blocked" || view.status === "near");
    const lockedEntitlements = getPlanEntitlementViews(targetKey, entitlementKeys)
        .filter(view => !view.enabled && currentEntry.entitlements[view.key]);
    return { isDowngrade: true, limitWarnings, lockedEntitlements };
}
