import type { Attempt, Exam, StoredPlanKey, PlanKey } from "@/types/omr";
import type { RosterStudent } from "@/lib/rosterStorage";
import {
    PLAN_BY_KEY,
    getPlanEntitlementViews,
    nextPaidPlan,
    normalizePlan,
    type PlanEntitlementKey,
    type PlanEntitlementView,
    type PlanLimitMetric,
} from "@/utils/plans";

export interface BillingUsageSummary {
    examsThisMonth: number;
    students: number;
    aiRecognition: number;
    attemptsThisMonth: number;
    handwritingArchivesThisMonth: number;
    handwritingQuestionCount: number;
    handwritingStrokeCount: number;
}

export type BillingLimitStatus = "ok" | "near" | "blocked" | "unlimited";
export type BillingPlanHealthLevel = "ready" | "watch" | "upgrade";

export interface BillingUsageLimitView {
    metric: PlanLimitMetric;
    label: string;
    used: number;
    limit: number;
    remaining: number;
    percent: number;
    status: BillingLimitStatus;
    message: string;
    upgradeTarget?: PlanKey;
}

export interface BillingPlanHealth {
    level: BillingPlanHealthLevel;
    title: string;
    description: string;
    upgradeTarget?: PlanKey;
    limitViews: BillingUsageLimitView[];
    lockedEntitlements: PlanEntitlementView[];
    lockedEntitlementSummary: string;
}

const LIMIT_COPY: Record<PlanLimitMetric, { label: string; unit: string }> = {
    exams: { label: "이번 달 생성 시험", unit: "개" },
    students: { label: "등록 학생", unit: "명" },
    aiRecognition: { label: "AI 정답 인식", unit: "회" },
};

const BILLING_LIMIT_METRICS: PlanLimitMetric[] = ["exams", "students", "aiRecognition"];

function monthKey(value: string | undefined): string {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function isInMonth(value: string | undefined, key: string): boolean {
    return monthKey(value) === key;
}

export function buildBillingUsageSummary(
    params: {
        exams: Exam[];
        attempts: Attempt[];
        students: RosterStudent[];
        aiRecognition: number;
        now?: Date;
    },
): BillingUsageSummary {
    const now = params.now || new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    const attemptsThisMonth = params.attempts.filter(attempt => isInMonth(attempt.finishedAt || attempt.startedAt, currentMonth));
    const handwritingAttempts = attemptsThisMonth.filter(attempt => attempt.handwritingArchived);

    return {
        examsThisMonth: params.exams.filter(exam => isInMonth(exam.createdAt || exam.updatedAt, currentMonth)).length,
        students: params.students.length,
        aiRecognition: Math.max(0, Math.floor(params.aiRecognition || 0)),
        attemptsThisMonth: attemptsThisMonth.length,
        handwritingArchivesThisMonth: handwritingAttempts.length,
        handwritingQuestionCount: handwritingAttempts.reduce((sum, attempt) => (
            sum + (attempt.questionDrawings?.length || attempt.handwriting?.summary.questionCount || 0)
        ), 0),
        handwritingStrokeCount: handwritingAttempts.reduce((sum, attempt) => (
            sum + (attempt.drawingStrokeCount || attempt.handwriting?.summary.strokeCount || 0)
        ), 0),
    };
}

function usageForMetric(usage: BillingUsageSummary, metric: PlanLimitMetric): number {
    if (metric === "exams") return usage.examsThisMonth;
    if (metric === "students") return usage.students;
    return usage.aiRecognition;
}

function formatCount(value: number): string {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)).toLocaleString("ko-KR") : "무제한";
}

function formatLockedEntitlementSummary(entitlements: PlanEntitlementView[], maxItems = 3): string {
    if (entitlements.length === 0) return "";
    const visibleLabels = entitlements.slice(0, maxItems).map(entitlement => entitlement.label);
    const hiddenCount = entitlements.length - visibleLabels.length;
    return hiddenCount > 0
        ? `${visibleLabels.join(", ")} 외 ${hiddenCount}개`
        : visibleLabels.join(", ");
}

export function buildBillingUsageLimitViews(
    plan: StoredPlanKey | null | undefined,
    usage: BillingUsageSummary,
): BillingUsageLimitView[] {
    const normalized = normalizePlan(plan) || "free";
    const planEntry = PLAN_BY_KEY[normalized];
    const upgradeTarget = nextPaidPlan(normalized);

    return BILLING_LIMIT_METRICS.map(metric => {
        const copy = LIMIT_COPY[metric];
        const used = Math.max(0, Math.floor(usageForMetric(usage, metric) || 0));
        const limit = planEntry.limits[metric];
        const remaining = limit === Infinity ? Infinity : Math.max(0, limit - used);
        const percent = limit === Infinity || limit <= 0 ? 0 : Math.min(100, Math.round((used / limit) * 100));
        const status: BillingLimitStatus = limit === Infinity
            ? "unlimited"
            : used >= limit
                ? "blocked"
                : percent >= 80
                    ? "near"
                    : "ok";
        const message = status === "unlimited"
            ? "무제한 사용 가능"
            : status === "blocked"
                ? `${copy.label} 한도 도달`
                : status === "near"
                    ? `한도 ${percent}% 사용`
                    : `${formatCount(remaining)}${copy.unit} 남음`;

        return {
            metric,
            label: copy.label,
            used,
            limit,
            remaining,
            percent,
            status,
            message,
            upgradeTarget,
        };
    });
}

export function buildBillingPlanHealth(params: {
    plan: StoredPlanKey | null | undefined;
    usage: BillingUsageSummary;
    entitlementKeys: readonly PlanEntitlementKey[];
}): BillingPlanHealth {
    const normalized = normalizePlan(params.plan) || "free";
    const limitViews = buildBillingUsageLimitViews(normalized, params.usage);
    const lockedEntitlements = getPlanEntitlementViews(normalized, params.entitlementKeys)
        .filter(entitlement => !entitlement.enabled);
    const blockedLimit = limitViews.find(view => view.status === "blocked");
    const nearLimit = limitViews.find(view => view.status === "near");
    const lockedTarget = lockedEntitlements.find(entitlement => entitlement.unlockPlan)?.unlockPlan;
    const lockedEntitlementSummary = formatLockedEntitlementSummary(lockedEntitlements);

    if (blockedLimit) {
        const target = blockedLimit.upgradeTarget;
        return {
            level: "upgrade",
            title: "플랜 한도 도달",
            description: target
                ? `${blockedLimit.label} 사용량이 현재 플랜 한도에 도달했습니다. ${PLAN_BY_KEY[target].name}로 올리면 다음 작업을 이어갈 수 있습니다.`
                : `${blockedLimit.label} 사용량이 현재 플랜 한도에 도달했습니다.`,
            upgradeTarget: target,
            limitViews,
            lockedEntitlements,
            lockedEntitlementSummary,
        };
    }

    if (nearLimit) {
        const target = nearLimit.upgradeTarget;
        return {
            level: "watch",
            title: "사용량 주의",
            description: target
                ? `${nearLimit.label} 사용량이 한도에 가까워졌습니다. 운영이 늘어나면 ${PLAN_BY_KEY[target].name} 전환을 검토하세요.`
                : `${nearLimit.label} 사용량이 한도에 가까워졌습니다.`,
            upgradeTarget: target,
            limitViews,
            lockedEntitlements,
            lockedEntitlementSummary,
        };
    }

    if (lockedEntitlements.length > 0) {
        const target = lockedTarget || nextPaidPlan(normalized);
        const targetName = target ? PLAN_BY_KEY[target].name : "상위 플랜";
        return {
            level: "watch",
            title: target === "academy" ? "Academy 기능 잠금" : "프리미엄 기능 잠금",
            description: `${lockedEntitlementSummary} 기능은 ${targetName}에서 열립니다. 지금 플랜의 기본 운영은 가능하지만 해당 기능은 제한됩니다.`,
            upgradeTarget: target,
            limitViews,
            lockedEntitlements,
            lockedEntitlementSummary,
        };
    }

    return {
        level: "ready",
        title: "운영 가능",
        description: "현재 사용량과 기능 권한 기준으로 바로 운영할 수 있습니다.",
        upgradeTarget: nextPaidPlan(normalized),
        limitViews,
        lockedEntitlements,
        lockedEntitlementSummary,
    };
}
