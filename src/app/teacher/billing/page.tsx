"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getServerPlanSnapshot, type ServerPlanSnapshot } from "@/app/actions/premiumAccess";
import TeacherHeader from "@/components/TeacherHeader";
import { CreditCard, Check, Zap, Crown, Building, Download, Sparkles, TrendingUp, AlertCircle, X, Lock, Clock3 } from "lucide-react";
import { formatLimit, usagePct } from "@/lib/pure";
import { toast } from "@/components/Toast";
import type { PlanKey } from "@/types/omr";
import { loadTeacherAttempts } from "@/lib/teacherAttemptClient";
import { loadTeacherExams } from "@/lib/teacherExamClient";
import {
    buildBillingPlanHealth,
    buildBillingUsageLimitViews,
    buildBillingUsageSummary,
    type BillingLimitStatus,
    type BillingPlanHealthLevel,
    type BillingUsageLimitView,
    type BillingUsageSummary,
} from "@/lib/billingUsage";
import { billingStatusMeta, createLocalPlanChangeInvoice, filterBillingRecordsForDisplay, type BillingInvoice } from "@/lib/billingRecords";
import {
    getPaymentProviderReadiness,
    getPaymentProviderRolloutReadiness,
    type PaymentProviderReadinessStatus,
} from "@/lib/paymentProvider";
import { readRosterStudents } from "@/lib/rosterStorage";
import { formatPaymentProviderRoadmap } from "@/lib/serviceRoadmap";
import {
    BILLING_PLAN_FEATURES,
    buildBillingFeatureView,
    type BillingFeatureStatus,
    type PremiumDeliveryStatus,
} from "@/lib/premiumFeatureReadiness";
import { PLAN_BY_KEY, PLAN_CATALOG, getPlanEntitlementViews, readAiRecognitionUsage, type PlanEntitlementKey, type PlanEntitlementView } from "@/utils/plans";

const PLAN_ICONS: Record<PlanKey, React.ReactNode> = {
    free: <Sparkles size={22} />,
    pro: <Zap size={22} />,
    academy: <Building size={22} />,
};

const BILLING_ENTITLEMENT_KEYS = [
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
] satisfies readonly PlanEntitlementKey[];

const PLAN_HEALTH_ENTITLEMENT_KEYS = [
    "handwritingArchive",
    "advancedAnalytics",
    "advancedQuestionDesign",
    "retakeAssignments",
    "studentGrowthReports",
    "pdfExport",
    "reminders",
] satisfies readonly PlanEntitlementKey[];

export interface PlanChangeImpact {
    isDowngrade: boolean;
    limitWarnings: BillingUsageLimitView[];
    lockedEntitlements: PlanEntitlementView[];
}

/**
 * Computes what a plan change would restrict. For a downgrade (target cheaper than
 * current) it returns the limits that would be blocked/near under the target plan
 * given current usage, plus the entitlements that are currently available but lost.
 * Upgrades and same-price changes report no restrictions.
 */
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

const PLAN_HEALTH_META: Record<BillingPlanHealthLevel, { label: string; color: string; background: string }> = {
    ready: { label: "서비스 가능", color: "#047857", background: "#d1fae5" },
    watch: { label: "주의 필요", color: "#92400e", background: "#fef3c7" },
    upgrade: { label: "업그레이드 권장", color: "#b91c1c", background: "#fee2e2" },
};

const LIMIT_STATUS_META: Record<BillingLimitStatus, { label: string; color: string; background: string }> = {
    ok: { label: "정상", color: "#047857", background: "#d1fae5" },
    near: { label: "임박", color: "#92400e", background: "#fef3c7" },
    blocked: { label: "한도 도달", color: "#b91c1c", background: "#fee2e2" },
    unlimited: { label: "무제한", color: "#0369a1", background: "#e0f2fe" },
};

const FEATURE_STATUS_META: Record<BillingFeatureStatus, { label: string; color: string; background: string }> = {
    available: { label: "사용 가능", color: "#047857", background: "#d1fae5" },
    partial: { label: "부분 제공", color: "#92400e", background: "#fef3c7" },
    planned: { label: "준비 중", color: "#475569", background: "#e2e8f0" },
    locked: { label: "잠김", color: "#92400e", background: "#fef3c7" },
};

const PLAN_FEATURE_STATUS_META: Record<PremiumDeliveryStatus, { label: string; color: string; background: string }> = {
    available: { label: "제공", color: "#047857", background: "#d1fae5" },
    partial: { label: "부분 제공", color: "#92400e", background: "#fef3c7" },
    planned: { label: "준비 중", color: "#475569", background: "#e2e8f0" },
};

function paymentProviderStatusColor(status: PaymentProviderReadinessStatus): string {
    if (status === "ready") return "#047857";
    if (status === "simulation") return "#4f46e5";
    if (status === "blocked") return "#b45309";
    return "#64748b";
}

function paymentProviderModeLabel(mode: BillingInvoice["paymentProviderMode"]): string {
    if (mode === "live") return "Live 준비";
    if (mode === "disabled") return "비활성";
    return "시뮬레이션";
}

function readInitialBillingCycle(): boolean {
    if (typeof window === "undefined") return false;
    try {
        return localStorage.getItem("omr_billing_cycle") === "yearly";
    } catch {
        return false;
    }
}

function readInitialInvoices(): BillingInvoice[] {
    if (typeof window === "undefined") return [];
    try {
        const rawInv = localStorage.getItem("omr_plan_invoices");
        if (!rawInv) return [];
        const parsed = JSON.parse(rawInv);
        return Array.isArray(parsed) ? parsed as BillingInvoice[] : [];
    } catch {
        return [];
    }
}

export default function BillingPage() {
    const [current, setCurrent] = useState<PlanKey>("free");
    const [serverPlanSnapshot, setServerPlanSnapshot] = useState<ServerPlanSnapshot | null>(null);
    const [serverPlanLoading, setServerPlanLoading] = useState(true);
    // Keep the server render deterministic; browser-only preferences hydrate
    // after mount so stored records cannot cause a React hydration mismatch.
    const [yearly, setYearly] = useState(false);
    const [usage, setUsage] = useState<BillingUsageSummary>({
        examsThisMonth: 0,
        students: 0,
        aiRecognition: 0,
        attemptsThisMonth: 0,
        handwritingArchivesThisMonth: 0,
        handwritingQuestionCount: 0,
        handwritingStrokeCount: 0,
    });
    const [userInvoices, setUserInvoices] = useState<BillingInvoice[]>([]);
    const [upgradeTarget, setUpgradeTarget] = useState<PlanKey | null>(null);
    const invoiceSeqRef = useRef(0);
    const paymentProviderReadiness = useMemo(() => getPaymentProviderReadiness(), []);
    const paymentProviderRolloutReadiness = useMemo(() => getPaymentProviderRolloutReadiness(), []);

    useEffect(() => {
        const animationFrame = window.requestAnimationFrame(() => {
            setYearly(readInitialBillingCycle());
            setUserInvoices(readInitialInvoices());
        });

        return () => window.cancelAnimationFrame(animationFrame);
    }, []);

    useEffect(() => {
        if (typeof window === "undefined") return;

        let cancelled = false;
        const hydrateUsage = async () => {
            const [examResult, attemptResult, planSnapshot] = await Promise.all([
                loadTeacherExams(),
                loadTeacherAttempts(),
                getServerPlanSnapshot().catch(() => null),
            ]);
            if (cancelled) return;

            setServerPlanSnapshot(planSnapshot);
            setServerPlanLoading(false);
            setCurrent(planSnapshot?.authoritative ? planSnapshot.plan : "free");

            let students = readRosterStudents(localStorage);
            if (students.length === 0) {
                const studentKeys = new Map<string, string>();
                for (const attempt of attemptResult.items) {
                    const key = attempt.studentId || attempt.studentName;
                    if (key) studentKeys.set(key, attempt.studentName || key);
                }
                students = Array.from(studentKeys.entries()).map(([id, name]) => ({
                    id,
                    name,
                    email: "",
                    group: "미분류",
                    avatar: "#64748b",
                    avgScore: 0,
                    examsTaken: 0,
                    lastActive: "기록 없음",
                    trend: "flat" as const,
                    status: "active" as const,
                }));
            }

            const localUsage = buildBillingUsageSummary({
                exams: examResult.items,
                attempts: attemptResult.items,
                students,
                aiRecognition: readAiRecognitionUsage(),
            });
            setUsage(planSnapshot?.authoritative && planSnapshot.usage
                ? {
                    ...localUsage,
                    examsThisMonth: planSnapshot.usage.exams,
                    students: planSnapshot.usage.students,
                    aiRecognition: planSnapshot.usage.aiRecognition,
                }
                : localUsage);

            if (!planSnapshot?.authoritative) {
                toast.info(
                    "서버 플랜 확인 불가",
                    "로컬 플랜을 권한 근거로 사용하지 않습니다. 플랜 표시와 프리미엄 변경은 Free 안전 기본값으로 제한됩니다."
                );
            } else if (examResult.remoteError || attemptResult.remoteError) {
                toast.info(
                    "로컬 사용량 기준으로 표시 중",
                    "서버 동기화가 일부 지연되어 현재 기기 데이터로 사용량을 계산했습니다."
                );
            }
        };

        void hydrateUsage();

        return () => { cancelled = true; };
    }, []);

    // Paid rows remain hidden until a real live checkout can verify provider metadata.
    const allInvoices = useMemo<BillingInvoice[]>(() => {
        return filterBillingRecordsForDisplay(userInvoices, paymentProviderReadiness.canStartLiveCheckout).sort((a, b) => {
            const ta = new Date(a.date).getTime() || 0;
            const tb = new Date(b.date).getTime() || 0;
            return tb - ta;
        });
    }, [paymentProviderReadiness.canStartLiveCheckout, userInvoices]);

    const currentPlan = PLAN_BY_KEY[current];
    const planAuthorityMeta = serverPlanLoading
        ? {
            label: "서버 플랜 확인 중",
            detail: "기능 권한과 월 사용량의 서버 기준을 확인하고 있습니다.",
            color: "#475569",
            background: "#f1f5f9",
        }
        : serverPlanSnapshot?.authoritative
            ? serverPlanSnapshot.source === "dev-simulation"
                ? {
                    label: "개발 플랜 시뮬레이션",
                    detail: "개발 환경의 서버 시뮬레이션 값입니다. 실제 구독이나 결제 상태가 아닙니다.",
                    color: "#92400e",
                    background: "#fef3c7",
                }
                : {
                    label: "서버 플랜 확인됨",
                    detail: "현재 플랜과 시험·학생·AI 월 사용량을 서버 기준으로 표시합니다.",
                    color: "#047857",
                    background: "#d1fae5",
                }
            : {
                label: "권한 확인 불가 · Free 안전 모드",
                detail: serverPlanSnapshot?.error || "서버 플랜을 확인하지 못해 로컬 저장값 대신 Free 안전 기본값을 적용했습니다.",
                color: "#b91c1c",
                background: "#fee2e2",
            };
    const nextPlan = current === "free"
        ? PLAN_BY_KEY.pro
        : null;
    const currentEntitlements = useMemo(
        () => getPlanEntitlementViews(current, BILLING_ENTITLEMENT_KEYS).map(buildBillingFeatureView),
        [current]
    );
    const enabledPlannedFeatureCount = currentEntitlements.filter(entitlement => entitlement.enabled && entitlement.status === "planned").length;
    const planHealth = useMemo(
        () => buildBillingPlanHealth({
            plan: current,
            usage,
            entitlementKeys: PLAN_HEALTH_ENTITLEMENT_KEYS,
        }),
        [current, usage]
    );
    const planHealthMeta = enabledPlannedFeatureCount > 0 && planHealth.level === "ready"
        ? { label: "일부 준비 중", color: "#92400e", background: "#fef3c7" }
        : PLAN_HEALTH_META[planHealth.level];
    const healthUpgradePlan = planHealth.level !== "ready" && planHealth.upgradeTarget && planHealth.upgradeTarget !== current
        ? PLAN_BY_KEY[planHealth.upgradeTarget]
        : null;
    const nextCycleDate = useMemo(() => {
        const now = new Date();
        const renewal = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        return renewal.toISOString().slice(0, 10);
    }, []);
    const handwritingArchiveEnabled = currentPlan.entitlements.handwritingArchive;
    const handwritingUsageDetail = handwritingArchiveEnabled
        ? `${usage.handwritingQuestionCount}문항 · ${usage.handwritingStrokeCount}획`
        : "Pro 이상에서 제출 후 원본 보관";

    const handleCycleChange = (next: boolean) => {
        setYearly(next);
        if (typeof window !== "undefined") {
            try {
                localStorage.setItem("omr_billing_cycle", next ? "yearly" : "monthly");
            } catch {
                // ignore
            }
        }
    };

    const downloadInvoice = (inv: BillingInvoice) => {
        const statusMeta = billingStatusMeta(inv.status);
        const amountLabel = inv.status === "paid" ? "총 결제 금액" : "플랜 표시 가격";
        const providerRow = inv.paymentProviderLabel
            ? `<tr><td style="color: #64748b;">결제 provider</td><td style="text-align: right; color: #64748b;">${inv.paymentProviderLabel} · ${paymentProviderModeLabel(inv.paymentProviderMode)}</td></tr>`
            : "";
        const statusRow = inv.status === "paid"
            ? '<tr><td style="color: #64748b;">부가세 (10%)</td><td style="text-align: right; color: #64748b;">포함</td></tr>'
            : '<tr><td style="color: #64748b;">결제 상태</td><td style="text-align: right; color: #64748b;">실결제 미연동</td></tr>';
        const html = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>${inv.id}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 40px auto; padding: 0 24px; color: #0f172a; }
.header { display: flex; justify-content: space-between; align-items: start; border-bottom: 2px solid #4f46e5; padding-bottom: 20px; margin-bottom: 24px; }
.brand { font-size: 28px; font-weight: 800; background: linear-gradient(135deg, #4f46e5, #ec4899); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
.meta { text-align: right; color: #64748b; font-size: 13px; line-height: 1.6; }
h1 { font-size: 22px; margin: 0 0 4px; }
.id { font-family: monospace; color: #64748b; font-size: 13px; }
table { width: 100%; border-collapse: collapse; margin: 24px 0; }
th, td { padding: 12px 8px; text-align: left; border-bottom: 1px solid #e2e8f0; }
th { background: #f8fafc; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
.total { font-size: 20px; font-weight: 800; color: #4f46e5; }
.status { display: inline-block; background: ${statusMeta.background}; color: ${statusMeta.color}; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
</style></head><body>
<div class="header">
  <div>
    <div class="brand">OMR Maker</div>
    <div style="color: #64748b; font-size: 13px; margin-top: 4px;">OMR Maker Platform</div>
  </div>
  <div class="meta">
    <strong>${statusMeta.receiptTitle}</strong><br>
    Date: ${inv.date}<br>
    <span class="status">${statusMeta.badgeText}</span>
  </div>
</div>
<h1>${statusMeta.receiptTitle}</h1>
<div class="id">${inv.id}</div>
<table>
  <thead><tr><th>항목</th><th style="text-align: right;">금액</th></tr></thead>
  <tbody>
    <tr><td>${inv.desc}</td><td style="text-align: right; font-weight: 600;">₩${inv.amount.toLocaleString()}</td></tr>
    ${providerRow}
    ${statusRow}
    <tr><td><strong>${amountLabel}</strong></td><td style="text-align: right;" class="total">₩${inv.amount.toLocaleString()}</td></tr>
  </tbody>
</table>
<div class="footer">OMR Maker — 문의: billing@classin.app · ${statusMeta.footerNote}</div>
</body></html>`;
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${inv.id}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    const downloadAllInvoices = () => {
        if (allInvoices.length === 0) {
            toast.info("다운로드할 로컬 플랜 변경 기록 없음");
            return;
        }
        allInvoices.forEach((inv, i) => {
            setTimeout(() => downloadInvoice(inv), i * 150);
        });
    };

    const handlePlanChange = (next: PlanKey) => {
        if (next === current) return;
        setUpgradeTarget(next);
    };

    const handlePaymentMethodChange = () => {
        toast.info(paymentProviderReadiness.label, `${paymentProviderReadiness.detail} · 연동 순서: ${formatPaymentProviderRoadmap()}`);
    };

    const upgradePlan = upgradeTarget ? PLAN_BY_KEY[upgradeTarget] : null;

    const confirmPlanChange = () => {
        if (!upgradeTarget || !upgradePlan) return;
        if (!paymentProviderReadiness.canRecordLocalPlanChange) {
            toast.error("결제 provider 설정 필요", paymentProviderReadiness.detail);
            return;
        }
        const now = new Date();
        const basePrice = yearly ? Math.round(upgradePlan.priceNum * 12 * 0.8) : upgradePlan.priceNum;
        invoiceSeqRef.current += 1;
        const newInvoice = createLocalPlanChangeInvoice({
            planName: upgradePlan.name,
            amount: basePrice,
            yearly,
            now,
            sequence: invoiceSeqRef.current,
            paymentProviderKey: paymentProviderReadiness.provider.key,
            paymentProviderLabel: paymentProviderReadiness.provider.label,
            paymentProviderMode: paymentProviderReadiness.mode,
        });
        const nextInvoices = [newInvoice, ...userInvoices];
        setUserInvoices(nextInvoices);
        if (typeof window !== "undefined") {
            try { localStorage.setItem("omr_plan_invoices", JSON.stringify(nextInvoices)); } catch {}
        }
        toast.success("플랜 변경 미리보기 기록됨", `${upgradePlan.name} 요청을 로컬 기록에 남겼습니다. 서버 플랜과 기능 권한은 변경되지 않았습니다.`);
        setUpgradeTarget(null);
    };

    return (
        <div className="layout-main">
            <TeacherHeader badge="BILLING" badgeColor="#a855f7" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div style={{ margin: '3rem 0 2rem' }}>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>결제 및 플랜</h1>
                    <p className="text-muted" style={{ fontSize: '1.05rem' }}>플랜 변경, 사용량 확인, 결제/플랜 기록을 한 곳에서.</p>
                </div>

                {/* Current plan hero */}
                <div className="bento-card billing-current-plan-card" style={{
                    background: currentPlan.gradient, color: 'white', border: 'none',
                    padding: '2rem', marginBottom: '2rem', position: 'relative', overflow: 'hidden'
                }}>
                    <div style={{ position: 'absolute', top: '-30%', right: '-5%', width: 280, height: 280, background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }} />
                    <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1.5rem' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                <span style={{ fontSize: '0.75rem', fontWeight: 700, background: 'rgba(255,255,255,0.2)', padding: '4px 10px', borderRadius: 'var(--radius-full)', letterSpacing: '0.08em' }}>
                                    {serverPlanSnapshot?.authoritative && serverPlanSnapshot.source === "supabase" ? "SERVER PLAN" : serverPlanSnapshot?.source === "dev-simulation" ? "SIMULATED PLAN" : "SAFE DEFAULT"}
                                </span>
                                {PLAN_ICONS[currentPlan.key]}
                            </div>
                            <h2 style={{ fontSize: '2.5rem', fontWeight: 900, letterSpacing: '-0.03em', marginBottom: '0.25rem' }}>{currentPlan.name}</h2>
                            <p style={{ fontSize: '1rem', opacity: 0.9 }}>{currentPlan.price} / 월 · 다음 사용 주기 {nextCycleDate}</p>
                        </div>
                        <div className="billing-plan-actions" style={{ display: 'flex', gap: '0.75rem' }}>
                            <button onClick={handlePaymentMethodChange} title={paymentProviderReadiness.detail} style={{ padding: '0.75rem 1.25rem', background: 'rgba(255,255,255,0.2)', color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 700, border: '1px solid rgba(255,255,255,0.3)', backdropFilter: 'blur(10px)', fontSize: '0.9rem' }}>결제 연동 상태</button>
                            <button
                                disabled={!nextPlan}
                                onClick={() => nextPlan && handlePlanChange(nextPlan.key)}
                                style={{ padding: '0.75rem 1.25rem', background: 'white', color: currentPlan.color, borderRadius: 'var(--radius-full)', fontWeight: 700, fontSize: '0.9rem', boxShadow: '0 4px 14px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: '0.4rem', opacity: nextPlan ? 1 : 0.6, cursor: nextPlan ? 'pointer' : 'default' }}
                            >
                                <Crown size={16} /> {nextPlan ? `${nextPlan.name}로 업그레이드` : '최상위 플랜'}
                            </button>
                        </div>
                    </div>

                    {/* Payment method */}
                    <div className="billing-payment-status" style={{ position: 'relative', zIndex: 1, marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.9rem 1.1rem', background: 'rgba(255,255,255,0.15)', borderRadius: 'var(--radius-md)', backdropFilter: 'blur(10px)', width: 'fit-content', border: '1px solid rgba(255,255,255,0.2)' }}>
                        <CreditCard size={18} />
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>실결제 미연동</span>
                        <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>{paymentProviderReadiness.provider.label} · 플랜 변경 미리보기만 로컬 기록으로 저장</span>
                    </div>
                </div>

                <div
                    className="bento-card"
                    aria-live="polite"
                    style={{
                        padding: '1rem 1.15rem',
                        marginBottom: '1rem',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '0.7rem',
                        border: `1px solid ${planAuthorityMeta.color}33`,
                        background: planAuthorityMeta.background,
                    }}
                >
                    {serverPlanSnapshot?.authoritative && serverPlanSnapshot.source === "supabase"
                        ? <Check size={18} color={planAuthorityMeta.color} style={{ flexShrink: 0, marginTop: 1 }} />
                        : <AlertCircle size={18} color={planAuthorityMeta.color} style={{ flexShrink: 0, marginTop: 1 }} />}
                    <div>
                        <div style={{ color: planAuthorityMeta.color, fontSize: '0.86rem', fontWeight: 900 }}>{planAuthorityMeta.label}</div>
                        <div style={{ color: planAuthorityMeta.color, opacity: 0.9, fontSize: '0.76rem', fontWeight: 700, lineHeight: 1.5, marginTop: '0.15rem' }}>{planAuthorityMeta.detail}</div>
                    </div>
                </div>

                <div className="bento-card" style={{
                    padding: '1.1rem 1.25rem',
                    marginBottom: '2rem',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    flexWrap: 'wrap',
                    border: '1px solid rgba(99,102,241,0.18)',
                    background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(16,185,129,0.05))'
                }}>
                    <div>
                        <div style={{ fontSize: '0.8rem', fontWeight: 800, color: 'var(--primary)', marginBottom: '0.25rem', letterSpacing: '0.04em' }}>
                            결제 연동 예정
                        </div>
                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                            토스페이먼츠, 네이버페이, 카카오페이 순서로 운영 결제를 붙입니다. 지금 화면에서는 실제 과금이나 서버 권한 변경 없이 플랜 변경 미리보기 기록만 남깁니다.
                        </p>
                    </div>
                    <div style={{ display: 'grid', gap: '0.65rem', minWidth: 'min(360px, 100%)' }}>
                        <div style={{
                            padding: '0.75rem 0.85rem',
                            borderRadius: 'var(--radius-md)',
                            border: `1px solid ${paymentProviderStatusColor(paymentProviderReadiness.status)}44`,
                            background: 'var(--surface)',
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                                <span style={{ fontSize: '0.78rem', fontWeight: 900, color: 'var(--foreground)' }}>
                                    결제 provider 상태
                                </span>
                                <span style={{
                                    color: paymentProviderStatusColor(paymentProviderReadiness.status),
                                    border: `1px solid ${paymentProviderStatusColor(paymentProviderReadiness.status)}`,
                                    borderRadius: 'var(--radius-full)',
                                    padding: '0.18rem 0.52rem',
                                    fontSize: 'var(--type-micro)',
                                    fontWeight: 950,
                                    whiteSpace: 'nowrap',
                                }}>
                                    {paymentProviderReadiness.label}
                                </span>
                            </div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 750, lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                {paymentProviderReadiness.detail}
                                {paymentProviderReadiness.missing.length > 0 ? ` · 누락 ${paymentProviderReadiness.missing.join(", ")}` : ""}
                            </div>
                        </div>
                        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap' }} aria-label="결제 연동 후보">
                            {paymentProviderRolloutReadiness.map(item => {
                                const chipColor = item.publicKeyPresent ? '#047857' : item.active ? '#b45309' : 'var(--foreground)';
                                return (
                                    <span
                                        key={item.provider.key}
                                        title={item.missing.length > 0 ? `누락 ${item.missing.join(", ")}` : item.label}
                                        style={{
                                            padding: '0.35rem 0.65rem',
                                            borderRadius: 'var(--radius-full)',
                                            background: item.active ? 'rgba(99,102,241,0.1)' : 'var(--surface)',
                                            border: `1px solid ${item.active ? 'rgba(99,102,241,0.32)' : 'var(--border)'}`,
                                            fontSize: '0.78rem',
                                            fontWeight: 800,
                                            color: item.active
                                                ? (item.publicKeyPresent ? 'var(--primary)' : '#b45309')
                                                : chipColor
                                        }}
                                    >
                                        {item.provider.priority}. {item.provider.label} · {item.label}
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                </div>

                <div className="bento-card" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', marginBottom: '1.1rem', flexWrap: 'wrap' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem', flexWrap: 'wrap' }}>
                                <h2 style={{ fontSize: '1.2rem', fontWeight: 800 }}>사용량·권한 서비스 점검</h2>
                                <span style={{
                                    padding: '0.22rem 0.55rem',
                                    borderRadius: 'var(--radius-full)',
                                    background: planHealthMeta.background,
                                    color: planHealthMeta.color,
                                    fontSize: 'var(--type-caption)',
                                    fontWeight: 900
                                }}>
                                    {planHealthMeta.label}
                                </span>
                            </div>
                            <p style={{ fontSize: '0.88rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                {enabledPlannedFeatureCount > 0 && planHealth.level === "ready"
                                    ? `핵심 기능 운영 가능 · 현재 플랜에 표시된 ${enabledPlannedFeatureCount}개 기능은 아직 준비 중입니다.`
                                    : `${planHealth.title} · ${planHealth.description}`}
                            </p>
                        </div>
                        {healthUpgradePlan && (
                            <button
                                type="button"
                                onClick={() => handlePlanChange(healthUpgradePlan.key)}
                                aria-label={`${healthUpgradePlan.name} 플랜 검토`}
                                style={{
                                    padding: '0.65rem 0.95rem',
                                    background: healthUpgradePlan.gradient,
                                    color: 'white',
                                    borderRadius: 'var(--radius-md)',
                                    fontWeight: 800,
                                    fontSize: '0.84rem',
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: '0.35rem',
                                    boxShadow: `0 4px 14px ${healthUpgradePlan.color}44`
                                }}
                            >
                                <Crown size={15} /> {healthUpgradePlan.name} 검토
                            </button>
                        )}
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: '0.75rem' }}>
                        {planHealth.limitViews.map(limitView => {
                            const statusMeta = LIMIT_STATUS_META[limitView.status];
                            return (
                                <div
                                    key={limitView.metric}
                                    style={{
                                        padding: '0.9rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-md)',
                                        background: 'var(--background)'
                                    }}
                                >
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
                                        <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--muted)' }}>{limitView.label}</span>
                                        <span style={{
                                            padding: '0.18rem 0.45rem',
                                            borderRadius: 'var(--radius-full)',
                                            background: statusMeta.background,
                                            color: statusMeta.color,
                                            fontSize: 'var(--type-micro)',
                                            fontWeight: 900,
                                            whiteSpace: 'nowrap'
                                        }}>
                                            {statusMeta.label}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: '1.25rem', fontWeight: 900, fontVariantNumeric: 'tabular-nums', marginBottom: '0.2rem' }}>
                                        {formatLimit(limitView.used)}
                                        <span style={{ fontSize: '0.82rem', color: 'var(--muted)', marginLeft: '0.25rem', fontWeight: 700 }}>
                                            / {formatLimit(limitView.limit)}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700 }}>{limitView.message}</div>
                                </div>
                            );
                        })}
                        <div style={{
                            padding: '0.9rem',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-md)',
                            background: planHealth.lockedEntitlements.length > 0 || enabledPlannedFeatureCount > 0 ? '#fffbeb' : 'var(--background)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
                                <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--muted)' }}>
                                    {planHealth.lockedEntitlements.length > 0 ? '잠긴 프리미엄 기능' : '준비 중인 기능'}
                                </span>
                                <span style={{
                                    padding: '0.18rem 0.45rem',
                                    borderRadius: 'var(--radius-full)',
                                    background: planHealth.lockedEntitlements.length > 0 || enabledPlannedFeatureCount > 0 ? '#fef3c7' : '#d1fae5',
                                    color: planHealth.lockedEntitlements.length > 0 || enabledPlannedFeatureCount > 0 ? '#92400e' : '#047857',
                                    fontSize: 'var(--type-micro)',
                                    fontWeight: 900,
                                    whiteSpace: 'nowrap'
                                }}>
                                    {planHealth.lockedEntitlements.length > 0
                                        ? `${planHealth.lockedEntitlements.length}개 잠금`
                                        : enabledPlannedFeatureCount > 0
                                            ? `${enabledPlannedFeatureCount}개 준비 중`
                                            : '모두 제공'}
                                </span>
                            </div>
                            <div style={{ fontSize: '1.25rem', fontWeight: 900, marginBottom: '0.2rem' }}>
                                {planHealth.lockedEntitlements.length || enabledPlannedFeatureCount}개
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700, lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                {planHealth.lockedEntitlements.length > 0
                                    ? planHealth.lockedEntitlementSummary
                                    : enabledPlannedFeatureCount > 0
                                        ? "플랜에 포함될 예정이지만 아직 사용할 수 없는 기능입니다."
                                        : "현재 플랜의 주요 프리미엄 기능을 바로 사용할 수 있습니다."}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Usage */}
                <div style={{ marginBottom: '2rem' }}>
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' }}>이달 사용량</h2>
                    <div className="bento-grid">
                        <UsageCard label="이번 달 생성 시험" used={usage.examsThisMonth} total={currentPlan.limits.exams} color="#4f46e5" />
                        <UsageCard label="등록 학생" used={usage.students} total={currentPlan.limits.students} color="#10b981" />
                        <UsageCard label="AI 정답 인식" used={usage.aiRecognition} total={currentPlan.limits.aiRecognition} color="#0f766e" />
                        <UsageCard
                            label="필기 보관"
                            used={usage.handwritingArchivesThisMonth}
                            total={handwritingArchiveEnabled ? Infinity : 0}
                            color="#8b5cf6"
                            detail={handwritingUsageDetail}
                            locked={!handwritingArchiveEnabled}
                            limitLabel="Pro+"
                        />
                        <div className="bento-card" style={{ padding: '1.5rem', background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(236,72,153,0.08))', border: '1px solid rgba(99,102,241,0.2)' }}>
                            <TrendingUp size={22} color="var(--primary)" style={{ marginBottom: '0.75rem' }} />
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>사용 추이</div>
                            <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>{usage.attemptsThisMonth}회</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>이번 달 제출</div>
                        </div>
                    </div>
                </div>

                <div className="bento-card" style={{ padding: '1.5rem', marginBottom: '2rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', marginBottom: '1.2rem', flexWrap: 'wrap' }}>
                        <div>
                            <h2 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: '0.25rem' }}>프리미엄 기능 상태</h2>
                            <p style={{ fontSize: '0.88rem', color: 'var(--muted)', lineHeight: 1.55 }}>
                                현재 플랜에서 바로 쓸 수 있는 기능과 업그레이드가 필요한 기능입니다.
                            </p>
                        </div>
                        <span style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.35rem',
                            padding: '0.35rem 0.65rem',
                            borderRadius: 'var(--radius-full)',
                            background: `color-mix(in srgb, ${currentPlan.color}, transparent 90%)`,
                            color: currentPlan.color,
                            fontSize: '0.78rem',
                            fontWeight: 800
                        }}>
                            {PLAN_ICONS[currentPlan.key]}
                            {currentPlan.name}
                        </span>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem' }}>
                        {currentEntitlements.map(entitlement => {
                            const statusMeta = FEATURE_STATUS_META[entitlement.status];
                            return (
                                <div
                                    key={entitlement.key}
                                    style={{
                                        display: 'flex',
                                        gap: '0.75rem',
                                        alignItems: 'flex-start',
                                        padding: '0.85rem',
                                        border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-md)',
                                        background: entitlement.status === 'available' ? 'var(--surface)' : 'var(--background)',
                                        minHeight: 92
                                    }}
                                >
                                    <div style={{
                                        width: 30,
                                        height: 30,
                                        borderRadius: 'var(--radius-md)',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        flexShrink: 0,
                                        background: statusMeta.background,
                                        color: statusMeta.color
                                    }}>
                                        {entitlement.status === 'available'
                                            ? <Check size={16} />
                                            : entitlement.status === 'planned'
                                                ? <Clock3 size={15} />
                                                : entitlement.status === 'partial'
                                                    ? <AlertCircle size={15} />
                                                    : <Lock size={15} />}
                                    </div>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                                            <strong style={{ fontSize: '0.9rem' }}>{entitlement.displayLabel}</strong>
                                            <span style={{
                                                flexShrink: 0,
                                                fontSize: 'var(--type-micro)',
                                                fontWeight: 800,
                                                padding: '0.18rem 0.45rem',
                                                borderRadius: 'var(--radius-full)',
                                                color: statusMeta.color,
                                                background: statusMeta.background,
                                            }}>
                                                {entitlement.statusLabel}
                                            </span>
                                        </div>
                                        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                            {entitlement.displayDescription}
                                        </p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Plans */}
                <div style={{ marginBottom: '2rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '1rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '0.25rem' }}>플랜 비교</h2>
                            <p style={{ fontSize: '0.9rem', color: 'var(--muted)' }}>필요에 맞는 플랜으로 언제든 변경 가능합니다.</p>
                        </div>
                        <div className="billing-cycle-toggle" style={{ display: 'inline-flex', padding: '4px', background: 'var(--surface)', borderRadius: 'var(--radius-full)', border: '1px solid var(--border)' }}>
                            <button onClick={() => handleCycleChange(false)} style={{
                                padding: '0.5rem 1.1rem', borderRadius: 'var(--radius-full)', fontSize: '0.85rem', fontWeight: 600,
                                background: !yearly ? 'var(--primary)' : 'transparent',
                                color: !yearly ? 'white' : 'var(--muted)', transition: 'var(--transition-base)'
                            }}>월간</button>
                            <button onClick={() => handleCycleChange(true)} style={{
                                padding: '0.5rem 1.1rem', borderRadius: 'var(--radius-full)', fontSize: '0.85rem', fontWeight: 600,
                                background: yearly ? 'var(--primary)' : 'transparent',
                                color: yearly ? 'white' : 'var(--muted)', transition: 'var(--transition-base)',
                                display: 'flex', alignItems: 'center', gap: '0.3rem'
                            }}>연간 <span style={{ fontSize: '0.7rem', background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '2px 7px', borderRadius: 'var(--radius-full)', fontWeight: 700 }}>-20%</span></button>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem' }} className="plans-grid">
                        {PLAN_CATALOG.map(p => {
                            const isCurrent = p.key === current;
                            const isPro = p.key === "pro";
                            const academyUnavailable = p.key === "academy";
                            const price = yearly ? Math.round(p.priceNum * 12 * 0.8) : p.priceNum;
                            return (
                                <div key={p.key} className="bento-card card-hover" style={{
                                    padding: '1.75rem', position: 'relative', overflow: 'hidden',
                                    border: isPro ? `2px solid ${p.color}` : '1px solid var(--border)',
                                    transform: isPro ? 'scale(1.02)' : 'none'
                                }}>
                                    {isPro && (
                                        <div style={{ position: 'absolute', top: 14, right: 14, padding: '0.2rem 0.7rem', background: p.gradient, color: 'white', borderRadius: 'var(--radius-full)', fontSize: 'var(--type-micro)', fontWeight: 800, letterSpacing: '0.08em' }}>
                                            MOST POPULAR
                                        </div>
                                    )}
                                    <div style={{ width: 46, height: 46, borderRadius: 'var(--radius-md)', background: `color-mix(in srgb, ${p.color}, transparent 88%)`, color: p.color, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
                                        {PLAN_ICONS[p.key]}
                                    </div>
                                    <h3 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.25rem' }}>{p.name}</h3>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.3rem', marginBottom: '1.25rem' }}>
                                        {academyUnavailable ? (
                                            <span style={{ fontSize: '1.25rem', fontWeight: 900, color: '#475569' }}>조직 기능 준비 중</span>
                                        ) : (
                                            <>
                                                <span style={{ fontSize: '2rem', fontWeight: 900, color: 'var(--foreground)', letterSpacing: '-0.03em' }}>
                                                    ₩{price.toLocaleString()}
                                                </span>
                                                <span style={{ fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 500 }}>/ {yearly ? "년" : "월"}</span>
                                            </>
                                        )}
                                    </div>

                                    <ul style={{ listStyle: 'none', padding: 0, marginBottom: '1.5rem' }}>
                                        {BILLING_PLAN_FEATURES[p.key].map(feature => {
                                            const featureMeta = PLAN_FEATURE_STATUS_META[feature.status];
                                            return (
                                                <li key={feature.label} style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem', padding: '0.4rem 0', fontSize: '0.88rem' }}>
                                                    {feature.status === "available"
                                                        ? <Check size={15} color={featureMeta.color} style={{ flexShrink: 0, marginTop: 2 }} />
                                                        : feature.status === "partial"
                                                            ? <AlertCircle size={15} color={featureMeta.color} style={{ flexShrink: 0, marginTop: 2 }} />
                                                            : <Clock3 size={15} color={featureMeta.color} style={{ flexShrink: 0, marginTop: 2 }} />}
                                                    <span style={{ minWidth: 0, flex: 1 }}>
                                                        <span>{feature.label}</span>
                                                        {feature.detail && (
                                                            <small style={{ display: 'block', marginTop: '0.1rem', color: 'var(--muted)', fontSize: '0.7rem', lineHeight: 1.4 }}>{feature.detail}</small>
                                                        )}
                                                    </span>
                                                    <span style={{ flexShrink: 0, padding: '0.12rem 0.38rem', borderRadius: 'var(--radius-full)', background: featureMeta.background, color: featureMeta.color, fontSize: 'var(--type-micro)', fontWeight: 900 }}>
                                                        {featureMeta.label}
                                                    </span>
                                                </li>
                                            );
                                        })}
                                    </ul>

                                    <button
                                        disabled={isCurrent || academyUnavailable}
                                        onClick={() => handlePlanChange(p.key)}
                                        title={academyUnavailable ? "조직 관리 기능이 실제 제공되기 전에는 Academy로 변경할 수 없습니다." : undefined}
                                        style={{
                                            width: '100%', padding: '0.85rem', borderRadius: 'var(--radius-md)',
                                            background: isCurrent || academyUnavailable ? 'var(--background)' : isPro ? p.gradient : 'var(--surface)',
                                            color: isCurrent || academyUnavailable ? 'var(--muted)' : isPro ? 'white' : 'var(--foreground)',
                                            border: isCurrent || isPro ? 'none' : '1px solid var(--border)',
                                            fontWeight: 700, fontSize: '0.9rem', cursor: isCurrent || academyUnavailable ? 'not-allowed' : 'pointer',
                                            boxShadow: isPro && !isCurrent ? `0 4px 14px ${p.color}44` : 'none'
                                        }}
                                    >
                                        {isCurrent ? '현재 플랜' : academyUnavailable ? 'Academy 준비 중' : p.key === "free" ? '다운그레이드' : '업그레이드'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Invoices */}
                <div className="bento-card billing-invoices-card" style={{ padding: '1.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>로컬 플랜 변경 기록</h2>
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>이 브라우저에 저장된 변경 내역입니다. 결제 완료 내역이나 영수증이 아닙니다.</p>
                        </div>
                        <button
                            onClick={downloadAllInvoices}
                            disabled={allInvoices.length === 0}
                            style={{
                                padding: '0.55rem 1rem',
                                background: 'var(--surface)',
                                border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-md)',
                                fontSize: '0.85rem',
                                fontWeight: 600,
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.4rem',
                                opacity: allInvoices.length === 0 ? 0.5 : 1,
                                cursor: allInvoices.length === 0 ? 'not-allowed' : 'pointer',
                            }}
                        >
                            <Download size={14} /> 전체 기록 다운로드
                        </button>
                    </div>
                    <div className="billing-table-scroll">
                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                            <thead>
                                <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>기록 ID</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>설명</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>날짜</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>표시 가격</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>상태</th>
                                    <th style={{ padding: '0.85rem 0.5rem', textAlign: 'right' }}>다운로드</th>
                                </tr>
                            </thead>
                            <tbody>
                                {allInvoices.map(inv => {
                                    const statusMeta = billingStatusMeta(inv.status);
                                    return (
                                        <tr key={inv.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{inv.id}</td>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem' }}>{inv.desc}</td>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{inv.date}</td>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem', fontWeight: 700 }}>₩{inv.amount.toLocaleString()}</td>
                                            <td style={{ padding: '1rem 0.5rem' }}>
                                                <span style={{ background: statusMeta.background, color: statusMeta.color, padding: '0.25rem 0.65rem', borderRadius: 'var(--radius-full)', fontSize: 'var(--type-caption)', fontWeight: 700 }}>
                                                    {statusMeta.label}
                                                </span>
                                            </td>
                                            <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                                                <button
                                                    onClick={() => downloadInvoice(inv)}
                                                    title={`${statusMeta.receiptTitle} 다운로드`}
                                                    aria-label={`${inv.id} ${statusMeta.receiptTitle} 다운로드`}
                                                    style={{ color: 'var(--primary)', fontSize: '0.85rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
                                                    onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
                                                    onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                                >
                                                    <Download size={14} />
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                                {allInvoices.length === 0 && (
                                    <tr>
                                        <td colSpan={6} style={{ padding: '2.5rem 0.5rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                            아직 로컬 플랜 변경 기록이 없습니다.
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </main>

            <style>{`
                @media (max-width: 900px) {
                    .plans-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>

            {upgradeTarget && upgradePlan && (() => {
                const basePrice = yearly ? Math.round(upgradePlan.priceNum * 12 * 0.8) : upgradePlan.priceNum;
                const planImpact = buildPlanChangeImpact(current, upgradeTarget, usage, BILLING_ENTITLEMENT_KEYS);
                const actionLabel = upgradePlan.priceNum > currentPlan.priceNum
                    ? "업그레이드"
                    : planImpact.isDowngrade
                        ? "다운그레이드"
                        : "플랜 변경";
                return (
                    <div
                        role="dialog"
                        aria-label={`${upgradePlan.name} 플랜 ${actionLabel}`}
                        onClick={() => setUpgradeTarget(null)}
                        style={{
                            position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.55)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            zIndex: 200, padding: '1rem', animation: 'fadeIn 0.15s both'
                        }}
                    >
                        <div
                            onClick={(e) => e.stopPropagation()}
                            className="bento-card"
                            style={{
                                width: '100%', maxWidth: 440, padding: '1.5rem',
                                background: 'var(--surface)', borderRadius: 'var(--radius-lg)',
                                boxShadow: '0 24px 48px rgba(0,0,0,0.2)'
                            }}
                        >
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                                <h3 style={{ fontSize: '1.15rem', fontWeight: 800 }}>{upgradePlan.name} 플랜으로 {actionLabel}</h3>
                                <button onClick={() => setUpgradeTarget(null)} aria-label="모달 닫기" style={{ color: 'var(--muted)' }}>
                                    <X size={18} />
                                </button>
                            </div>

                            <div style={{
                                padding: '1rem', background: `color-mix(in srgb, ${upgradePlan.color}, transparent 92%)`,
                                border: `1px solid ${upgradePlan.color}22`, borderRadius: 'var(--radius-md)', marginBottom: '1rem'
                            }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem', color: upgradePlan.color }}>
                                    {PLAN_ICONS[upgradePlan.key]}
                                    <span style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--foreground)' }}>{upgradePlan.name} · {yearly ? "연간" : "월간"}</span>
                                </div>
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                    {BILLING_PLAN_FEATURES[upgradePlan.key].slice(0, 5).map(feature => {
                                        const featureMeta = PLAN_FEATURE_STATUS_META[feature.status];
                                        return (
                                            <li key={feature.label} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', padding: '0.2rem 0' }}>
                                                {feature.status === "available"
                                                    ? <Check size={13} color={featureMeta.color} style={{ flexShrink: 0 }} />
                                                    : feature.status === "partial"
                                                        ? <AlertCircle size={13} color={featureMeta.color} style={{ flexShrink: 0 }} />
                                                        : <Clock3 size={13} color={featureMeta.color} style={{ flexShrink: 0 }} />}
                                                <span>{feature.label} · {featureMeta.label}</span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </div>

                            {planImpact.isDowngrade && (planImpact.limitWarnings.length > 0 || planImpact.lockedEntitlements.length > 0) && (
                                <div style={{
                                    padding: '0.9rem 1rem',
                                    background: '#fffbeb',
                                    border: '1px solid #fde68a',
                                    borderRadius: 'var(--radius-md)',
                                    marginBottom: '1rem'
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem', color: '#92400e' }}>
                                        <AlertCircle size={16} />
                                        <strong style={{ fontSize: '0.88rem' }}>다운그레이드 시 제한되는 항목</strong>
                                    </div>
                                    <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'grid', gap: '0.35rem' }}>
                                        {planImpact.limitWarnings.map(view => (
                                            <li key={view.metric} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: '#7c2d12' }}>
                                                <Lock size={12} style={{ flexShrink: 0 }} />
                                                <span>{view.label} {formatLimit(view.used)}/{formatLimit(view.limit)} · {view.status === "blocked" ? "한도 초과" : "한도 임박"}</span>
                                            </li>
                                        ))}
                                        {planImpact.lockedEntitlements.map(view => (
                                            <li key={view.key} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: '#7c2d12' }}>
                                                <Lock size={12} style={{ flexShrink: 0 }} />
                                                <span>{view.label} 잠금</span>
                                            </li>
                                        ))}
                                    </ul>
                                    <p style={{ fontSize: '0.8rem', color: '#92400e', marginTop: '0.5rem', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                        기존 데이터는 삭제되지 않지만, 한도를 초과한 항목과 잠긴 기능은 다시 업그레이드하기 전까지 사용할 수 없습니다.
                                    </p>
                                </div>
                            )}

                            <div style={{ padding: '0.85rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', fontSize: '0.88rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0' }}>
                                    <span style={{ color: 'var(--muted)' }}>플랜 표시 가격</span>
                                    <span style={{ fontWeight: 600 }}>₩{basePrice.toLocaleString()} / {yearly ? "년" : "월"}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0 0', borderTop: '1px dashed var(--border)', marginTop: '0.25rem', fontSize: '0.95rem' }}>
                                    <span style={{ fontWeight: 700 }}>이번 변경에서 결제되는 금액</span>
                                    <span style={{ fontWeight: 900, color: '#047857' }}>₩0</span>
                                </div>
                                <p style={{ marginTop: '0.45rem', color: 'var(--muted)', fontSize: '0.8rem', lineHeight: 1.5 }}>실결제와 구독은 시작되지 않으며 현재 브라우저의 플랜 표시만 바뀝니다.</p>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 0.85rem', background: 'var(--background)', border: `1px solid ${paymentProviderStatusColor(paymentProviderReadiness.status)}44`, borderRadius: 'var(--radius-md)', marginBottom: '1.25rem' }}>
                                <CreditCard size={16} color={paymentProviderStatusColor(paymentProviderReadiness.status)} />
                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>실결제 미연동</span>
                                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: paymentProviderStatusColor(paymentProviderReadiness.status), fontWeight: 900 }}>{paymentProviderReadiness.label}</span>
                            </div>

                            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                                <button
                                    type="button"
                                    onClick={() => setUpgradeTarget(null)}
                                    style={{ padding: '0.7rem 1.1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.88rem', color: 'var(--foreground)' }}
                                >
                                    취소
                                </button>
                                <button
                                    type="button"
                                    onClick={confirmPlanChange}
                                    disabled={!paymentProviderReadiness.canRecordLocalPlanChange}
                                    title={!paymentProviderReadiness.canRecordLocalPlanChange ? paymentProviderReadiness.detail : "실제 과금 없이 로컬 플랜 변경 기록을 남깁니다."}
                                    style={{
                                        padding: '0.7rem 1.25rem', background: upgradePlan.gradient,
                                        color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 800, fontSize: '0.9rem',
                                        boxShadow: `0 4px 14px ${upgradePlan.color}55`,
                                        opacity: paymentProviderReadiness.canRecordLocalPlanChange ? 1 : 0.55,
                                        cursor: paymentProviderReadiness.canRecordLocalPlanChange ? 'pointer' : 'not-allowed',
                                    }}
                                >
                                    {paymentProviderReadiness.canRecordLocalPlanChange
                                        ? (planImpact.isDowngrade ? "다운그레이드 확정" : "로컬 플랜 변경 기록")
                                        : "provider 설정 필요"}
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}

function UsageCard({
    label,
    used,
    total,
    color,
    detail,
    locked = false,
    limitLabel,
}: {
    label: string;
    used: number;
    total: number;
    color: string;
    detail?: string;
    locked?: boolean;
    limitLabel?: string;
}) {
    const pct = locked ? 0 : usagePct(used, total);
    const isWarning = !locked && pct > 80;
    const isUnlimited = !locked && total === Infinity;
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: 'var(--type-caption)', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
                {isWarning && <AlertCircle size={14} color="#f59e0b" aria-label="임계치 초과" />}
                {locked && (
                    <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: '0.2rem',
                        fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em',
                        background: '#fef3c7', color: '#92400e',
                        padding: '2px 7px', borderRadius: 'var(--radius-full)'
                    }}>
                        <Lock size={10} /> LOCKED
                    </span>
                )}
                {isUnlimited && (
                    <span style={{
                        fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.1em',
                        background: `color-mix(in srgb, ${color}, transparent 90%)`, color,
                        padding: '2px 7px', borderRadius: 'var(--radius-full)'
                    }}>UNLIMITED</span>
                )}
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', marginBottom: '0.25rem' }}>
                {formatLimit(used)}
                <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--muted)', marginLeft: '0.3rem' }}>
                    / {locked ? limitLabel || "잠금" : formatLimit(total)}
                </span>
            </div>
            {detail && (
                <div style={{ fontSize: '0.76rem', color: 'var(--muted)', fontWeight: 700, marginBottom: '0.2rem' }}>
                    {detail}
                </div>
            )}
            {!isUnlimited && !locked && (
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden', marginTop: '0.75rem' }}>
                    <div style={{
                        width: `${pct}%`, height: '100%',
                        background: isWarning ? '#f59e0b' : color,
                        borderRadius: 'var(--radius-full)', transition: 'width 0.8s ease-out'
                    }} />
                </div>
            )}
            {locked && (
                <div style={{
                    height: 6,
                    background: 'repeating-linear-gradient(45deg, #e2e8f0, #e2e8f0 4px, #f8fafc 4px, #f8fafc 8px)',
                    borderRadius: 'var(--radius-full)',
                    marginTop: '0.75rem'
                }} />
            )}
            {isUnlimited && (
                <div style={{
                    height: 6, background: `color-mix(in srgb, ${color}, transparent 85%)`,
                    borderRadius: 'var(--radius-full)', marginTop: '0.75rem',
                    backgroundImage: `repeating-linear-gradient(45deg, transparent, transparent 4px, ${color}33 4px, ${color}33 8px)`
                }} />
            )}
        </div>
    );
}
