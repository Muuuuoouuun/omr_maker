import { describe, expect, it } from "vitest";
import type { PlanEntitlementView } from "@/utils/plans";
import { BILLING_PLAN_FEATURES, buildBillingFeatureView } from "./premiumFeatureReadiness";

function entitlement(overrides: Partial<PlanEntitlementView> = {}): PlanEntitlementView {
    return {
        key: "advancedAnalytics",
        label: "고급 오답 분석",
        description: "분석 설명",
        enabled: true,
        ...overrides,
    };
}

describe("premium feature readiness", () => {
    it("keeps implemented premium features available", () => {
        expect(buildBillingFeatureView(entitlement())).toMatchObject({
            status: "available",
            statusLabel: "사용 가능",
            displayLabel: "고급 오답 분석",
        });
        expect(buildBillingFeatureView(entitlement({
            key: "advancedQuestionDesign",
            label: "하위 질문·심화 응답",
        }))).toMatchObject({
            status: "available",
            statusLabel: "사용 가능",
        });
    });

    it("describes browser printing and Kakao candidates as partial delivery", () => {
        expect(buildBillingFeatureView(entitlement({ key: "pdfExport", label: "PDF 리포트" }))).toMatchObject({
            status: "partial",
            statusLabel: "부분 제공",
            displayLabel: "인쇄 · PDF 저장",
        });
        expect(buildBillingFeatureView(entitlement({ key: "reminders", label: "알림" }))).toMatchObject({
            status: "partial",
            displayLabel: "카카오 발송 후보 · 큐",
        });
    });

    it("never renders unimplemented Academy entitlements as available", () => {
        for (const key of [
            "multiTeacher",
            "organizationDashboard",
            "rolesAndPermissions",
            "sso",
            "apiAccess",
            "customDomain",
            "auditLogs",
            "retentionControls",
            "dedicatedSupport",
        ] as const) {
            expect(buildBillingFeatureView(entitlement({ key, enabled: true }))).toMatchObject({
                status: "planned",
                statusLabel: "준비 중",
            });
        }
    });

    it("shows a plan requirement for delivered but locked features", () => {
        expect(buildBillingFeatureView(entitlement({ enabled: false, unlockPlan: "pro" }))).toMatchObject({
            status: "locked",
            statusLabel: "Pro 필요",
        });
    });

    it("labels every Academy-only plan-card promise as planned", () => {
        const academyPromises = BILLING_PLAN_FEATURES.academy.filter(feature => feature.label !== "Pro 제공 기능 포함");
        expect(academyPromises.length).toBeGreaterThan(0);
        expect(academyPromises.every(feature => feature.status === "planned")).toBe(true);
    });

    it("describes plan limits as server-based and includes advanced question design", () => {
        expect(BILLING_PLAN_FEATURES.free.every(feature => feature.detail !== "현재 기기 사용량 기준")).toBe(true);
        expect(BILLING_PLAN_FEATURES.pro).toEqual(expect.arrayContaining([
            expect.objectContaining({ label: "하위 질문 · 심화 응답", status: "available" }),
            expect.objectContaining({ detail: "서버 플랜·월 사용량 기준" }),
        ]));
    });
});
