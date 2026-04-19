export default function Loading() {
    return (
        <div className="layout-main" style={{ alignItems: 'center', justifyContent: 'center', minHeight: '80vh' }}>
            <div className="orb orb-primary" />
            <div style={{
                position: 'relative', zIndex: 1,
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1.25rem'
            }}>
                <div style={{
                    width: 48, height: 48, borderRadius: '50%',
                    border: '3px solid var(--border)',
                    borderTopColor: 'var(--primary)',
                    animation: 'spin 0.9s linear infinite'
                }} />
                <div style={{ fontSize: '0.85rem', color: 'var(--muted)', fontWeight: 600, letterSpacing: '0.05em' }}>
                    불러오는 중...
                </div>
            </div>
            <style>{`
                @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `}</style>
        </div>
    );
}
