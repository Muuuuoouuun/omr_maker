"use client";

import { useState, useMemo } from "react";
import TeacherHeader from "@/components/TeacherHeader";
import { Users, UserPlus, Upload, Search, Mail, TrendingUp, TrendingDown, MoreVertical, Link as LinkIcon, FolderPlus, CheckCircle2, Clock, X } from "lucide-react";

type TabType = "students" | "groups" | "invites";

interface Student {
    id: string;
    name: string;
    email: string;
    group: string;
    avatar: string;
    avgScore: number;
    examsTaken: number;
    lastActive: string;
    trend: "up" | "down" | "flat";
    status: "active" | "idle";
}

const AVATAR_COLORS = ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b", "#0ea5e9", "#ef4444"];

const MOCK_STUDENTS: Student[] = Array.from({ length: 24 }).map((_, i) => {
    const names = ["김민준", "이서연", "박도윤", "최예은", "정하준", "강지우", "조시우", "윤수아", "장재윤", "임유나", "한건우", "오하윤", "서지호", "신서아", "권선우", "황지민", "안윤서", "송태호", "류예준", "홍채원", "전주원", "고은서", "문이준", "양리아"];
    const groups = ["3학년 A반", "3학년 B반", "2학년 A반", "2학년 B반", "1학년 A반"];
    return {
        id: `s-${i}`,
        name: names[i],
        email: `${names[i].toLowerCase().replace(/\s/g, '')}${i}@school.ac.kr`,
        group: groups[i % groups.length],
        avatar: AVATAR_COLORS[i % AVATAR_COLORS.length],
        avgScore: Math.round(55 + Math.random() * 40),
        examsTaken: Math.floor(3 + Math.random() * 15),
        lastActive: `${Math.floor(Math.random() * 48)}시간 전`,
        trend: (["up", "down", "flat"] as const)[i % 3],
        status: Math.random() > 0.3 ? "active" : "idle",
    };
});

const MOCK_GROUPS = [
    { id: "g1", name: "3학년 A반", count: 28, avgScore: 82, color: "#4f46e5" },
    { id: "g2", name: "3학년 B반", count: 26, avgScore: 78, color: "#ec4899" },
    { id: "g3", name: "2학년 A반", count: 30, avgScore: 75, color: "#8b5cf6" },
    { id: "g4", name: "2학년 B반", count: 29, avgScore: 80, color: "#10b981" },
    { id: "g5", name: "1학년 A반", count: 25, avgScore: 73, color: "#f59e0b" },
];

const MOCK_INVITES = [
    { id: "i1", email: "new.student1@school.ac.kr", sentAt: "2시간 전", status: "pending" },
    { id: "i2", email: "new.student2@school.ac.kr", sentAt: "어제", status: "pending" },
    { id: "i3", email: "parent.notify@gmail.com", sentAt: "3일 전", status: "accepted" },
    { id: "i4", email: "transferred@school.ac.kr", sentAt: "1주 전", status: "expired" },
];

export default function ManageUsersPage() {
    const [tab, setTab] = useState<TabType>("students");
    const [query, setQuery] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const filtered = useMemo(() =>
        MOCK_STUDENTS.filter(s =>
            s.name.toLowerCase().includes(query.toLowerCase()) ||
            s.email.toLowerCase().includes(query.toLowerCase()) ||
            s.group.includes(query)
        ), [query]);

    const selected = MOCK_STUDENTS.find(s => s.id === selectedId);

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-accent" />
            <TeacherHeader badge="USERS" badgeColor="#22c55e" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div style={{ margin: '3rem 0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '2rem', flexWrap: 'wrap' }}>
                    <div>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>
                            사용자 관리
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.05rem' }}>
                            학생, 반, 초대를 한 곳에서 관리하세요.
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button style={{
                            padding: '0.75rem 1.25rem', background: 'var(--surface)', border: '1px solid var(--border)',
                            borderRadius: 'var(--radius-full)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem',
                            transition: 'var(--transition-base)', color: 'var(--foreground)'
                        }} className="card-hover">
                            <Upload size={16} /> CSV 업로드
                        </button>
                        <button style={{
                            padding: '0.75rem 1.5rem', background: 'linear-gradient(135deg, #22c55e, #10b981)',
                            color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 600,
                            display: 'flex', alignItems: 'center', gap: '0.5rem',
                            boxShadow: '0 4px 12px rgba(34,197,94,0.3)'
                        }}>
                            <UserPlus size={16} /> 학생 초대
                        </button>
                    </div>
                </div>

                {/* KPI */}
                <div className="bento-grid" style={{ marginBottom: '1.25rem' }}>
                    <KPI label="전체 학생" value={MOCK_STUDENTS.length} color="#4f46e5" icon={<Users size={22} />} />
                    <KPI label="활동 중" value={MOCK_STUDENTS.filter(s => s.status === "active").length} color="#10b981" icon={<CheckCircle2 size={22} />} />
                    <KPI label="반 개수" value={MOCK_GROUPS.length} color="#8b5cf6" icon={<FolderPlus size={22} />} />
                    <KPI label="미수락 초대" value={MOCK_INVITES.filter(i => i.status === "pending").length} color="#f59e0b" icon={<Clock size={22} />} />
                </div>

                {/* Sub-tabs */}
                <div style={{
                    display: 'flex', gap: '0.5rem', marginBottom: '1.5rem',
                    background: 'var(--surface)', padding: '0.5rem', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border)', width: 'fit-content',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.02)'
                }}>
                    {([
                        { key: "students", label: `학생 (${MOCK_STUDENTS.length})` },
                        { key: "groups", label: `반 · 그룹 (${MOCK_GROUPS.length})` },
                        { key: "invites", label: `초대 (${MOCK_INVITES.length})` },
                    ] as const).map(t => (
                        <button
                            key={t.key}
                            onClick={() => setTab(t.key)}
                            style={{
                                padding: '0.65rem 1.4rem', borderRadius: 'var(--radius-md)',
                                background: tab === t.key ? 'var(--primary)' : 'transparent',
                                color: tab === t.key ? 'white' : 'var(--muted)',
                                fontWeight: tab === t.key ? 700 : 500, fontSize: '0.9rem',
                                whiteSpace: 'nowrap', transition: 'var(--transition-base)'
                            }}>
                            {t.label}
                        </button>
                    ))}
                </div>

                {tab === "students" && (
                    <div style={{ display: 'grid', gridTemplateColumns: selectedId ? '1fr 380px' : '1fr', gap: '1.25rem' }}>
                        <div className="bento-card" style={{ padding: '1.5rem' }}>
                            {/* Search */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.25rem', padding: '0.75rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                <Search size={16} color="var(--muted)" />
                                <input
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder="이름, 이메일, 반 검색"
                                    style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--foreground)', fontSize: '0.95rem' }}
                                />
                                <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{filtered.length}명</span>
                            </div>

                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                                <thead>
                                    <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                        <th style={{ padding: '0.85rem 0.5rem' }}>학생</th>
                                        <th style={{ padding: '0.85rem 0.5rem' }}>반</th>
                                        <th style={{ padding: '0.85rem 0.5rem' }}>평균 점수</th>
                                        <th style={{ padding: '0.85rem 0.5rem' }}>응시 수</th>
                                        <th style={{ padding: '0.85rem 0.5rem' }}>최근 활동</th>
                                        <th style={{ padding: '0.85rem 0.5rem', width: 40 }}></th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {filtered.map(s => (
                                        <tr key={s.id}
                                            onClick={() => setSelectedId(s.id)}
                                            style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.2s', background: selectedId === s.id ? 'rgba(99,102,241,0.05)' : 'transparent' }}
                                            onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.04)'}
                                            onMouseLeave={e => e.currentTarget.style.background = selectedId === s.id ? 'rgba(99,102,241,0.05)' : 'transparent'}
                                        >
                                            <td style={{ padding: '0.85rem 0.5rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                                    <div style={{ width: 34, height: 34, borderRadius: '50%', background: s.avatar, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700, flexShrink: 0 }}>{s.name.slice(1, 2)}</div>
                                                    <div>
                                                        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{s.name}</div>
                                                        <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{s.email}</div>
                                                    </div>
                                                </div>
                                            </td>
                                            <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{s.group}</td>
                                            <td style={{ padding: '0.85rem 0.5rem' }}>
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                    <span style={{ fontSize: '0.95rem', fontWeight: 700, color: s.avgScore >= 80 ? 'var(--success)' : s.avgScore >= 65 ? 'var(--warning)' : 'var(--error)' }}>{s.avgScore}</span>
                                                    {s.trend === "up" && <TrendingUp size={14} color="var(--success)" />}
                                                    {s.trend === "down" && <TrendingDown size={14} color="var(--error)" />}
                                                </div>
                                            </td>
                                            <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>{s.examsTaken}회</td>
                                            <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
                                                <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.status === "active" ? 'var(--success)' : 'var(--muted)' }} />
                                                    {s.lastActive}
                                                </span>
                                            </td>
                                            <td style={{ padding: '0.85rem 0.5rem', textAlign: 'right' }}>
                                                <MoreVertical size={16} color="var(--muted)" />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {selected && (
                            <div className="bento-card" style={{ padding: '1.5rem', position: 'sticky', top: '5.5rem', alignSelf: 'flex-start', animation: 'fadeIn 0.3s both' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
                                    <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>학생 상세</h3>
                                    <button onClick={() => setSelectedId(null)} style={{ color: 'var(--muted)' }}>
                                        <X size={18} />
                                    </button>
                                </div>
                                <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                                    <div style={{
                                        width: 72, height: 72, borderRadius: '50%', background: selected.avatar,
                                        color: 'white', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.75rem'
                                    }}>{selected.name.slice(1, 2)}</div>
                                    <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{selected.name}</div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{selected.email}</div>
                                    <div style={{ marginTop: '0.6rem' }}>
                                        <span className="badge badge-primary">{selected.group}</span>
                                    </div>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1.25rem' }}>
                                    <MiniStat label="평균 점수" value={`${selected.avgScore}점`} color="#4f46e5" />
                                    <MiniStat label="응시 수" value={`${selected.examsTaken}회`} color="#10b981" />
                                </div>
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem' }}>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>최근 응시 이력</div>
                                    {["Midterm English Test", "Chapter 4 Math", "Science Pop Quiz"].map((t, i) => (
                                        <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', padding: '0.3rem 0', borderBottom: i < 2 ? '1px dashed var(--border)' : 'none' }}>
                                            <span style={{ fontWeight: 500 }}>{t}</span>
                                            <span style={{ fontWeight: 700, color: 'var(--foreground)' }}>{85 - i * 7}점</span>
                                        </div>
                                    ))}
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button style={{ flex: 1, padding: '0.7rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
                                        <Mail size={14} /> 메시지
                                    </button>
                                    <button style={{ flex: 1, padding: '0.7rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem' }}>
                                        상세 보기
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === "groups" && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
                        {MOCK_GROUPS.map(g => (
                            <div key={g.id} className="bento-card card-hover" style={{ padding: '1.5rem', cursor: 'pointer' }}>
                                <div style={{
                                    width: 46, height: 46, borderRadius: 'var(--radius-md)',
                                    background: `color-mix(in srgb, ${g.color}, transparent 88%)`, color: g.color,
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1rem'
                                }}>
                                    <Users size={22} />
                                </div>
                                <h3 style={{ fontSize: '1.05rem', fontWeight: 700, marginBottom: '0.25rem' }}>{g.name}</h3>
                                <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.25rem' }}>{g.count}명 등록</p>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                    <span style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 700, letterSpacing: '0.05em' }}>AVG</span>
                                    <span style={{ fontSize: '1.4rem', fontWeight: 800, color: g.color }}>{g.avgScore}점</span>
                                </div>
                            </div>
                        ))}
                        <div className="bento-card card-hover" style={{
                            padding: '1.5rem', cursor: 'pointer', display: 'flex',
                            flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                            border: '2px dashed var(--border)', background: 'transparent', gap: '0.5rem',
                            color: 'var(--muted)', minHeight: 160
                        }}>
                            <FolderPlus size={28} />
                            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>새 반 만들기</span>
                        </div>
                    </div>
                )}

                {tab === "invites" && (
                    <div className="bento-card" style={{ padding: '1.5rem' }}>
                        <div style={{
                            display: 'flex', gap: '0.75rem', padding: '1rem 1.25rem',
                            background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(139,92,246,0.06))',
                            borderRadius: 'var(--radius-md)', border: '1px solid rgba(99,102,241,0.15)',
                            marginBottom: '1.5rem'
                        }}>
                            <LinkIcon size={20} color="var(--primary)" style={{ flexShrink: 0, marginTop: 2 }} />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.25rem' }}>초대 링크</div>
                                <code style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>https://classin.app/join/xYz9Ab</code>
                            </div>
                            <button style={{ padding: '0.5rem 1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.8rem' }}>복사</button>
                        </div>

                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                            <thead>
                                <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>이메일</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>발송 시각</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>상태</th>
                                    <th style={{ padding: '0.85rem 0.5rem', textAlign: 'right' }}>작업</th>
                                </tr>
                            </thead>
                            <tbody>
                                {MOCK_INVITES.map(inv => {
                                    const map = {
                                        pending: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', label: '대기 중' },
                                        accepted: { color: '#10b981', bg: 'rgba(16,185,129,0.1)', label: '수락됨' },
                                        expired: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', label: '만료' },
                                    };
                                    const m = map[inv.status as keyof typeof map];
                                    return (
                                        <tr key={inv.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>{inv.email}</td>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{inv.sentAt}</td>
                                            <td style={{ padding: '1rem 0.5rem' }}>
                                                <span style={{
                                                    background: m.bg, color: m.color, padding: '0.3rem 0.7rem',
                                                    borderRadius: 'var(--radius-full)', fontSize: '0.75rem', fontWeight: 700
                                                }}>{m.label}</span>
                                            </td>
                                            <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                                                <button style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 600 }}>재발송</button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </main>
        </div>
    );
}

function KPI({ label, value, color, icon }: { label: string; value: number; color: string; icon: React.ReactNode }) {
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>{label}</div>
                    <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                </div>
                <div style={{
                    color, background: `color-mix(in srgb, ${color}, transparent 88%)`,
                    padding: 10, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>{icon}</div>
            </div>
        </div>
    );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div style={{ padding: '0.85rem', background: `color-mix(in srgb, ${color}, transparent 92%)`, borderRadius: 'var(--radius-md)', border: `1px solid ${color}22` }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>{label}</div>
            <div style={{ fontSize: '1.15rem', fontWeight: 800, color }}>{value}</div>
        </div>
    );
}
