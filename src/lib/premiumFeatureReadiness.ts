import type { PlanKey, StoredPlanKey } from "@/types/omr";
import { getPlanEntitlementViews, type PlanEntitlementKey, type PlanEntitlementView } from "@/utils/plans";

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

export const BILLING_ENTITLEMENT_KEYS = [
    "returnedFeedback",
    "feedbackMarkup",
    "handwritingArchive",
    "advancedAnalytics",
    "advancedQuestionDesign",
    "retakeAssignments",
    "studentGrowthReports",
    "pdfExport",
    "reminders",
    "multiTeacher",
    "organizationDashboard",
    "rolesAndPermissions",
    "sso",
    "apiAccess",
    "customDomain",
    "auditLogs",
    "retentionControls",
    "prioritySupport",
    "dedicatedSupport",
] as const satisfies readonly PlanEntitlementKey[];

export const PLAN_HEALTH_ENTITLEMENT_KEYS = [
    "returnedFeedback",
    "feedbackMarkup",
    "handwritingArchive",
    "advancedAnalytics",
    "advancedQuestionDesign",
    "retakeAssignments",
    "studentGrowthReports",
    "pdfExport",
    "reminders",
] as const satisfies readonly PlanEntitlementKey[];

/**
 * Product-delivery truth for the billing surface.
 *
 * Plan entitlements express commercial intent. This table expresses what the
 * product can honestly do today, so an enabled Academy flag cannot be rendered
 * as "available" before the corresponding workflow exists.
 */
export const PREMIUM_FEATURE_READINESS: Record<PlanEntitlementKey, PremiumFeatureReadiness> = {
    handwritingArchive: {
        status: "available",
        label: "비공개 서버 필기 원본 보관",
        description: "학생 필기 원본을 비공개 원격 저장소에 보관하고 권한이 확인된 사용자에게만 제공합니다.",
    },
    feedbackMarkup: {
        status: "available",
        label: "필기 마크업 · 주석 파일",
        description: "Pro 이상에서 학생 제출 화면 위에 필기 첨삭을 저장하고 주석 파일을 제공합니다.",
    },
    returnedFeedback: {
        status: "available",
        label: "기본 피드백 반환 · 열람 확인",
        description: "Free부터 텍스트 요약과 문항별 코멘트를 반환하고 학생 열람 상태를 확인합니다.",
    },
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
        label: "카카오 후보 · 학습 알림",
        description: "미응시·재시험 후보 검토와 솔라피 마감 알림을 지원합니다. 실제 발송에는 서버 연결과 승인된 템플릿 설정이 필요합니다.",
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

export function buildBillingFeatureViews(plan: StoredPlanKey | null | undefined): BillingFeatureView[] {
    return getPlanEntitlementViews(plan, BILLING_ENTITLEMENT_KEYS).map(buildBillingFeatureView);
}

export const BILLING_PLAN_FEATURES: Record<PlanKey, readonly BillingPlanFeature[]> = {
    free: [
        { label: "월 시험 5개 · 학생 30명", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "AI 정답 인식 월 100회", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "기본 분석", status: "available" },
        { label: "기본 텍스트 피드백 반환 · 열람 확인", status: "available" },
        { label: "CSV 내보내기", status: "available" },
    ],
    pro: [
        { label: "무제한 시험 · 학생 300명", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "AI 정답 인식 월 5,000회", status: "available", detail: "서버 플랜·월 사용량 기준" },
        { label: "하위 질문 · 심화 응답", status: "available", detail: "객관식 아래 자유 응답 설계" },
        { label: "비공개 서버 필기 원본 보관", status: "available" },
        { label: "필기 마크업 · 주석 파일", status: "available" },
        { label: "고급 오답·성장 분석", status: "available" },
        { label: "시험지 개념·함정 포인트 분석", status: "available", detail: "AI 초안을 교사가 검토 · 공용 키는 AI 인식 한도 공유" },
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
