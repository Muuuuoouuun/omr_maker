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
        teachingActionCenter: boolean;
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
    teachingActionCenter: false,
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
    teachingActionCenter: true,
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

export function readAiRecognitionUsage(): number {
    if (typeof window === "undefined") return 0;
    try {
        const value = Number(localStorage.getItem(AI_USAGE_KEY) || "0");
        return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
    } catch {
        return 0;
    }
}

export function incrementAiRecognitionUsage(by = 1): number {
    const next = readAiRecognitionUsage() + Math.max(0, Math.floor(by));
    if (typeof window === "undefined") return next;
    try {
        localStorage.setItem(AI_USAGE_KEY, String(next));
    } catch {
        // Usage counters should never block the recognition workflow.
    }
    return next;
}
