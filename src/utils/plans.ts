import type { PlanKey } from "@/types/omr";

const VALID_PLANS: PlanKey[] = ["free", "pro", "school"];

export function normalizePlan(value: unknown): PlanKey | null {
    return typeof value === "string" && VALID_PLANS.includes(value as PlanKey)
        ? value as PlanKey
        : null;
}

export function getCurrentPlan(fallback: PlanKey = "free"): PlanKey {
    if (typeof window === "undefined") return fallback;
    try {
        return normalizePlan(localStorage.getItem("omr_plan")) || fallback;
    } catch {
        return fallback;
    }
}

export function canArchiveHandwriting(plan: PlanKey): boolean {
    return plan === "pro" || plan === "school";
}

export function getPlanLabel(plan: PlanKey): string {
    if (plan === "school") return "School";
    if (plan === "pro") return "Pro";
    return "Free";
}
