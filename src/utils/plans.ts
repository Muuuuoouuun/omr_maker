import type { PlanKey, StoredPlanKey } from "@/types/omr";

export interface PlanCatalogEntry {
    key: PlanKey;
    name: "Free" | "Pro" | "Academy";
    price: string;
    priceNum: number;
    color: string;
    gradient: string;
    message: string;
    features: string[];
    limits: {
        exams: number;
        students: number;
        aiRecognition: number;
    };
    entitlements: {
        handwritingArchive: boolean;
        advancedAnalytics: boolean;
        advancedQuestionDesign: boolean;
        studentGrowthReports: boolean;
        csvExport: boolean;
        pdfExport: boolean;
        reminders: boolean;
        retakeAssignments: boolean;
        multiTeacher: boolean;
        organizationDashboard: boolean;
        rolesAndPermissions: boolean;
        sso: boolean;
        apiAccess: boolean;
        customDomain: boolean;
        auditLogs: boolean;
        retentionControls: boolean;
        prioritySupport: boolean;
        dedicatedSupport: boolean;
    };
}

const AI_USAGE_KEY = "omr_ai_usage";
const PLAN_KEY = "omr_plan";

const FREE_ENTITLEMENTS: PlanCatalogEntry["entitlements"] = {
    handwritingArchive: false,
    advancedAnalytics: false,
    advancedQuestionDesign: false,
    studentGrowthReports: false,
    csvExport: true,
    pdfExport: false,
    reminders: false,
    retakeAssignments: false,
    multiTeacher: false,
    organizationDashboard: false,
    rolesAndPermissions: false,
    sso: false,
    apiAccess: false,
    customDomain: false,
    auditLogs: false,
    retentionControls: false,
    prioritySupport: false,
    dedicatedSupport: false,
};

const PRO_ENTITLEMENTS: PlanCatalogEntry["entitlements"] = {
    ...FREE_ENTITLEMENTS,
    handwritingArchive: true,
    advancedAnalytics: true,
    advancedQuestionDesign: true,
    studentGrowthReports: true,
    pdfExport: true,
    reminders: true,
    retakeAssignments: true,
    prioritySupport: true,
};

export const PLAN_CATALOG: PlanCatalogEntry[] = [
    {
        key: "free",
        name: "Free",
        price: "₩0",
        priceNum: 0,
        color: "#64748b",
        gradient: "linear-gradient(135deg, #94a3b8, #64748b)",
        message: "Try the full OMR loop.",
        features: ["월 시험 5개", "학생 30명", "AI 정답 인식 월 100회", "기본 분석", "CSV 내보내기"],
        limits: { exams: 5, students: 30, aiRecognition: 100 },
        entitlements: FREE_ENTITLEMENTS,
    },
    {
        key: "pro",
        name: "Pro",
        price: "₩19,000",
        priceNum: 19000,
        color: "#4f46e5",
        gradient: "linear-gradient(135deg, #6366f1, #4f46e5)",
        message: "Save time after every test.",
        features: ["무제한 시험", "학생 300명", "AI 정답 인식 월 5,000회", "풀이 필기 보관", "고급 분석", "PDF 리포트", "우선 지원"],
        limits: { exams: Infinity, students: 300, aiRecognition: 5000 },
        entitlements: PRO_ENTITLEMENTS,
    },
    {
        key: "academy",
        name: "Academy",
        price: "₩99,000",
        priceNum: 99000,
        color: "#0f766e",
        gradient: "linear-gradient(135deg, #0f766e, #0e7490)",
        message: "Manage learning data across the organization.",
        features: ["무제한 시험", "무제한 학생", "계약 기반 AI 정답 인식", "다중 선생님", "조직 대시보드", "역할/권한", "감사 로그", "SSO/API 준비"],
        limits: { exams: Infinity, students: Infinity, aiRecognition: Infinity },
        entitlements: {
            ...PRO_ENTITLEMENTS,
            multiTeacher: true,
            organizationDashboard: true,
            rolesAndPermissions: true,
            sso: true,
            apiAccess: true,
            customDomain: true,
            auditLogs: true,
            retentionControls: true,
            dedicatedSupport: true,
        },
    },
];

export const PLAN_BY_KEY: Record<PlanKey, PlanCatalogEntry> = PLAN_CATALOG.reduce((acc, plan) => {
    acc[plan.key] = plan;
    return acc;
}, {} as Record<PlanKey, PlanCatalogEntry>);

export type PlanLimitMetric = keyof PlanCatalogEntry["limits"];
export type PlanEntitlementKey = keyof PlanCatalogEntry["entitlements"];

export interface PlanEntitlementCopy {
    label: string;
    description: string;
}

export interface PlanEntitlementView extends PlanEntitlementCopy {
    key: PlanEntitlementKey;
    enabled: boolean;
    unlockPlan?: PlanKey;
}

export const PLAN_ENTITLEMENT_COPY: Record<PlanEntitlementKey, PlanEntitlementCopy> = {
    handwritingArchive: {
        label: "필기 원본 보관",
        description: "제출 후 문항별 필기와 OMR 흔적을 장기 저장합니다.",
    },
    advancedAnalytics: {
        label: "고급 오답 분석",
        description: "학생별, 반별, 시험별 약점 유형을 비교합니다.",
    },
    advancedQuestionDesign: {
        label: "고급 문항 구성",
        description: "객관식 문항 아래에 사고 확인용 하위 질문을 설계합니다.",
    },
    studentGrowthReports: {
        label: "학생 성장 리포트",
        description: "학생별 누적 성취와 반복 약점을 리포트로 정리합니다.",
    },
    csvExport: {
        label: "CSV 내보내기",
        description: "성적과 응시 데이터를 CSV로 내려받습니다.",
    },
    pdfExport: {
        label: "PDF 리포트",
        description: "상담과 공유용 PDF 리포트를 생성합니다.",
    },
    reminders: {
        label: "카카오 알림 후보",
        description: "미응시, 재응시, 보충 대상 알림 후보를 만듭니다.",
    },
    retakeAssignments: {
        label: "재추천/재응시 링크",
        description: "틀린 문제와 약점 유형 기반 재응시 링크를 만듭니다.",
    },
    multiTeacher: {
        label: "다중 선생님",
        description: "여러 선생님이 같은 학원 데이터를 함께 관리합니다.",
    },
    organizationDashboard: {
        label: "조직 대시보드",
        description: "반과 선생님 단위의 운영 지표를 한 화면에서 봅니다.",
    },
    rolesAndPermissions: {
        label: "역할/권한",
        description: "관리자, 선생님, 조교 권한을 분리합니다.",
    },
    sso: {
        label: "SSO",
        description: "기관 계정 기반 로그인을 연동합니다.",
    },
    apiAccess: {
        label: "API 접근",
        description: "외부 운영 시스템과 시험/성적 데이터를 연동합니다.",
    },
    customDomain: {
        label: "커스텀 도메인",
        description: "학원 전용 도메인으로 접속 환경을 구성합니다.",
    },
    auditLogs: {
        label: "감사 로그",
        description: "데이터 조회와 변경 이력을 추적합니다.",
    },
    retentionControls: {
        label: "보관 정책",
        description: "필기, 시험지, 성적 데이터 보관 기간을 제어합니다.",
    },
    prioritySupport: {
        label: "우선 지원",
        description: "운영 중 막히는 문제를 우선 처리합니다.",
    },
    dedicatedSupport: {
        label: "전담 지원",
        description: "학원 운영 흐름에 맞춰 전담 지원을 제공합니다.",
    },
};

export interface PlanLimitDecision {
    allowed: boolean;
    plan: PlanKey;
    metric: PlanLimitMetric;
    used: number;
    attempted: number;
    limit: number;
    remaining: number;
    upgradeTarget?: PlanKey;
}

function safeUsageCount(value: number | undefined): number {
    return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

export function normalizePlan(value: unknown): PlanKey | null {
    if (value === "school") return "academy";
    return typeof value === "string" && value in PLAN_BY_KEY
        ? value as PlanKey
        : null;
}

export function getCurrentPlan(fallback: PlanKey = "free"): PlanKey {
    if (typeof window === "undefined") return fallback;
    try {
        const raw = localStorage.getItem(PLAN_KEY);
        const normalized = normalizePlan(raw) || fallback;
        if (raw === "school") localStorage.setItem(PLAN_KEY, normalized);
        return normalized;
    } catch {
        return fallback;
    }
}

export function setCurrentPlan(plan: PlanKey): boolean {
    if (typeof window === "undefined") return false;
    try {
        localStorage.setItem(PLAN_KEY, plan);
        return true;
    } catch {
        return false;
    }
}

export function canArchiveHandwriting(plan: StoredPlanKey | null | undefined): boolean {
    const normalized = normalizePlan(plan);
    return normalized === "pro" || normalized === "academy";
}

export function getPlanLabel(plan: StoredPlanKey | null | undefined): string {
    const normalized = normalizePlan(plan) || "free";
    return PLAN_BY_KEY[normalized].name;
}

export function nextPaidPlan(plan: StoredPlanKey | null | undefined): PlanKey | undefined {
    const normalized = normalizePlan(plan) || "free";
    if (normalized === "free") return "pro";
    if (normalized === "pro") return "academy";
    return undefined;
}

export function getPlanEntitlementViews(
    plan: StoredPlanKey | null | undefined,
    keys: readonly PlanEntitlementKey[] = Object.keys(PLAN_ENTITLEMENT_COPY) as PlanEntitlementKey[],
): PlanEntitlementView[] {
    const normalized = normalizePlan(plan) || "free";
    const planIndex = PLAN_CATALOG.findIndex(entry => entry.key === normalized);
    const safePlanIndex = planIndex >= 0 ? planIndex : 0;

    return keys.map(key => {
        const enabled = PLAN_BY_KEY[normalized].entitlements[key];
        const unlockPlan = enabled
            ? undefined
            : PLAN_CATALOG.slice(safePlanIndex + 1).find(entry => entry.entitlements[key])?.key;

        return {
            key,
            ...PLAN_ENTITLEMENT_COPY[key],
            enabled,
            unlockPlan,
        };
    });
}

export function hasPlanEntitlement(
    plan: StoredPlanKey | null | undefined,
    entitlement: PlanEntitlementKey,
): boolean {
    const normalized = normalizePlan(plan) || "free";
    return !!PLAN_BY_KEY[normalized].entitlements[entitlement];
}

export function evaluatePlanLimit(
    plan: StoredPlanKey | null | undefined,
    metric: PlanLimitMetric,
    used: number,
    attempted = 1,
): PlanLimitDecision {
    const normalized = normalizePlan(plan) || "free";
    const safeUsed = safeUsageCount(used);
    const safeAttempted = Math.max(0, Math.floor(Number.isFinite(attempted) ? attempted : 1));
    const limit = PLAN_BY_KEY[normalized].limits[metric];
    const remaining = limit === Infinity ? Infinity : Math.max(0, limit - safeUsed);

    return {
        allowed: limit === Infinity || safeUsed + safeAttempted <= limit,
        plan: normalized,
        metric,
        used: safeUsed,
        attempted: safeAttempted,
        limit,
        remaining,
        upgradeTarget: nextPaidPlan(normalized),
    };
}

export function currentAiUsageMonth(now = new Date()): string {
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function writeAiUsageRecord(month: string, count: number): void {
    if (typeof window === "undefined") return;
    try {
        localStorage.setItem(AI_USAGE_KEY, JSON.stringify({ month, count: Math.max(0, Math.floor(count)) }));
    } catch {
        // Usage counters should never block the recognition workflow.
    }
}

/**
 * AI recognition usage is a monthly quota (plans sell "월 100회" / "월 5,000회"),
 * so it is stored as {month:"YYYY-MM", count} and reset when the stored month is
 * not the current month. A bare number left by an older build is treated as the
 * current month's usage once (backward compatible migration).
 */
export function readAiRecognitionUsage(): number {
    if (typeof window === "undefined") return 0;
    try {
        const raw = localStorage.getItem(AI_USAGE_KEY);
        if (!raw) return 0;
        const month = currentAiUsageMonth();

        const trimmed = raw.trim();
        const legacyNumber = Number(trimmed);
        if (trimmed !== "" && Number.isFinite(legacyNumber) && String(legacyNumber) === trimmed) {
            const count = legacyNumber > 0 ? Math.floor(legacyNumber) : 0;
            writeAiUsageRecord(month, count);
            return count;
        }

        const parsed = JSON.parse(raw) as { month?: unknown; count?: unknown };
        if (parsed.month !== month) {
            writeAiUsageRecord(month, 0);
            return 0;
        }
        const count = Number(parsed.count);
        return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    } catch {
        return 0;
    }
}

export function incrementAiRecognitionUsage(by = 1): number {
    const next = readAiRecognitionUsage() + Math.max(0, Math.floor(by));
    if (typeof window === "undefined") return next;
    writeAiUsageRecord(currentAiUsageMonth(), next);
    return next;
}
