import { describe, expect, it } from "vitest";
import { buildPlanChangeImpact, type PlanChangeImpact } from "./page";
import type { PlanEntitlementKey } from "@/utils/plans";
import type { BillingUsageSummary } from "@/lib/billingUsage";

const ENTITLEMENT_KEYS = [
    "handwritingArchive",
    "advancedAnalytics",
    "retakeAssignments",
    "studentGrowthReports",
    "pdfExport",
    "reminders",
    "multiTeacher",
    "organizationDashboard",
] satisfies readonly PlanEntitlementKey[];

function usage(overrides: Partial<BillingUsageSummary> = {}): BillingUsageSummary {
    return {
        examsThisMonth: 0,
        students: 0,
        aiRecognition: 0,
        attemptsThisMonth: 0,
        handwritingArchivesThisMonth: 0,
        handwritingQuestionCount: 0,
        handwritingStrokeCount: 0,
        ...overrides,
    };
}

describe("buildPlanChangeImpact", () => {
    it("reports no impact for an upgrade", () => {
        const impact = buildPlanChangeImpact("free", "pro", usage({ students: 10 }), ENTITLEMENT_KEYS);
        expect(impact.isDowngrade).toBe(false);
        expect(impact.limitWarnings).toHaveLength(0);
        expect(impact.lockedEntitlements).toHaveLength(0);
    });

    it("flags over-limit usage on a Pro -> Free downgrade", () => {
        const impact = buildPlanChangeImpact("pro", "free", usage({ students: 300 }), ENTITLEMENT_KEYS);
        expect(impact.isDowngrade).toBe(true);
        const studentWarning = impact.limitWarnings.find(view => view.metric === "students");
        expect(studentWarning).toBeDefined();
        expect(studentWarning?.status).toBe("blocked");
        expect(studentWarning?.limit).toBe(30);
        expect(studentWarning?.used).toBe(300);
    });

    it("lists entitlements that lock on a Pro -> Free downgrade", () => {
        const impact = buildPlanChangeImpact("pro", "free", usage(), ENTITLEMENT_KEYS);
        const lockedKeys = impact.lockedEntitlements.map(view => view.key);
        expect(lockedKeys).toContain("handwritingArchive");
        expect(lockedKeys).toContain("advancedAnalytics");
        expect(lockedKeys).toContain("pdfExport");
        expect(lockedKeys).toContain("reminders");
        expect(lockedKeys).toContain("retakeAssignments");
        // Free retains csvExport, and multiTeacher is off in both plans, so neither locks.
        expect(lockedKeys).not.toContain("multiTeacher");
    });

    it("only surfaces limits that are near or blocked", () => {
        const impact = buildPlanChangeImpact("pro", "free", usage({ students: 5, examsThisMonth: 0, aiRecognition: 0 }), ENTITLEMENT_KEYS);
        // 5/30 students is well under the Free limit, so no limit warning fires.
        expect(impact.limitWarnings).toHaveLength(0);
        // But entitlement locks still apply on a downgrade.
        expect(impact.lockedEntitlements.length).toBeGreaterThan(0);
    });

    it("reports impact for a downgrade that also spans multiple metrics", () => {
        const impact: PlanChangeImpact = buildPlanChangeImpact(
            "academy",
            "free",
            usage({ students: 1000, examsThisMonth: 40, aiRecognition: 5000 }),
            ENTITLEMENT_KEYS,
        );
        expect(impact.isDowngrade).toBe(true);
        const metrics = impact.limitWarnings.map(view => view.metric);
        expect(metrics).toContain("students");
        expect(metrics).toContain("exams");
        expect(metrics).toContain("aiRecognition");
    });
});
