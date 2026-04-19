import Link from "next/link";
import { FileQuestion, Home } from "lucide-react";

export default function NotFound() {
    return (
        <div className="layout-main" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
            <div className="orb orb-accent" />
            <div className="container" style={{ maxWidth: 520, textAlign: 'center', padding: '2rem', position: 'relative', zIndex: 1 }}>
                <div style={{
                    width: 88, height: 88, borderRadius: '50%',
                    background: 'rgba(139,92,246,0.1)', color: 'var(--accent)',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    marginBottom: '1.5rem'
                }}>
                    <FileQuestion size={40} />
                </div>
                <h1 className="title-gradient" style={{ fontSize: '3rem', fontWeight: 900, marginBottom: '0.5rem', lineHeight: 1 }}>
                    404
                </h1>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                    페이지를 찾을 수 없습니다
                </h2>
                <p style={{ color: 'var(--muted)', fontSize: '0.95rem', marginBottom: '2rem' }}>
                    요청하신 페이지가 삭제되었거나 주소가 변경되었을 수 있습니다.
                </p>
                <Link href="/" style={{
                    padding: '0.75rem 1.5rem',
                    background: 'linear-gradient(135deg, var(--primary), var(--primary-dark))',
                    color: 'white', borderRadius: 'var(--radius-full)',
                    fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '0.5rem',
                    boxShadow: '0 4px 14px rgba(99,102,241,0.3)'
                }}>
                    <Home size={16} /> 홈으로 돌아가기
                </Link>
            </div>
        </div>
    );
}
