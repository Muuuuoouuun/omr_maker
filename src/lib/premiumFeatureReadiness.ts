import type { PlanKey } from "@/types/omr";
import type { PlanEntitlementKey, PlanEntitlementView } from "@/utils/plans";

export type PremiumDeliveryStatus = "available" | "partial" | "planned";
export type BillingFeatureStatus = PremiumDeliveryStatus | "locked";

export interface PremiumFeatureReadiness {
    status: PremiumDeliveryStatus;
    label?: string;
    description?: string;
}

export interface BillingFeatureView extends PlanEntitlementView {
    displayLabel: string;
    displayDescription: string;
    status: BillingFeatureStatus;
    statusLabel: string;
}

export interface BillingPlanFeature {
    label: string;
    status: PremiumDeliveryStatus;
    detail?: string;
}

/**
 * Product-delivery truth for the billing surface.
 *
 * Plan entitlements express commercial intent. This table expresses what the
 * product can honestly do today, so an enabled Academy flag cannot be rendered
 * as "available" before the corresponding workflow exists.
 */
export const PREMIUM_FEATURE_READINESS: Record<PlanEntitlementKey, PremiumFeatureReadiness> = {
    handwritingArchive: { status: "available" },
    advancedAnalytics: { status: "available" },
    advancedQuestionDesign: { status: "available" },
    studentGrowthReports: { status: "available" },
    csvExport: { status: "available" },
    pdfExport: {
        status: "partial",
        label: "인쇄 · PDF 저장",
        description: "브라우저 인쇄 창에서 결과 요약을 인쇄하거나 PDF로 저장합니다. 전용 PDF 파일 생성은 준비 중입니다.",
    },
    reminders: {
        status: "partial",
        label: "카카오 발송 후보 · 큐",
        description: "미응시·재시험 발송 후보를 검토하고 대기 기록을 관리합니다. 실제 카카오 메시지는 아직 발송하지 않습니다.",
    },
    retakeAssignments: { status: "available" },
    multiTeacher: {
        status: "planned",
        description: "같은 조직에서 여러 교사가 공동 운영하는 워크스페이스는 준비 중입니다.",
    },
    organizationDashboard: {
        status: "planned",
        description: "조직 전체 지표와 교사·반을 통합 관리하는 대시보드는 준비 중입니다.",
    },
    rolesAndPermissions: {
        status: "planned",
        description: "조직 관리자·교사 역할과 세부 권한 관리는 준비 중입니다.",
    },
    sso: {
        status: "planned",
        label: "SSO",
        description: "기관 계정으로 로그인하는 SSO 연동은 준비 중입니다.",
    },
    apiAccess: {
        status: "planned",
        label: "API 접근",
        description: "기관 시스템 연동용 공개 API는 준비 중입니다.",
    },
    customDomain: {
        status: "planned",
        description: "기관 전용 도메인 연결은 준비 중입니다.",
    },
    auditLogs: {
        status: "planned",
        description: "관리자용 사용자·데이터 변경 감사 로그는 준비 중입니다.",
    },
    retentionControls: {
        status: "planned",
        description: "조직별 데이터 보관 기간과 삭제 정책 설정은 준비 중입니다.",
    },
    prioritySupport: {
        status: "planned",
        description: "응답 시간 약속이 포함된 우선 지원 채널은 준비 중입니다.",
    },
    dedicatedSupport: {
        status: "planned",
        description: "기관 전담 지원과 운영 SLA는 준비 중입니다.",
    },
};

export function buildBillingFeatureView(view: PlanEntitlementView): BillingFeatureView {
    const readiness = PREMIUM_FEATURE_READINESS[view.key];
    const status: BillingFeatureStatus = readiness.status === "planned"
        ? "planned"
        : view.enabled
            ? readiness.status
            : "locked";
    const statusLabel = status === "available"
        ? "사용 가능"
        : status === "partial"
            ? "부분 제공"
            : status === "planned"
                ? "준비 중"
                : view.unlockPlan
                    ? `${view.unlockPlan === "academy" ? "Academy" : "Pro"} 필요`
                    : "잠김";

    return {
        ...view,
        displayLabel: readiness.label || view.label,
        displayDescription: readiness.description || view.description,
        status,
        statusLabel,
    };
}

export const BILLING_PLAN_FEATURES: Record<PlanKey, readonly BillingPlanFeature[]> = {
    free: [
        { label: "월 시험 5개 · 학생 30명", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "AI 정답 인식 월 100회", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "기본 분석", status: "available" },
        { label: "CSV 내보내기", status: "available" },
    ],
    pro: [
        { label: "무제한 시험 · 학생 300명", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "AI 정답 인식 월 5,000회", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "하위 질문 · 심화 응답", status: "available", detail: "객관식 아래 자유 응답 설계" },
        { label: "필기 원본 보관", status: "available" },
        { label: "고급 오답·성장 분석", status: "available" },
        { label: "인쇄 · PDF 저장", status: "partial", detail: "브라우저 인쇄 방식" },
        { label: "카카오 발송 후보 · 큐", status: "partial", detail: "실제 발송 미연동" },
        { label: "우선 지원", status: "planned" },
    ],
    academy: [
        { label: "Pro 제공 기능 포함", status: "available" },
        { label: "무제한 학생 · 계약 기반 AI", status: "planned" },
        { label: "다중 교사 워크스페이스", status: "planned" },
        { label: "조직 대시보드", status: "planned" },
        { label: "역할 · 권한", status: "planned" },
        { label: "SSO · 공개 API", status: "planned" },
        { label: "커스텀 도메인 · 감사 로그", status: "planned" },
        { label: "보관 정책 · 전담 지원", status: "planned" },
    ],
};
