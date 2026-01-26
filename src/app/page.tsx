import Link from "next/link";

export default function Home() {
  return (
    <div className="layout-main">
      <header className="header">
        <div className="container header-content">
          <div className="logo">OMR Maker</div>
          <nav>
            <Link href="/dashboard" className="nav-link">
              내 보관함
            </Link>
            <Link href="/login" className="nav-link">
              로그인
            </Link>
          </nav>
        </div>
      </header>

      <main className="container" style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="glass-panel animate-fade-in" style={{ padding: '4rem', textAlign: 'center', maxWidth: '800px', width: '100%' }}>
          <h1 className="title-gradient" style={{ fontSize: '3.5rem', marginBottom: '1.5rem', lineHeight: 1.2 }}>
            OMR Maker
          </h1>
          <p style={{ fontSize: '1.25rem', color: 'var(--muted)', marginBottom: '3rem' }}>
            나만의 OMR 답안지를 쉽고 빠르게 디자인하세요.<br />
            학교, 학원, 각종 시험에 최적화된 도구입니다.
          </p>

          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center' }}>
            <Link href="/create" className="btn btn-primary" style={{ fontSize: '1.1rem', padding: '1rem 2rem' }}>
              새 OMR 만들기
            </Link>
            <Link href="/dashboard" className="btn btn-secondary" style={{ fontSize: '1.1rem', padding: '1rem 2rem' }}>
              보관함 가기
            </Link>
          </div>
        </div>
      </main>

      <footer style={{ padding: '2rem 0', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
        <div className="container">
          &copy; {new Date().getFullYear()} OMR Maker. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
