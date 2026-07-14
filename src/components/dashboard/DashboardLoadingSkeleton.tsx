type SkeletonBlockProps = {
    height: number | string;
    width?: number | string;
    borderRadius?: number | string;
    background?: string;
};

function SkeletonBlock({
    height,
    width = "100%",
    borderRadius = "var(--radius-md)",
    background = "rgba(148,163,184,0.18)",
}: SkeletonBlockProps) {
    return (
        <div
            aria-hidden="true"
            className="animate-pulse"
            style={{ width, height, borderRadius, background, flexShrink: 0 }}
        />
    );
}

export function DashboardPageSkeleton() {
    return (
        <div className="layout-main" aria-busy="true" aria-label="대시보드를 불러오는 중">
            <header className="header teacher-header">
                <div className="container header-content" style={{ gap: "1rem" }}>
                    <SkeletonBlock width={164} height={36} borderRadius="var(--radius-full)" />
                    <SkeletonBlock width={210} height={44} borderRadius="var(--radius-full)" />
                </div>
            </header>

            <main className="container dashboard-main">
                <div className="dashboard-welcome">
                    <div style={{ display: "grid", gap: "0.8rem", width: "min(100%, 440px)" }}>
                        <SkeletonBlock width="54%" height={42} />
                        <SkeletonBlock width="100%" height={20} />
                    </div>
                    <div className="dashboard-welcome-status">
                        <SkeletonBlock width={190} height={58} borderRadius="var(--radius-full)" />
                        <SkeletonBlock width={190} height={58} borderRadius="var(--radius-full)" />
                    </div>
                </div>

                <div style={{ display: "grid", gap: "1.5rem" }}>
                    <SkeletonBlock height={82} borderRadius="var(--radius-lg)" />
                    <SkeletonBlock height={62} borderRadius="var(--radius-lg)" />
                    <div className="bento-grid">
                        <div className="bento-card col-span-2" style={{ minHeight: 280 }}>
                            <SkeletonBlock width="42%" height={24} />
                            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "0.75rem", marginTop: "1.5rem" }}>
                                {Array.from({ length: 6 }).map((_, index) => (
                                    <SkeletonBlock key={index} height={88} borderRadius="var(--radius-lg)" />
                                ))}
                            </div>
                        </div>
                        <div className="bento-card col-span-2" style={{ minHeight: 280 }}>
                            <SkeletonBlock width="45%" height={24} />
                            <div style={{ marginTop: "auto" }}>
                                <SkeletonBlock height={160} borderRadius="var(--radius-lg)" />
                            </div>
                        </div>
                    </div>
                </div>

                <span className="sr-only" role="status" aria-live="polite">
                    대시보드 화면을 준비하고 있습니다.
                </span>
            </main>
        </div>
    );
}

export function AnalyticsTabSkeleton() {
    return (
        <div
            role="status"
            aria-live="polite"
            aria-label="분석 화면을 불러오는 중"
            style={{ display: "grid", gap: "1rem" }}
        >
            <div className="bento-card" style={{ minHeight: 150 }}>
                <SkeletonBlock width="32%" height={28} />
                <div style={{ display: "flex", gap: "0.75rem", marginTop: "1.25rem", flexWrap: "wrap" }}>
                    <SkeletonBlock width={180} height={44} borderRadius="var(--radius-full)" />
                    <SkeletonBlock width={180} height={44} borderRadius="var(--radius-full)" />
                </div>
            </div>
            <div className="bento-grid">
                {Array.from({ length: 4 }).map((_, index) => (
                    <div key={index} className="bento-card col-span-2" style={{ minHeight: index < 2 ? 260 : 190 }}>
                        <SkeletonBlock width="44%" height={24} />
                        <div style={{ marginTop: "1.25rem" }}>
                            <SkeletonBlock height={index < 2 ? 170 : 100} borderRadius="var(--radius-lg)" />
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function TrendChartSkeleton({ height = 160 }: { height?: number }) {
    return (
        <div
            role="status"
            aria-label="점수 추이 차트를 불러오는 중"
            className="animate-pulse"
            style={{
                width: "100%",
                height,
                borderRadius: "var(--radius-lg)",
                background: "rgba(255,255,255,0.14)",
                border: "1px solid rgba(255,255,255,0.12)",
            }}
        >
            <span className="sr-only">점수 추이 차트를 불러오고 있습니다.</span>
        </div>
    );
}
