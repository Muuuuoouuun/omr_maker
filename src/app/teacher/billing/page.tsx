"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { CreditCard, Check, Zap, Crown, Building, Download, Receipt, Sparkles, TrendingUp, AlertCircle, X, Lock } from "lucide-react";
import { formatLimit, usagePct } from "@/lib/pure";
import { toast } from "@/components/Toast";
import type { PlanKey } from "@/types/omr";
import { shouldUseDemoData } from "@/lib/demoData";
import { loadAttempts, loadExams } from "@/lib/omrPersistence";
import {
    buildBillingPlanHealth,
    buildBillingUsageSummary,
    type BillingLimitStatus,
    type BillingPlanHealthLevel,
    type BillingUsageSummary,
} from "@/lib/billingUsage";
import { billingStatusMeta, createLocalPlanChangeInvoice, type BillingInvoice } from "@/lib/billingRecords";
import {
    getPaymentProviderReadiness,
    getPaymentProviderRolloutReadiness,
    type PaymentProviderReadinessStatus,
} from "@/lib/paymentProvider";
import { readRosterStudents } from "@/lib/rosterStorage";
import { formatPaymentProviderRoadmap } from "@/lib/serviceRoadmap";
import { PLAN_BY_KEY, PLAN_CATALOG, getPlanEntitlementViews, normalizePlan, readAiRecognitionUsage, setCurrentPlan, type PlanEntitlementKey } from "@/utils/plans";

const PLAN_ICONS: Record<PlanKey, React.ReactNode> = {
    free: <Sparkles size={22} />,
    pro: <Zap size={22} />,
    academy: <Building size={22} />,
};

const MOCK_INVOICES: BillingInvoice[] = [
    { id: "INV-2026-04", date: "2026-04-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 4월" },
    { id: "INV-2026-03", date: "2026-03-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 3월" },
    { id: "INV-2026-02", date: "2026-02-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 2월" },
    { id: "INV-2026-01", date: "2026-01-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 1월" },
    { id: "INV-2025-12", date: "2025-12-01", amount: 0, status: "paid", desc: "Free 플랜 · 2025년 12월" },
];

const BILLING_ENTITLEMENT_KEYS = [
    "handwritingArchive",
    "advancedAnalytics",
    "retakeAssignments",
    "studentGrowthReports",
    "pdfExport",
    "reminders",
    "multiTeacher",
    "organizationDashboard",
] satisfies readonly PlanEntitlementKey[];

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

function readInitialPlan(): PlanKey {
    if (typeof window === "undefined") return "free";
    try {
        const rawPlan = localStorage.getItem("omr_plan");
        const parsedPlan = normalizePlan(rawPlan);
        if (parsedPlan && rawPlan === "school") localStorage.setItem("omr_plan", parsedPlan);
        return parsedPlan || "free";
    } catch {
        return "free";
    }
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
    const [current, setCurrent] = useState<PlanKey>(() => readInitialPlan());
    const [yearly, setYearly] = useState(() => readInitialBillingCycle());
    const [usage, setUsage] = useState<BillingUsageSummary>({
        examsThisMonth: 0,
        students: 0,
        aiRecognition: 0,
        attemptsThisMonth: 0,
        handwritingArchivesThisMonth: 0,
        handwritingQuestionCount: 0,
        handwritingStrokeCount: 0,
    });
    const [userInvoices, setUserInvoices] = useState<BillingInvoice[]>(() => readInitialInvoices());
    const [upgradeTarget, setUpgradeTarget] = useState<PlanKey | null>(null);
    const invoiceSeqRef = useRef(0);
    const paymentProviderReadiness = useMemo(() => getPaymentProviderReadiness(), []);
    const paymentProviderRolloutReadiness = useMemo(() => getPaymentProviderRolloutReadiness(), []);

    useEffect(() => {
        if (typeof window === "undefined") return;

        let cancelled = false;
        const hydrateUsage = async () => {
            const [examResult, attemptResult] = await Promise.all([
                loadExams(),
                loadAttempts(),
            ]);
            if (cancelled) return;

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

            setUsage(buildBillingUsageSummary({
                exams: examResult.items,
                attempts: attemptResult.items,
                students,
                aiRecognition: readAiRecognitionUsage(),
            }));

            if (examResult.remoteError || attemptResult.remoteError) {
                toast.info(
                    "로컬 사용량 기준으로 표시 중",
                    "서버 동기화가 일부 지연되어 현재 기기 데이터로 사용량을 계산했습니다."
                );
            }
        };

        void hydrateUsage();

        return () => { cancelled = true; };
    }, []);

    // Merge user-generated invoices with development-only historical demo data, newest first.
    const allInvoices = useMemo<BillingInvoice[]>(() => {
        const historicalInvoices = shouldUseDemoData() ? MOCK_INVOICES : [];
        return [...userInvoices, ...historicalInvoices].sort((a, b) => {
            const ta = new Date(a.date).getTime() || 0;
            const tb = new Date(b.date).getTime() || 0;
            return tb - ta;
        });
    }, [userInvoices]);

    const currentPlan = PLAN_BY_KEY[current];
    const nextPlan = current === "free"
        ? PLAN_BY_KEY.pro
        : current === "pro"
            ? PLAN_BY_KEY.academy
            : null;
    const currentEntitlements = useMemo(
        () => getPlanEntitlementViews(current, BILLING_ENTITLEMENT_KEYS),
        [current]
    );
    const planHealth = useMemo(
        () => buildBillingPlanHealth({
            plan: current,
            usage,
            entitlementKeys: BILLING_ENTITLEMENT_KEYS,
        }),
        [current, usage]
    );
    const planHealthMeta = PLAN_HEALTH_META[planHealth.level];
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
        const amountLabel = inv.status === "paid" ? "총 결제 금액" : "기록 금액";
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
    <div class="brand">Classin</div>
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
<div class="footer">Classin — 문의: billing@classin.app · ${statusMeta.footerNote}</div>
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
            toast.info("다운로드할 결제/플랜 기록 없음");
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
        setCurrent(upgradeTarget);
        const nextInvoices = [newInvoice, ...userInvoices];
        setUserInvoices(nextInvoices);
        if (typeof window !== "undefined") {
            setCurrentPlan(upgradeTarget);
            try { localStorage.setItem("omr_plan_invoices", JSON.stringify(nextInvoices)); } catch {}
        }
        toast.success("플랜 변경 기록됨", `${upgradePlan.name} 플랜이 이 브라우저에 적용되었습니다.`);
        setUpgradeTarget(null);
    };

    return (
        <div className="layout-main">
            <div className="orb orb-secondary" />
            <div className="orb orb-accent" />
            <TeacherHeader badge="BILLING" badgeColor="#a855f7" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div style={{ margin: '3rem 0 2rem' }}>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>결제 및 플랜</h1>
                    <p className="text-muted" style={{ fontSize: '1.05rem' }}>플랜 변경, 사용량 확인, 결제/플랜 기록을 한 곳에서.</p>
                </div>

                {/* Current plan hero */}
                <div className="bento-card" style={{
                    background: currentPlan.gradient, color: 'white', border: 'none',
                    padding: '2rem', marginBottom: '2rem', position: 'relative', overflow: 'hidden'
                }}>
                    <div style={{ position: 'absolute', top: '-30%', right: '-5%', width: 280, height: 280, background: 'radial-gradient(circle, rgba(255,255,255,0.2) 0%, transparent 70%)' }} />
                    <div style={{ position: 'relative', zIndex: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1.5rem' }}>
                        <div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                <span style={{ fontSize: '0.75rem', fontWeight: 700, background: 'rgba(255,255,255,0.2)', padding: '4px 10px', borderRadius: 'var(--radius-full)', letterSpacing: '0.08em' }}>
                                    CURRENT PLAN
                                </span>
                                {PLAN_ICONS[currentPlan.key]}
                            </div>
                            <h2 style={{ fontSize: '2.5rem', fontWeight: 900, letterSpacing: '-0.03em', marginBottom: '0.25rem' }}>{currentPlan.name}</h2>
                            <p style={{ fontSize: '1rem', opacity: 0.9 }}>{currentPlan.price} / 월 · 다음 사용 주기 {nextCycleDate}</p>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
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
                    <div style={{ position: 'relative', zIndex: 1, marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.9rem 1.1rem', background: 'rgba(255,255,255,0.15)', borderRadius: 'var(--radius-md)', backdropFilter: 'blur(10px)', width: 'fit-content', border: '1px solid rgba(255,255,255,0.2)' }}>
                        <CreditCard size={18} />
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>실결제 미연동</span>
                        <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>{paymentProviderReadiness.provider.label} · 플랜 변경은 로컬 기록으로 저장</span>
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
                            토스페이먼츠, 네이버페이, 카카오페이 순서로 운영 결제를 붙입니다. 지금 화면의 플랜 변경은 실제 과금 없이 이 브라우저의 로컬 기록만 바꿉니다.
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
                                    fontSize: '0.68rem',
                                    fontWeight: 950,
                                    whiteSpace: 'nowrap',
                                }}>
                                    {paymentProviderReadiness.label}
                                </span>
                            </div>
                            <div style={{ fontSize: '0.74rem', color: 'var(--muted)', fontWeight: 750, lineHeight: 1.45, wordBreak: 'keep-all' }}>
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
                                    fontSize: '0.72rem',
                                    fontWeight: 900
                                }}>
                                    {planHealthMeta.label}
                                </span>
                            </div>
                            <p style={{ fontSize: '0.88rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                {planHealth.title} · {planHealth.description}
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
                                            fontSize: '0.65rem',
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
                            background: planHealth.lockedEntitlements.length > 0 ? '#fffbeb' : 'var(--background)'
                        }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', alignItems: 'center', marginBottom: '0.4rem' }}>
                                <span style={{ fontSize: '0.78rem', fontWeight: 800, color: 'var(--muted)' }}>잠긴 프리미엄 기능</span>
                                <span style={{
                                    padding: '0.18rem 0.45rem',
                                    borderRadius: 'var(--radius-full)',
                                    background: planHealth.lockedEntitlements.length > 0 ? '#fef3c7' : '#d1fae5',
                                    color: planHealth.lockedEntitlements.length > 0 ? '#92400e' : '#047857',
                                    fontSize: '0.65rem',
                                    fontWeight: 900,
                                    whiteSpace: 'nowrap'
                                }}>
                                    {planHealth.lockedEntitlements.length > 0 ? `${planHealth.lockedEntitlements.length}개 잠금` : '모두 사용'}
                                </span>
                            </div>
                            <div style={{ fontSize: '1.25rem', fontWeight: 900, marginBottom: '0.2rem' }}>
                                {planHealth.lockedEntitlements.length}개
                            </div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700, lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                {planHealth.lockedEntitlements.length > 0
                                    ? planHealth.lockedEntitlementSummary
                                    : "현재 플랜에서 주요 프리미엄 기능 사용 가능"}
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
                            const unlockLabel = entitlement.unlockPlan
                                ? `${PLAN_BY_KEY[entitlement.unlockPlan].name} 필요`
                                : "준비 중";
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
                                        background: entitlement.enabled ? 'var(--surface)' : 'var(--background)',
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
                                        background: entitlement.enabled ? 'rgba(16,185,129,0.12)' : 'rgba(100,116,139,0.12)',
                                        color: entitlement.enabled ? '#059669' : 'var(--muted)'
                                    }}>
                                        {entitlement.enabled ? <Check size={16} /> : <Lock size={15} />}
                                    </div>
                                    <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.6rem', alignItems: 'center', marginBottom: '0.25rem' }}>
                                            <strong style={{ fontSize: '0.9rem' }}>{entitlement.label}</strong>
                                            <span style={{
                                                flexShrink: 0,
                                                fontSize: '0.68rem',
                                                fontWeight: 800,
                                                padding: '0.18rem 0.45rem',
                                                borderRadius: 'var(--radius-full)',
                                                color: entitlement.enabled ? '#047857' : '#92400e',
                                                background: entitlement.enabled ? '#d1fae5' : '#fef3c7',
                                            }}>
                                                {entitlement.enabled ? '사용 가능' : unlockLabel}
                                            </span>
                                        </div>
                                        <p style={{ fontSize: '0.78rem', color: 'var(--muted)', lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                            {entitlement.description}
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
                        <div style={{ display: 'inline-flex', padding: '4px', background: 'var(--surface)', borderRadius: 'var(--radius-full)', border: '1px solid var(--border)' }}>
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
                            const price = yearly ? Math.round(p.priceNum * 12 * 0.8) : p.priceNum;
                            return (
                                <div key={p.key} className="bento-card card-hover" style={{
                                    padding: '1.75rem', position: 'relative', overflow: 'hidden',
                                    border: isPro ? `2px solid ${p.color}` : '1px solid var(--border)',
                                    transform: isPro ? 'scale(1.02)' : 'none'
                                }}>
                                    {isPro && (
                                        <div style={{ position: 'absolute', top: 14, right: 14, padding: '0.2rem 0.7rem', background: p.gradient, color: 'white', borderRadius: 'var(--radius-full)', fontSize: '0.65rem', fontWeight: 800, letterSpacing: '0.08em' }}>
                                            MOST POPULAR
                                        </div>
                                    )}
                                    <div style={{ width: 46, height: 46, borderRadius: 'var(--radius-md)', background: `color-mix(in srgb, ${p.color}, transparent 88%)`, color: p.color, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem' }}>
                                        {PLAN_ICONS[p.key]}
                                    </div>
                                    <h3 style={{ fontSize: '1.4rem', fontWeight: 800, marginBottom: '0.25rem' }}>{p.name}</h3>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.3rem', marginBottom: '1.25rem' }}>
                                        <span style={{ fontSize: '2rem', fontWeight: 900, color: 'var(--foreground)', letterSpacing: '-0.03em' }}>
                                            ₩{price.toLocaleString()}
                                        </span>
                                        <span style={{ fontSize: '0.9rem', color: 'var(--muted)', fontWeight: 500 }}>/ {yearly ? "년" : "월"}</span>
                                    </div>

                                    <ul style={{ listStyle: 'none', padding: 0, marginBottom: '1.5rem' }}>
                                        {p.features.map(f => (
                                            <li key={f} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.4rem 0', fontSize: '0.88rem' }}>
                                                <Check size={15} color={p.color} style={{ flexShrink: 0 }} />
                                                <span>{f}</span>
                                            </li>
                                        ))}
                                    </ul>

                                    <button
                                        disabled={isCurrent}
                                        onClick={() => handlePlanChange(p.key)}
                                        style={{
                                            width: '100%', padding: '0.85rem', borderRadius: 'var(--radius-md)',
                                            background: isCurrent ? 'var(--background)' : isPro ? p.gradient : 'var(--surface)',
                                            color: isCurrent ? 'var(--muted)' : isPro ? 'white' : 'var(--foreground)',
                                            border: isCurrent || isPro ? 'none' : '1px solid var(--border)',
                                            fontWeight: 700, fontSize: '0.9rem', cursor: isCurrent ? 'default' : 'pointer',
                                            boxShadow: isPro && !isCurrent ? `0 4px 14px ${p.color}44` : 'none'
                                        }}
                                    >
                                        {isCurrent ? '현재 플랜' : p.key === "free" ? '다운그레이드' : '업그레이드'}
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </div>

                {/* Invoices */}
                <div className="bento-card" style={{ padding: '1.75rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                        <div>
                            <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>결제/플랜 기록</h2>
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>실결제 연동 후 영수증과 현재 로컬 플랜 변경 기록</p>
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
                            <Download size={14} /> 전체 다운로드
                        </button>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                            <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                <th style={{ padding: '0.85rem 0.5rem' }}>기록 ID</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>설명</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>날짜</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>금액</th>
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
                                            <span style={{ background: statusMeta.background, color: statusMeta.color, padding: '0.25rem 0.65rem', borderRadius: 'var(--radius-full)', fontSize: '0.72rem', fontWeight: 700 }}>
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
                                                <Receipt size={14} />
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                            {allInvoices.length === 0 && (
                                <tr>
                                    <td colSpan={6} style={{ padding: '2.5rem 0.5rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                        아직 결제/플랜 기록이 없습니다.
                                    </td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            </main>

            <style>{`
                @media (max-width: 900px) {
                    .plans-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>

            {upgradeTarget && upgradePlan && (() => {
                const basePrice = yearly ? Math.round(upgradePlan.priceNum * 12 * 0.8) : upgradePlan.priceNum;
                // Price preview is inclusive of VAT. Without a payment provider this only records a local plan change.
                const subtotal = Math.round(basePrice / 1.1);
                const vat = basePrice - subtotal;
                const actionLabel = upgradePlan.priceNum > currentPlan.priceNum ? "업그레이드" : "플랜 변경";
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
                                    {upgradePlan.features.slice(0, 5).map(f => (
                                        <li key={f} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.82rem', padding: '0.2rem 0' }}>
                                            <Check size={13} color={upgradePlan.color} style={{ flexShrink: 0 }} />
                                            <span>{f}</span>
                                        </li>
                                    ))}
                                </ul>
                            </div>

                            <div style={{ padding: '0.85rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', fontSize: '0.88rem' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0' }}>
                                    <span style={{ color: 'var(--muted)' }}>소계</span>
                                    <span style={{ fontWeight: 600 }}>₩{subtotal.toLocaleString()}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.25rem 0', borderBottom: '1px dashed var(--border)' }}>
                                    <span style={{ color: 'var(--muted)' }}>부가세 (10%)</span>
                                    <span style={{ fontWeight: 600 }}>₩{vat.toLocaleString()}</span>
                                </div>
                                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.5rem 0 0', fontSize: '0.95rem' }}>
                                    <span style={{ fontWeight: 700 }}>예상 요금</span>
                                    <span style={{ fontWeight: 900, color: upgradePlan.color }}>
                                        ₩{basePrice.toLocaleString()} / {yearly ? "년" : "월"}
                                    </span>
                                </div>
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
                                    {paymentProviderReadiness.canRecordLocalPlanChange ? "로컬 플랜 변경 기록" : "provider 설정 필요"}
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
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
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
