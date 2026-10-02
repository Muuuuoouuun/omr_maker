import { useId, type CSSProperties, type ReactNode } from "react";
import styles from "./AnalyticsReportPrimitives.module.css";

export type AnalyticsChartState =
    | { status: "loading"; message: string }
    | { status: "empty"; message: string }
    | { status: "error"; message: string; onRetry: () => void }
    | { status: "ready"; summary: string };

export type AnalyticsChartFrameProps = {
    ariaLabel: string;
    state: AnalyticsChartState;
    height?: number;
    scrollable?: boolean;
    accessibleTable?: ReactNode;
    className?: string;
    children: ReactNode;
};

type ChartFrameStyle = CSSProperties & {
    "--analytics-chart-height": string;
};

export function AnalyticsChartFrame({
    ariaLabel,
    state,
    height = 320,
    scrollable = false,
    accessibleTable,
    className,
    children,
}: AnalyticsChartFrameProps) {
    const summaryId = useId();
    const frameClassName = [
        styles.chartFrame,
        accessibleTable ? styles.hasAccessibleData : undefined,
        className,
    ].filter(Boolean).join(" ");
    const frameStyle: ChartFrameStyle = {
        "--analytics-chart-height": `${height}px`,
    };

    let content: ReactNode;

    if (state.status === "loading" || state.status === "empty") {
        content = <div className={styles.chartState} role="status">{state.message}</div>;
    } else if (state.status === "error") {
        content = (
            <div className={`${styles.chartState} ${styles.chartError}`} role="alert">
                <p>{state.message}</p>
                <button type="button" className={styles.retryButton} onClick={state.onRetry}>
                    다시 시도
                </button>
            </div>
        );
    } else {
        const visual = (
            <div className={styles.chartContent}>
                <div
                    className={styles.chartVisual}
                    role="img"
                    aria-label={ariaLabel}
                    aria-describedby={summaryId}
                >
                    {children}
                </div>
            </div>
        );

        const visualViewport = scrollable ? (
            <div className={styles.chartVisualViewport}>
                <p className={styles.scrollHint}>가로로 스크롤하여 더 보기</p>
                <div
                    className={styles.chartScrollRegion}
                    role="region"
                    tabIndex={0}
                    aria-label={`${ariaLabel} 가로 스크롤 영역`}
                >
                    <div className={styles.chartScrollContent}>{visual}</div>
                </div>
            </div>
        ) : (
            <div className={styles.chartVisualViewport}>{visual}</div>
        );

        content = (
            <>
                {visualViewport}
                <p id={summaryId} className={styles.screenReaderOnly}>{state.summary}</p>
                {accessibleTable ? (
                    <>
                        <p className={styles.tableScrollHint}>데이터 표를 가로로 스크롤하여 더 보기</p>
                        <div
                            className={styles.accessibleData}
                            role="region"
                            tabIndex={0}
                            aria-label={`${ariaLabel} 데이터 표 가로 스크롤 영역`}
                        >
                            {accessibleTable}
                        </div>
                    </>
                ) : null}
            </>
        );
    }

    return (
        <div className={frameClassName} style={frameStyle}>
            {content}
        </div>
    );
}
