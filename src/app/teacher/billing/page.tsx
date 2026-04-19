"use client";

import { useEffect, useMemo, useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { CreditCard, Check, Zap, Crown, Building, Download, Receipt, Sparkles, TrendingUp, AlertCircle, X } from "lucide-react";
import { formatLimit, usagePct } from "@/lib/pure";
import { toast } from "@/components/Toast";

type Plan = "free" | "pro" | "school";

const PLANS: { key: Plan; name: string; price: string; priceNum: number; icon: React.ReactNode; color: string; gradient: string; features: string[]; limits: { exams: number; students: number; ai: number } }[] = [
    {
        key: "free", name: "Free", price: "₩0", priceNum: 0,
        icon: <Sparkles size={22} />, color: "#64748b", gradient: "linear-gradient(135deg, #94a3b8, #64748b)",
        features: ["월 시험 5개", "학생 30명", "AI 채점 월 100회", "기본 분석"],
        limits: { exams: 5, students: 30, ai: 100 }
    },
    {
        key: "pro", name: "Pro", price: "₩19,000", priceNum: 19000,
        icon: <Zap size={22} />, color: "#4f46e5", gradient: "linear-gradient(135deg, #6366f1, #4f46e5)",
        features: ["무제한 시험", "학생 300명", "AI 채점 월 5,000회", "고급 분석", "PDF 내보내기", "우선 지원"],
        limits: { exams: Infinity, students: 300, ai: 5000 }
    },
    {
        key: "school", name: "School", price: "₩99,000", priceNum: 99000,
        icon: <Building size={22} />, color: "#ec4899", gradient: "linear-gradient(135deg, #ec4899, #db2777)",
        features: ["무제한 모든 것", "무제한 학생", "AI 채점 무제한", "전담 매니저", "커스텀 도메인", "SSO 연동", "API 액세스"],
        limits: { exams: Infinity, students: Infinity, ai: Infinity }
    },
];

interface Invoice {
    id: string;
    date: string;
    amount: number;
    status: string;
    desc: string;
}

const MOCK_INVOICES: Invoice[] = [
    { id: "INV-2026-04", date: "2026-04-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 4월" },
    { id: "INV-2026-03", date: "2026-03-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 3월" },
    { id: "INV-2026-02", date: "2026-02-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 2월" },
    { id: "INV-2026-01", date: "2026-01-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 1월" },
    { id: "INV-2025-12", date: "2025-12-01", amount: 0, status: "paid", desc: "Free 플랜 · 2025년 12월" },
];

export default function BillingPage() {
    const [current, setCurrent] = useState<Plan>("pro");
    const [yearly, setYearly] = useState(false);
    const [usage, setUsage] = useState<{ exams: number; students: number; ai: number }>({ exams: 0, students: 0, ai: 0 });
    const [userInvoices, setUserInvoices] = useState<Invoice[]>([]);
    const [upgradeTarget, setUpgradeTarget] = useState<Plan | null>(null);

    useEffect(() => {
        if (typeof window === "undefined") return;

        // Exams: count keys starting with omr_exam_
        let examCount = 0;
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith("omr_exam_")) examCount++;
        }

        // Students: prefer omr_students, else unique names from omr_attempts
        let studentCount = 0;
        try {
            const rawStudents = localStorage.getItem("omr_students");
            if (rawStudents) {
                const parsed = JSON.parse(rawStudents);
                if (Array.isArray(parsed)) studentCount = parsed.length;
            } else {
                const rawAttempts = localStorage.getItem("omr_attempts");
                if (rawAttempts) {
                    const attempts = JSON.parse(rawAttempts);
                    if (Array.isArray(attempts)) {
                        const names = new Set<string>();
                        for (const a of attempts) {
                            if (a && typeof a.studentName === "string") names.add(a.studentName);
                            else if (a && typeof a.name === "string") names.add(a.name);
                        }
                        studentCount = names.size;
                    }
                }
            }
        } catch {
            studentCount = 0;
        }

        // AI usage
        let aiCount = 0;
        try {
            const rawAi = localStorage.getItem("omr_ai_usage");
            if (rawAi !== null) {
                const n = Number(rawAi);
                if (!Number.isNaN(n)) aiCount = n;
            }
        } catch {
            aiCount = 0;
        }

        setUsage({ exams: examCount, students: studentCount, ai: aiCount });

        // Plan
        try {
            const rawPlan = localStorage.getItem("omr_plan");
            if (rawPlan === "free" || rawPlan === "pro" || rawPlan === "school") {
                setCurrent(rawPlan);
            }
        } catch {
            // keep default
        }

        // Billing cycle
        try {
            const rawCycle = localStorage.getItem("omr_billing_cycle");
            if (rawCycle === "yearly") setYearly(true);
            else if (rawCycle === "monthly") setYearly(false);
        } catch {
            // keep default
        }

        // User-generated invoices (from past upgrades)
        try {
            const rawInv = localStorage.getItem("omr_plan_invoices");
            if (rawInv) {
                const parsed = JSON.parse(rawInv);
                if (Array.isArray(parsed)) setUserInvoices(parsed as Invoice[]);
            }
        } catch {
            // keep default
        }
    }, []);

    // Merge user-generated invoices with MOCK historical data, newest first
    const allInvoices = useMemo<Invoice[]>(() => {
        return [...userInvoices, ...MOCK_INVOICES].sort((a, b) => {
            const ta = new Date(a.date).getTime() || 0;
            const tb = new Date(b.date).getTime() || 0;
            return tb - ta;
        });
    }, [userInvoices]);

    const currentPlan = PLANS.find(p => p.key === current)!;

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

    const downloadInvoice = (inv: Invoice) => {
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
.paid { display: inline-block; background: rgba(16,185,129,0.1); color: #10b981; padding: 4px 12px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.05em; }
.footer { margin-top: 40px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b; text-align: center; }
</style></head><body>
<div class="header">
  <div>
    <div class="brand">Classin</div>
    <div style="color: #64748b; font-size: 13px; margin-top: 4px;">OMR Maker Platform</div>
  </div>
  <div class="meta">
    <strong>Invoice</strong><br>
    Date: ${inv.date}<br>
    <span class="paid">PAID</span>
  </div>
</div>
<h1>결제 영수증</h1>
<div class="id">${inv.id}</div>
<table>
  <thead><tr><th>항목</th><th style="text-align: right;">금액</th></tr></thead>
  <tbody>
    <tr><td>${inv.desc}</td><td style="text-align: right; font-weight: 600;">₩${inv.amount.toLocaleString()}</td></tr>
    <tr><td style="color: #64748b;">부가세 (10%)</td><td style="text-align: right; color: #64748b;">포함</td></tr>
    <tr><td><strong>총 결제 금액</strong></td><td style="text-align: right;" class="total">₩${inv.amount.toLocaleString()}</td></tr>
  </tbody>
</table>
<div class="footer">Classin — 문의: billing@classin.app · 이 영수증은 자동 생성되었습니다.</div>
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
        const list = [...userInvoices, ...MOCK_INVOICES];
        list.forEach((inv, i) => {
            setTimeout(() => downloadInvoice(inv), i * 150);
        });
    };

    const handlePlanChange = (next: Plan) => {
        if (next === current) return;
        setUpgradeTarget(next);
    };

    const upgradePlan = upgradeTarget ? PLANS.find(p => p.key === upgradeTarget) ?? null : null;

    const confirmPlanChange = () => {
        if (!upgradeTarget || !upgradePlan) return;
        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, "0");
        const dd = String(now.getDate()).padStart(2, "0");
        const basePrice = yearly ? Math.round(upgradePlan.priceNum * 12 * 0.8) : upgradePlan.priceNum;
        const newInvoice: Invoice = {
            id: `INV-${yyyy}-${mm}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
            date: `${yyyy}-${mm}-${dd}`,
            amount: basePrice,
            status: "paid",
            desc: `${upgradePlan.name} 플랜 · ${yyyy}년 ${Number(mm)}월${yearly ? " (연간)" : ""}`,
        };
        setCurrent(upgradeTarget);
        const nextInvoices = [newInvoice, ...userInvoices];
        setUserInvoices(nextInvoices);
        if (typeof window !== "undefined") {
            try { localStorage.setItem("omr_plan", upgradeTarget); } catch {}
            try { localStorage.setItem("omr_plan_invoices", JSON.stringify(nextInvoices)); } catch {}
        }
        toast.success("플랜 변경 완료", `${upgradePlan.name} 플랜으로 변경되었습니다.`);
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
                    <p className="text-muted" style={{ fontSize: '1.05rem' }}>플랜 변경, 사용량 확인, 인보이스를 한 곳에서.</p>
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
                                {currentPlan.icon}
                            </div>
                            <h2 style={{ fontSize: '2.5rem', fontWeight: 900, letterSpacing: '-0.03em', marginBottom: '0.25rem' }}>{currentPlan.name}</h2>
                            <p style={{ fontSize: '1rem', opacity: 0.9 }}>{currentPlan.price} / 월 · 다음 결제 2026-05-01</p>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                            <button style={{ padding: '0.75rem 1.25rem', background: 'rgba(255,255,255,0.2)', color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 700, border: '1px solid rgba(255,255,255,0.3)', backdropFilter: 'blur(10px)', fontSize: '0.9rem' }}>결제 수단 변경</button>
                            <button style={{ padding: '0.75rem 1.25rem', background: 'white', color: currentPlan.color, borderRadius: 'var(--radius-full)', fontWeight: 700, fontSize: '0.9rem', boxShadow: '0 4px 14px rgba(0,0,0,0.15)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                <Crown size={16} /> 업그레이드
                            </button>
                        </div>
                    </div>

                    {/* Payment method */}
                    <div style={{ position: 'relative', zIndex: 1, marginTop: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.9rem 1.1rem', background: 'rgba(255,255,255,0.15)', borderRadius: 'var(--radius-md)', backdropFilter: 'blur(10px)', width: 'fit-content', border: '1px solid rgba(255,255,255,0.2)' }}>
                        <CreditCard size={18} />
                        <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>Visa •••• 4242</span>
                        <span style={{ fontSize: '0.8rem', opacity: 0.8 }}>만료 06/28</span>
                    </div>
                </div>

                {/* Usage */}
                <div style={{ marginBottom: '2rem' }}>
                    <h2 style={{ fontSize: '1.4rem', fontWeight: 700, marginBottom: '1rem' }}>이달 사용량</h2>
                    <div className="bento-grid">
                        <UsageCard label="생성한 시험" used={usage.exams} total={currentPlan.limits.exams} color="#4f46e5" />
                        <UsageCard label="등록 학생" used={usage.students} total={currentPlan.limits.students} color="#10b981" />
                        <UsageCard label="AI 채점 크레딧" used={usage.ai} total={currentPlan.limits.ai} color="#ec4899" />
                        <div className="bento-card" style={{ padding: '1.5rem', background: 'linear-gradient(135deg, rgba(99,102,241,0.08), rgba(236,72,153,0.08))', border: '1px solid rgba(99,102,241,0.2)' }}>
                            <TrendingUp size={22} color="var(--primary)" style={{ marginBottom: '0.75rem' }} />
                            <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.05em', marginBottom: '0.3rem' }}>사용 추이</div>
                            <div style={{ fontSize: '1.4rem', fontWeight: 800 }}>+23%</div>
                            <div style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>전월 대비</div>
                        </div>
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
                            <button onClick={() => setYearly(false)} style={{
                                padding: '0.5rem 1.1rem', borderRadius: 'var(--radius-full)', fontSize: '0.85rem', fontWeight: 600,
                                background: !yearly ? 'var(--primary)' : 'transparent',
                                color: !yearly ? 'white' : 'var(--muted)', transition: 'var(--transition-base)'
                            }}>월간</button>
                            <button onClick={() => setYearly(true)} style={{
                                padding: '0.5rem 1.1rem', borderRadius: 'var(--radius-full)', fontSize: '0.85rem', fontWeight: 600,
                                background: yearly ? 'var(--primary)' : 'transparent',
                                color: yearly ? 'white' : 'var(--muted)', transition: 'var(--transition-base)',
                                display: 'flex', alignItems: 'center', gap: '0.3rem'
                            }}>연간 <span style={{ fontSize: '0.7rem', background: 'rgba(16,185,129,0.2)', color: '#10b981', padding: '2px 7px', borderRadius: 'var(--radius-full)', fontWeight: 700 }}>-20%</span></button>
                        </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1.25rem' }} className="plans-grid">
                        {PLANS.map(p => {
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
                                        {p.icon}
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
                            <h2 style={{ fontSize: '1.2rem', fontWeight: 700 }}>결제 내역</h2>
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>최근 12개월</p>
                        </div>
                        <button onClick={downloadAllInvoices} style={{ padding: '0.55rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                            <Download size={14} /> 전체 다운로드
                        </button>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                        <thead>
                            <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                <th style={{ padding: '0.85rem 0.5rem' }}>인보이스</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>설명</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>날짜</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>금액</th>
                                <th style={{ padding: '0.85rem 0.5rem' }}>상태</th>
                                <th style={{ padding: '0.85rem 0.5rem', textAlign: 'right' }}>PDF</th>
                            </tr>
                        </thead>
                        <tbody>
                            {allInvoices.map(inv => (
                                <tr key={inv.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{inv.id}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem' }}>{inv.desc}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{inv.date}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem', fontWeight: 700 }}>₩{inv.amount.toLocaleString()}</td>
                                    <td style={{ padding: '1rem 0.5rem' }}>
                                        <span style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981', padding: '0.25rem 0.65rem', borderRadius: 'var(--radius-full)', fontSize: '0.72rem', fontWeight: 700 }}>결제 완료</span>
                                    </td>
                                    <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                                        <button
                                            onClick={() => downloadInvoice(inv)}
                                            title="영수증 다운로드"
                                            aria-label={`${inv.id} 영수증 다운로드`}
                                            style={{ color: 'var(--primary)', fontSize: '0.85rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.5rem', borderRadius: 'var(--radius-sm)' }}
                                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.08)'}
                                            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                                        >
                                            <Receipt size={14} />
                                        </button>
                                    </td>
                                </tr>
                            ))}
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
                // price is inclusive of VAT in this mock: compute subtotal + vat = basePrice.
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
                                    {upgradePlan.icon}
                                    <span style={{ fontSize: '0.95rem', fontWeight: 800, color: 'var(--foreground)' }}>{upgradePlan.name} · {yearly ? "연간" : "월간"}</span>
                                </div>
                                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                                    {upgradePlan.features.slice(0, 4).map(f => (
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
                                    <span style={{ fontWeight: 700 }}>총 결제 금액</span>
                                    <span style={{ fontWeight: 900, color: upgradePlan.color }}>
                                        ₩{basePrice.toLocaleString()} / {yearly ? "년" : "월"}
                                    </span>
                                </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.7rem 0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: '1.25rem' }}>
                                <CreditCard size={16} color="var(--muted)" />
                                <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>Visa •••• 4242</span>
                                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: 'var(--muted)' }}>만료 06/28</span>
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
                                    style={{
                                        padding: '0.7rem 1.25rem', background: upgradePlan.gradient,
                                        color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 800, fontSize: '0.9rem',
                                        boxShadow: `0 4px 14px ${upgradePlan.color}55`
                                    }}
                                >
                                    결제하기
                                </button>
                            </div>
                        </div>
                    </div>
                );
            })()}
        </div>
    );
}

function UsageCard({ label, used, total, color }: { label: string; used: number; total: number; color: string }) {
    const pct = usagePct(used, total);
    const isWarning = pct > 80;
    const isUnlimited = total === Infinity;
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
                {isWarning && <AlertCircle size={14} color="#f59e0b" aria-label="임계치 초과" />}
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
                    / {formatLimit(total)}
                </span>
            </div>
            {!isUnlimited && (
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden', marginTop: '0.75rem' }}>
                    <div style={{
                        width: `${pct}%`, height: '100%',
                        background: isWarning ? '#f59e0b' : color,
                        borderRadius: 'var(--radius-full)', transition: 'width 0.8s ease-out'
                    }} />
                </div>
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
