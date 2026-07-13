"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";

type Role = "teacher" | "student" | "admin" | "unknown";

function detectRole(): Role {
    if (typeof window === "undefined") return "unknown";
    try {
        if (window.location.pathname.startsWith("/admin")) return "admin";
        const teacherRaw =
            sessionStorage.getItem("omr_teacher_session") ||
            localStorage.getItem("omr_teacher_session");
        if (teacherRaw) {
            const parsed = JSON.parse(teacherRaw);
            if (parsed?.role === "teacher" && parsed?.expiresAt > Date.now()) return "teacher";
        }
        const studentRaw =
            sessionStorage.getItem("omr_student_session") ||
            localStorage.getItem("omr_student_session_backup");
        if (studentRaw) {
            const parsed = JSON.parse(studentRaw);
            if (parsed?.name) return "student";
        }
    } catch {
        // Ignore parse errors — fall through to unknown.
    }
    return "unknown";
}

const HOME_BY_ROLE: Record<Role, { href: string; label: string }> = {
    teacher: { href: "/teacher/dashboard", label: "대시보드로 돌아가기" },
    student: { href: "/student/dashboard", label: "내 대시보드로 돌아가기" },
    admin: { href: "/teacher/users", label: "사용자 관리로 이동" },
    unknown: { href: "/", label: "홈으로 돌아가기" },
};

export default function NotFound() {
    const [role, setRole] = useState<Role>("unknown");

    useEffect(() => {
        let isCancelled = false;

        Promise.resolve().then(() => {
            if (!isCancelled) setRole(detectRole());
        });

        return () => {
            isCancelled = true;
        };
    }, []);

    const { href, label } = HOME_BY_ROLE[role];

    return (
        <div className="layout-main" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
            <div className="orb orb-accent" />
            <div className="container" style={{ maxWidth: 520, textAlign: 'center', padding: '2rem', position: 'relative', zIndex: 1 }}>
                <div style={{
                    width: 88, height: 88, borderRadius: '50%',
                    background: 'rgba(139,92,246,0.1)', color: 'var(--accent)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: '1.5rem',
                }}>
                    <FileQuestion size={40} />
                </div>
                <h1 className="title-gradient" style={{ fontSize: '3rem', fontWeight: 900, marginBottom: '0.5rem', lineHeight: 1 }}>
                    404
                </h1>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    {role === "admin" ? "관리자 기능은 교사 포털에서 관리합니다" : "페이지를 찾을 수 없습니다"}
                </h2>
                <p style={{ color: 'var(--muted)', fontSize: '0.95rem', marginBottom: '2rem' }}>
                    {role === "admin"
                        ? "현재 별도 /admin 주소는 없고, 사용자 관리·설정·결제/플랜 운영은 교사 포털 안에서 열 수 있습니다."
                        : "요청하신 페이지가 삭제되었거나 주소가 변경되었을 수 있습니다."}
                </p>
                <Link
                    href={href}
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                        color: 'white', borderRadius: 'var(--radius-full)',
                        fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                        boxShadow: '0 4px 14px rgba(99,102,241,0.3)',
                    }}
                >
                    <ArrowLeft size={16} /> {label}
                </Link>
            </div>
        </div>
    );
}
