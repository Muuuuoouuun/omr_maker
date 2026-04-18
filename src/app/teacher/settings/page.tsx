"use client";

import { useState } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { User, Bell, FileText, CheckCircle, Key, Palette, Shield, Copy, Eye, EyeOff, Save } from "lucide-react";

type Section = "profile" | "notifications" | "exam-defaults" | "grading" | "api" | "theme" | "security";

const SECTIONS: { key: Section; label: string; icon: React.ReactNode; color: string }[] = [
    { key: "profile", label: "프로필", icon: <User size={18} />, color: "#4f46e5" },
    { key: "notifications", label: "알림", icon: <Bell size={18} />, color: "#ec4899" },
    { key: "exam-defaults", label: "시험 기본값", icon: <FileText size={18} />, color: "#8b5cf6" },
    { key: "grading", label: "채점", icon: <CheckCircle size={18} />, color: "#10b981" },
    { key: "api", label: "API 키", icon: <Key size={18} />, color: "#f59e0b" },
    { key: "theme", label: "테마", icon: <Palette size={18} />, color: "#0ea5e9" },
    { key: "security", label: "보안", icon: <Shield size={18} />, color: "#ef4444" },
];

export default function SettingsPage() {
    const [section, setSection] = useState<Section>("profile");
    const [showKey, setShowKey] = useState(false);

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-accent" />
            <TeacherHeader badge="SETTINGS" badgeColor="#6366f1" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div style={{ margin: '3rem 0 2rem' }}>
                    <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>설정</h1>
                    <p className="text-muted" style={{ fontSize: '1.05rem' }}>프로필, 알림, 시험 기본값을 관리하세요.</p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: '1.5rem' }} className="settings-grid">
                    {/* Side nav */}
                    <aside className="bento-card" style={{ padding: '0.75rem', alignSelf: 'flex-start', position: 'sticky', top: '5.5rem' }}>
                        {SECTIONS.map(s => (
                            <button
                                key={s.key}
                                onClick={() => setSection(s.key)}
                                style={{
                                    width: '100%', display: 'flex', alignItems: 'center', gap: '0.75rem',
                                    padding: '0.75rem 0.9rem', borderRadius: 'var(--radius-md)',
                                    background: section === s.key ? `color-mix(in srgb, ${s.color}, transparent 88%)` : 'transparent',
                                    color: section === s.key ? s.color : 'var(--muted)',
                                    fontWeight: section === s.key ? 700 : 500,
                                    fontSize: '0.9rem', transition: 'var(--transition-base)', textAlign: 'left'
                                }}
                            >
                                {s.icon}
                                {s.label}
                            </button>
                        ))}
                    </aside>

                    {/* Content */}
                    <section>
                        {section === "profile" && <ProfileSection />}
                        {section === "notifications" && <NotificationsSection />}
                        {section === "exam-defaults" && <ExamDefaultsSection />}
                        {section === "grading" && <GradingSection />}
                        {section === "api" && <ApiSection showKey={showKey} setShowKey={setShowKey} />}
                        {section === "theme" && <ThemeSection />}
                        {section === "security" && <SecuritySection />}
                    </section>
                </div>
            </main>

            <style>{`
                @media (max-width: 768px) {
                    .settings-grid { grid-template-columns: 1fr !important; }
                }
            `}</style>
        </div>
    );
}

function Card({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
    return (
        <div className="bento-card" style={{ padding: '2rem', marginBottom: '1.25rem', animation: 'fadeIn 0.3s both' }}>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: desc ? '0.25rem' : '1.5rem' }}>{title}</h2>
            {desc && <p style={{ fontSize: '0.9rem', color: 'var(--muted)', marginBottom: '1.5rem' }}>{desc}</p>}
            {children}
        </div>
    );
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <div style={{ marginBottom: '1.25rem' }}>
            <label style={{ display: 'block', fontSize: '0.8rem', fontWeight: 700, color: 'var(--foreground)', marginBottom: '0.5rem', letterSpacing: '0.02em' }}>{label}</label>
            {children}
            {hint && <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.4rem' }}>{hint}</div>}
        </div>
    );
}

function Toggle({ checked, onChange, label, desc }: { checked: boolean; onChange: (v: boolean) => void; label: string; desc?: string }) {
    return (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ flex: 1, paddingRight: '1rem' }}>
                <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>{label}</div>
                {desc && <div style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: '0.2rem' }}>{desc}</div>}
            </div>
            <button
                onClick={() => onChange(!checked)}
                style={{
                    width: 44, height: 24, borderRadius: 12, position: 'relative',
                    background: checked ? 'var(--primary)' : 'var(--border)',
                    transition: 'var(--transition-base)', flexShrink: 0
                }}
            >
                <div style={{
                    width: 18, height: 18, borderRadius: '50%', background: 'white',
                    position: 'absolute', top: 3, left: checked ? 23 : 3,
                    transition: 'left 0.2s ease', boxShadow: '0 1px 3px rgba(0,0,0,0.2)'
                }} />
            </button>
        </div>
    );
}

function SaveBar() {
    return (
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid var(--border)' }}>
            <button style={{ padding: '0.7rem 1.4rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.9rem' }}>취소</button>
            <button style={{ padding: '0.7rem 1.4rem', background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.4rem', boxShadow: '0 4px 12px rgba(99,102,241,0.3)' }}>
                <Save size={14} /> 저장
            </button>
        </div>
    );
}

function ProfileSection() {
    const [notif, setNotif] = useState(true);
    return (
        <Card title="프로필" desc="공개적으로 보여질 정보를 관리하세요.">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem', marginBottom: '1.5rem', padding: '1.25rem', background: 'var(--background)', borderRadius: 'var(--radius-md)' }}>
                <div style={{ width: 72, height: 72, borderRadius: '50%', background: 'linear-gradient(135deg, #4f46e5, #8b5cf6)', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.8rem', fontWeight: 800 }}>K</div>
                <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '1.05rem', fontWeight: 700 }}>김선생</div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>teacher@school.ac.kr</div>
                </div>
                <button style={{ padding: '0.6rem 1.1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontSize: '0.85rem', fontWeight: 600 }}>이미지 변경</button>
            </div>

            <Field label="이름"><input className="input-field" defaultValue="김선생" /></Field>
            <Field label="이메일" hint="로그인 및 알림에 사용됩니다."><input className="input-field" defaultValue="teacher@school.ac.kr" /></Field>
            <Field label="소속"><input className="input-field" defaultValue="한빛고등학교" /></Field>
            <Field label="담당 과목"><input className="input-field" defaultValue="수학 · 과학" /></Field>

            <Toggle checked={notif} onChange={setNotif} label="공개 프로필" desc="학생들이 내 이름과 소속을 볼 수 있습니다." />

            <SaveBar />
        </Card>
    );
}

function NotificationsSection() {
    const [email, setEmail] = useState(true);
    const [push, setPush] = useState(true);
    const [weekly, setWeekly] = useState(false);
    const [autoRemind, setAutoRemind] = useState(true);
    return (
        <Card title="알림" desc="언제, 어떤 방식으로 알림을 받을지 설정하세요.">
            <Toggle checked={email} onChange={setEmail} label="이메일 알림" desc="학생 제출, 성적 집계, 시스템 공지" />
            <Toggle checked={push} onChange={setPush} label="브라우저 푸시" desc="실시간 시험 현황 알림" />
            <Toggle checked={weekly} onChange={setWeekly} label="주간 리포트" desc="매주 월요일 오전 9시, 지난 주 요약" />
            <Toggle checked={autoRemind} onChange={setAutoRemind} label="미응시 학생 자동 독려" desc="시험 시작 24시간 전 자동 알림 발송" />

            <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(99,102,241,0.05)', borderRadius: 'var(--radius-md)', border: '1px solid rgba(99,102,241,0.15)' }}>
                <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--primary)', marginBottom: '0.5rem' }}>알림 정숙 시간</div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <input type="time" className="input-field" defaultValue="22:00" style={{ width: 140 }} />
                    <span style={{ color: 'var(--muted)' }}>~</span>
                    <input type="time" className="input-field" defaultValue="07:00" style={{ width: 140 }} />
                </div>
            </div>

            <SaveBar />
        </Card>
    );
}

function ExamDefaultsSection() {
    return (
        <Card title="시험 기본값" desc="새 시험 생성 시 자동으로 적용될 값을 설정하세요.">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <Field label="기본 문항 수"><input className="input-field" type="number" defaultValue={20} /></Field>
                <Field label="기본 시간 (분)"><input className="input-field" type="number" defaultValue={50} /></Field>
                <Field label="문항당 기본 배점"><input className="input-field" type="number" defaultValue={5} step={0.5} /></Field>
                <Field label="선택지 수">
                    <select className="input-field" defaultValue={5}>
                        <option value={4}>4지선다</option>
                        <option value={5}>5지선다</option>
                    </select>
                </Field>
            </div>
            <Field label="자동 저장 주기" hint="편집 중 자동으로 저장됩니다.">
                <select className="input-field" defaultValue={30}>
                    <option value={10}>10초</option>
                    <option value={30}>30초</option>
                    <option value={60}>1분</option>
                    <option value={0}>수동</option>
                </select>
            </Field>
            <SaveBar />
        </Card>
    );
}

function GradingSection() {
    const [negative, setNegative] = useState(false);
    const [partial, setPartial] = useState(true);
    const [autoRelease, setAutoRelease] = useState(false);
    return (
        <Card title="채점 규칙" desc="점수 계산 방식을 설정하세요.">
            <Toggle checked={negative} onChange={setNegative} label="오답 감점 허용" desc="오답 시 문항 배점의 일부를 감점합니다." />
            <Toggle checked={partial} onChange={setPartial} label="부분 점수 허용" desc="서술형 문항에서 부분 점수를 부여합니다." />
            <Toggle checked={autoRelease} onChange={setAutoRelease} label="제출 즉시 성적 공개" desc="학생에게 제출 직후 점수를 보여줍니다." />

            <Field label="반올림 방식">
                <select className="input-field" defaultValue="half">
                    <option value="half">반올림 (소수점 0.5)</option>
                    <option value="up">올림</option>
                    <option value="down">버림</option>
                    <option value="none">그대로 표시</option>
                </select>
            </Field>
            <SaveBar />
        </Card>
    );
}

function ApiSection({ showKey, setShowKey }: { showKey: boolean; setShowKey: (v: boolean) => void }) {
    const realKey = "AIzaSyBbreLmNTPHKOHgS9HuRjAnjg1Zt8lYbjY";
    const maskedKey = realKey.slice(0, 8) + "•".repeat(Math.max(0, realKey.length - 11)) + realKey.slice(-3);
    return (
        <Card title="API 키" desc="Gemini 연동을 위한 API 키를 관리하세요.">
            <div style={{ padding: '1rem 1.25rem', background: 'linear-gradient(135deg, rgba(245,158,11,0.06), rgba(239,68,68,0.06))', borderRadius: 'var(--radius-md)', border: '1px solid rgba(245,158,11,0.25)', marginBottom: '1.5rem', display: 'flex', gap: '0.75rem' }}>
                <Shield size={20} color="#f59e0b" style={{ flexShrink: 0, marginTop: 2 }} />
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>
                    API 키는 브라우저에만 저장되며 서버로 전송되지 않습니다. 키는 다른 기기와 공유되지 않습니다.
                </div>
            </div>

            <Field label="Gemini API Key" hint={<span>키 발급: <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)', fontWeight: 600 }}>aistudio.google.com/apikey</a></span>}>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                        className="input-field"
                        type={showKey ? "text" : "password"}
                        value={showKey ? realKey : maskedKey}
                        readOnly
                        style={{ fontFamily: 'var(--font-mono)', fontSize: '0.85rem' }}
                    />
                    <button onClick={() => setShowKey(!showKey)} style={{ padding: '0.7rem', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--radius-md)', color: 'var(--muted)' }}>
                        {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                    <button style={{ padding: '0.7rem', border: '1px solid var(--border)', background: 'var(--surface)', borderRadius: 'var(--radius-md)', color: 'var(--muted)' }}>
                        <Copy size={18} />
                    </button>
                </div>
            </Field>

            <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>이달 사용량</span>
                    <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--primary)' }}>1,247 / 10,000 req</span>
                </div>
                <div style={{ height: 6, background: 'var(--border)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
                    <div style={{ width: '12.47%', height: '100%', background: 'linear-gradient(90deg, var(--primary), var(--secondary))' }} />
                </div>
            </div>

            <SaveBar />
        </Card>
    );
}

function ThemeSection() {
    const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
    const [motion, setMotion] = useState(true);
    return (
        <Card title="테마" desc="화면 모습을 내 스타일대로 꾸며보세요.">
            <Field label="색상 모드">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
                    {[
                        { key: "light", label: "라이트", preview: "linear-gradient(135deg, #f8fafc, #e2e8f0)" },
                        { key: "dark", label: "다크", preview: "linear-gradient(135deg, #1e293b, #0f172a)" },
                        { key: "auto", label: "시스템 설정", preview: "linear-gradient(135deg, #f8fafc 50%, #1e293b 50%)" },
                    ].map(t => (
                        <button key={t.key} style={{
                            padding: '1rem', borderRadius: 'var(--radius-md)',
                            border: t.key === "light" ? '2px solid var(--primary)' : '1px solid var(--border)',
                            background: 'var(--surface)', cursor: 'pointer', textAlign: 'left'
                        }}>
                            <div style={{ height: 60, borderRadius: 'var(--radius-sm)', background: t.preview, marginBottom: '0.6rem', border: '1px solid var(--border)' }} />
                            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{t.label}</div>
                        </button>
                    ))}
                </div>
            </Field>

            <Field label="액센트 색상">
                <div style={{ display: 'flex', gap: '0.75rem' }}>
                    {["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444"].map((c, i) => (
                        <button key={c} style={{
                            width: 36, height: 36, borderRadius: '50%', background: c,
                            border: i === 0 ? '3px solid var(--foreground)' : '3px solid transparent',
                            boxShadow: i === 0 ? `0 0 0 2px ${c}` : 'none'
                        }} />
                    ))}
                </div>
            </Field>

            <Field label="밀도">
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                    {(["comfortable", "compact"] as const).map(d => (
                        <button key={d} onClick={() => setDensity(d)} style={{
                            flex: 1, padding: '0.7rem', borderRadius: 'var(--radius-md)',
                            border: density === d ? '2px solid var(--primary)' : '1px solid var(--border)',
                            background: density === d ? 'rgba(99,102,241,0.05)' : 'var(--surface)',
                            fontWeight: 600, fontSize: '0.85rem', color: density === d ? 'var(--primary)' : 'var(--foreground)'
                        }}>
                            {d === "comfortable" ? "편안하게" : "촘촘하게"}
                        </button>
                    ))}
                </div>
            </Field>

            <Toggle checked={motion} onChange={setMotion} label="모션 효과" desc="카드 호버, 애니메이션 사용" />

            <SaveBar />
        </Card>
    );
}

function SecuritySection() {
    return (
        <Card title="보안" desc="계정 보안을 관리하세요.">
            <Field label="비밀번호 변경">
                <input className="input-field" type="password" placeholder="현재 비밀번호" style={{ marginBottom: '0.5rem' }} />
                <input className="input-field" type="password" placeholder="새 비밀번호" style={{ marginBottom: '0.5rem' }} />
                <input className="input-field" type="password" placeholder="새 비밀번호 확인" />
            </Field>

            <Toggle checked={false} onChange={() => { }} label="2단계 인증" desc="로그인 시 앱에서 추가 코드 입력" />
            <Toggle checked={true} onChange={() => { }} label="로그인 알림" desc="새 기기 로그인 시 이메일 발송" />

            <Field label="활성 세션">
                <div style={{ padding: '0.85rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Chrome · macOS</div>
                        <div style={{ fontSize: '0.78rem', color: 'var(--muted)' }}>현재 세션 · 서울</div>
                    </div>
                    <span className="badge badge-success">현재</span>
                </div>
            </Field>
            <SaveBar />
        </Card>
    );
}
