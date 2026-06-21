import Link from "next/link";
import { ArrowLeft, FileQuestion } from "lucide-react";

export default function ExamNotFound() {
    return (
        <div className="layout-main" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
            <div className="orb orb-accent" />
            <div className="container" style={{ maxWidth: 520, textAlign: 'center', padding: '2rem', position: 'relative', zIndex: 1 }}>
                <div style={{
                    width: 80, height: 80, borderRadius: '50%',
                    background: 'rgba(139,92,246,0.1)', color: 'var(--accent)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: '1.5rem',
                }}>
                    <FileQuestion size={36} />
                </div>
                <h1 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.5rem' }}>
                    시험을 찾을 수 없습니다
                </h1>
                <p style={{ color: 'var(--muted)', fontSize: '0.95rem', marginBottom: '2rem', lineHeight: 1.6 }}>
                    삭제되었거나 접근 권한이 없는 시험입니다.
                </p>
                <Link
                    href="/teacher/dashboard"
                    style={{
                        padding: '0.75rem 1.5rem',
                        background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                        color: 'white', borderRadius: 'var(--radius-full)',
                        fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                        boxShadow: '0 4px 14px rgba(99,102,241,0.3)',
                    }}
                >
                    <ArrowLeft size={16} /> 대시보드로 돌아가기
                </Link>
            </div>
        </div>
    );
}
