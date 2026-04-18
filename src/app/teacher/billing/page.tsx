"use client";

import { useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { CreditCard, Check, Zap, Crown, Building, Download, Receipt, Sparkles, TrendingUp, AlertCircle } from "lucide-react";

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

const MOCK_INVOICES = [
    { id: "INV-2026-04", date: "2026-04-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 4월" },
    { id: "INV-2026-03", date: "2026-03-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 3월" },
    { id: "INV-2026-02", date: "2026-02-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 2월" },
    { id: "INV-2026-01", date: "2026-01-01", amount: 19000, status: "paid", desc: "Pro 플랜 · 2026년 1월" },
    { id: "INV-2025-12", date: "2025-12-01", amount: 0, status: "paid", desc: "Free 플랜 · 2025년 12월" },
];

export default function BillingPage() {
    const [current] = useState<Plan>("pro");
    const [yearly, setYearly] = useState(false);

    const currentPlan = PLANS.find(p => p.key === current)!;
    const usage = {
        exams: { used: 12, total: currentPlan.limits.exams },
        students: { used: 87, total: currentPlan.limits.students },
        ai: { used: 1247, total: currentPlan.limits.ai },
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
                        <UsageCard label="생성한 시험" used={usage.exams.used} total={usage.exams.total} color="#4f46e5" />
                        <UsageCard label="등록 학생" used={usage.students.used} total={usage.students.total} color="#10b981" />
                        <UsageCard label="AI 채점 크레딧" used={usage.ai.used} total={usage.ai.total} color="#ec4899" />
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
                        <button style={{ padding: '0.55rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
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
                            {MOCK_INVOICES.map(inv => (
                                <tr key={inv.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{inv.id}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem' }}>{inv.desc}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{inv.date}</td>
                                    <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem', fontWeight: 700 }}>₩{inv.amount.toLocaleString()}</td>
                                    <td style={{ padding: '1rem 0.5rem' }}>
                                        <span style={{ background: 'rgba(16,185,129,0.1)', color: '#10b981', padding: '0.25rem 0.65rem', borderRadius: 'var(--radius-full)', fontSize: '0.72rem', fontWeight: 700 }}>결제 완료</span>
                                    </td>
                                    <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                                        <button style={{ color: 'var(--primary)', fontSize: '0.85rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
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
        </div>
    );
}

function UsageCard({ label, used, total, color }: { label: string; used: number; total: number; color: string }) {
    const pct = total === Infinity ? 0 : Math.min(100, Math.round((used / total) * 100));
    const isWarning = pct > 80;
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{label}</div>
                {isWarning && <AlertCircle size={14} color="#f59e0b" />}
            </div>
            <div style={{ fontSize: '1.8rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums', marginBottom: '0.25rem' }}>
                {used.toLocaleString()}
                <span style={{ fontSize: '1rem', fontWeight: 600, color: 'var(--muted)', marginLeft: '0.3rem' }}>
                    / {total === Infinity ? "∞" : total.toLocaleString()}
                </span>
            </div>
            <div style={{ height: 6, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden', marginTop: '0.75rem' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: color, borderRadius: 'var(--radius-full)', transition: 'width 0.8s ease-out' }} />
            </div>
        </div>
    );
}
