// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsReportSection } from "./AnalyticsReportSection";

afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-motion");
});

describe("AnalyticsReportSection", () => {
    it("labels the section with its title", () => {
        render(
            <AnalyticsReportSection id="growth" title="개인 성장">
                내용
            </AnalyticsReportSection>,
        );

        expect(screen.getByRole("region", { name: "개인 성장" })).toHaveAttribute(
            "aria-labelledby",
            "growth-title",
        );
        expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(1);
    });

    it("links an external evidence qualifier without duplicating its copy", () => {
        render(
            <>
                <p id="sample-qualifier">일부 제출 기준</p>
                <AnalyticsReportSection
                    id="qualified-report"
                    title="시험 핵심 지표"
                    ariaDescribedBy="sample-qualifier"
                >
                    내용
                </AnalyticsReportSection>
            </>,
        );

        expect(screen.getByRole("region", { name: "시험 핵심 지표" })).toHaveAttribute(
            "aria-describedby",
            "sample-qualifier",
        );
        expect(screen.getAllByText("일부 제출 기준")).toHaveLength(1);
    });

    it("renders description, metadata, and actions after the title in a readable order", () => {
        render(
            <AnalyticsReportSection
                id="overview"
                title="시험 요약"
                description="전체 응시 결과입니다."
                meta={<span>응시자 24명</span>}
                actions={<button type="button">내보내기</button>}
            >
                본문
            </AnalyticsReportSection>,
        );

        const title = screen.getByRole("heading", { level: 2, name: "시험 요약" });
        const description = screen.getByText("전체 응시 결과입니다.");
        const meta = screen.getByText("응시자 24명");
        const action = screen.getByRole("button", { name: "내보내기" });

        expect(title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(description.compareDocumentPosition(meta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(meta.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("applies density, print behavior, and caller classes without inline styles", () => {
        const { rerender } = render(
            <AnalyticsReportSection
                id="compact-report"
                title="압축 보고서"
                density="compact"
                printBehavior="allow-break"
                className="caller-class"
            >
                내용
            </AnalyticsReportSection>,
        );

        const compactSection = screen.getByRole("region", { name: "압축 보고서" });
        expect(compactSection.className).toContain("compact");
        expect(compactSection.className).toContain("allowBreak");
        expect(compactSection).toHaveClass("caller-class");
        expect(compactSection).not.toHaveAttribute("style");

        rerender(
            <AnalyticsReportSection id="default-report" title="기본 보고서">
                내용
            </AnalyticsReportSection>,
        );

        const defaultSection = screen.getByRole("region", { name: "기본 보고서" });
        expect(defaultSection.className).toContain("defaultDensity");
        expect(defaultSection.className).toContain("keepTogether");
    });
});

describe("AnalyticsMetricGrid", () => {
    it("renders each metric as a semantic definition with its unit, detail, trend, and tone", async () => {
        const { AnalyticsMetricGrid } = await import("./AnalyticsMetricGrid");
        const { container } = render(
            <AnalyticsMetricGrid
                ariaLabel="핵심 지표"
                metrics={[
                    {
                        label: "평균 점수",
                        value: 87,
                        unit: "점",
                        detail: "전체 응시자 기준",
                        trend: { direction: "up", label: "지난 시험보다 4점 상승" },
                        tone: "grade",
                    },
                ]}
            />,
        );

        const list = container.querySelector("dl");
        const metric = list?.querySelector(":scope > div");
        const definition = metric?.querySelector("dd");
        const value = definition?.querySelector(".numeric-emphasis");
        const trend = screen.getByLabelText("추세: 지난 시험보다 4점 상승");

        expect(list).toHaveAttribute("aria-label", "핵심 지표");
        expect(metric?.querySelector("dt")).toHaveTextContent("평균 점수");
        expect(value).toHaveTextContent("87점");
        expect(Array.from(metric?.children ?? [], child => child.tagName)).toEqual(["DT", "DD"]);
        expect(definition).toContainElement(screen.getByText("전체 응시자 기준"));
        expect(definition).toContainElement(trend);
        expect(screen.getByText("전체 응시자 기준")).toBeInTheDocument();
        expect(trend).toHaveAttribute("data-direction", "up");
        expect(trend).toHaveTextContent("지난 시험보다 4점 상승");
        expect(metric?.className).toContain("toneGrade");
    });

    it("uses CountUp only for finite numeric values that explicitly opt in", async () => {
        const { AnalyticsMetricGrid } = await import("./AnalyticsMetricGrid");
        const { container } = render(
            <AnalyticsMetricGrid
                metrics={[
                    { label: "응시자", value: 24, animate: true },
                    { label: "판정", value: "집중 필요", animate: true },
                    { label: "누락 값", value: Number.NaN, animate: true },
                    { label: "무한 값", value: Number.POSITIVE_INFINITY, animate: true },
                ]}
            />,
        );

        expect(container.querySelectorAll("[data-count-up-value]")).toHaveLength(1);
        expect(container.querySelector("[data-count-up-value='24']")).toBeInTheDocument();
        expect(screen.getByText("집중 필요")).toBeInTheDocument();
        expect(screen.getByText("NaN")).toBeInTheDocument();
        expect(screen.getByText("Infinity")).toBeInTheDocument();
    });

    it("preserves all meaningful decimal places when animating a finite metric", async () => {
        document.documentElement.setAttribute("data-motion", "off");
        const { AnalyticsMetricGrid } = await import("./AnalyticsMetricGrid");
        const { container } = render(
            <AnalyticsMetricGrid metrics={[
                { label: "정답률", value: 82.4, unit: "%", animate: true },
                { label: "반올림 값", value: 1.005, animate: true },
                { label: "세 자리 값", value: 0.125, animate: true },
                { label: "과학 표기 값", value: 1e-7, animate: true },
            ]} />,
        );

        expect(container.querySelector("[data-count-up-value='82.4']")).toHaveTextContent("82.4");
        expect(container.querySelector("[data-count-up-value='1.005']")).toHaveTextContent("1.005");
        expect(container.querySelector("[data-count-up-value='0.125']")).toHaveTextContent("0.125");
        expect(container.querySelector("[data-count-up-value='1e-7']")).toHaveTextContent("0.0000001");
    });

    it("honors a valid decimals override and ignores invalid overrides", async () => {
        document.documentElement.setAttribute("data-motion", "off");
        const { AnalyticsMetricGrid } = await import("./AnalyticsMetricGrid");
        render(
            <AnalyticsMetricGrid metrics={[
                { label: "고정 소수", value: 5, decimals: 2, animate: true },
                { label: "음수 자리수", value: 0.125, decimals: -1, animate: true },
                { label: "분수 자리수", value: 0.125, decimals: 1.5, animate: true },
            ]} />,
        );

        expect(screen.getByText("고정 소수").parentElement?.querySelector("[data-count-up-value]"))
            .toHaveTextContent("5.00");
        expect(screen.getByText("음수 자리수").parentElement?.querySelector("[data-count-up-value]"))
            .toHaveTextContent("0.125");
        expect(screen.getByText("분수 자리수").parentElement?.querySelector("[data-count-up-value]"))
            .toHaveTextContent("0.125");
    });

    it("preserves metric nodes when stable ids are reordered", async () => {
        const { AnalyticsMetricGrid } = await import("./AnalyticsMetricGrid");
        const initialMetrics = [
            { id: "average", label: "평균", value: 80 },
            { id: "median", label: "중앙값", value: 78 },
        ];
        const { rerender } = render(<AnalyticsMetricGrid metrics={initialMetrics} />);
        const averageNode = screen.getByText("평균").parentElement;
        const medianNode = screen.getByText("중앙값").parentElement;

        rerender(<AnalyticsMetricGrid metrics={[...initialMetrics].reverse()} />);

        expect(screen.getByText("평균").parentElement).toBe(averageNode);
        expect(screen.getByText("중앙값").parentElement).toBe(medianNode);
    });

    it("applies semantic tone classes and preserves a caller class", async () => {
        const { AnalyticsMetricGrid } = await import("./AnalyticsMetricGrid");
        const { container } = render(
            <AnalyticsMetricGrid
                className="caller-grid"
                metrics={[
                    { label: "기본", value: 1 },
                    { label: "성공", value: 2, tone: "success" },
                    { label: "주의", value: 3, tone: "warning" },
                    { label: "채점", value: 4, tone: "grade" },
                    { label: "재시험", value: 5, tone: "retake" },
                ]}
            />,
        );

        const list = container.querySelector("dl");
        const metricClasses = Array.from(container.querySelectorAll("dl > div"), item => item.className);

        expect(list).toHaveClass("caller-grid");
        expect(metricClasses[0]).toContain("toneNeutral");
        expect(metricClasses[1]).toContain("toneSuccess");
        expect(metricClasses[2]).toContain("toneWarning");
        expect(metricClasses[3]).toContain("toneGrade");
        expect(metricClasses[4]).toContain("toneRetake");
    });
});

describe("AnalyticsChartFrame", () => {
    it("announces loading and empty states without exposing the chart visual", async () => {
        const { AnalyticsChartFrame } = await import("./AnalyticsChartFrame");
        const { rerender } = render(
            <AnalyticsChartFrame
                ariaLabel="점수 분포"
                state={{ status: "loading", message: "분포를 불러오는 중입니다." }}
            >
                <svg data-testid="chart-visual" />
            </AnalyticsChartFrame>,
        );

        expect(screen.getByRole("status")).toHaveTextContent("분포를 불러오는 중입니다.");
        expect(screen.queryByTestId("chart-visual")).not.toBeInTheDocument();

        rerender(
            <AnalyticsChartFrame
                ariaLabel="점수 분포"
                state={{ status: "empty", message: "표시할 점수가 없습니다." }}
            >
                <svg data-testid="chart-visual" />
            </AnalyticsChartFrame>,
        );

        expect(screen.getByRole("status")).toHaveTextContent("표시할 점수가 없습니다.");
        expect(screen.queryByTestId("chart-visual")).not.toBeInTheDocument();
    });

    it("announces errors and invokes the retry action", async () => {
        const { AnalyticsChartFrame } = await import("./AnalyticsChartFrame");
        const onRetry = vi.fn();
        render(
            <AnalyticsChartFrame
                ariaLabel="점수 분포"
                state={{ status: "error", message: "분포를 불러오지 못했습니다.", onRetry }}
            >
                <svg />
            </AnalyticsChartFrame>,
        );

        expect(screen.getByRole("alert")).toHaveTextContent("분포를 불러오지 못했습니다.");
        fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("labels a ready visual and provides a screen-reader summary and accessible table", async () => {
        const { AnalyticsChartFrame } = await import("./AnalyticsChartFrame");
        const { container } = render(
            <AnalyticsChartFrame
                ariaLabel="점수 구간별 학생 수"
                state={{ status: "ready", summary: "80점 이상 구간이 12명으로 가장 많습니다." }}
                accessibleTable={(
                    <table>
                        <caption>점수 구간 데이터</caption>
                        <tbody><tr><th scope="row">80점 이상</th><td>12명</td></tr></tbody>
                    </table>
                )}
            >
                <svg data-testid="chart-visual" />
            </AnalyticsChartFrame>,
        );

        const visual = screen.getByRole("img", { name: "점수 구간별 학생 수" });
        const summary = screen.getByText("80점 이상 구간이 12명으로 가장 많습니다.");
        expect(visual).toContainElement(
            screen.getByTestId("chart-visual"),
        );
        expect(summary).toHaveAttribute("id");
        expect(visual).toHaveAttribute("aria-describedby", summary.id);
        const table = screen.getByRole("table", { name: "점수 구간 데이터" });
        const dataRegion = screen.getByRole("region", {
            name: "점수 구간별 학생 수 데이터 표 가로 스크롤 영역",
        });
        expect(table).toBeInTheDocument();
        expect(table.closest("[aria-hidden='true']")).toBeNull();
        expect(dataRegion).toHaveAttribute("tabindex", "0");
        expect(dataRegion).toContainElement(table);
        expect(screen.getByText("데이터 표를 가로로 스크롤하여 더 보기")).toBeVisible();
        expect(container.firstElementChild?.className).toContain("hasAccessibleData");
    });

    it("names and focuses an internal horizontal scroll region with a visible hint", async () => {
        const { AnalyticsChartFrame } = await import("./AnalyticsChartFrame");
        const { container } = render(
            <AnalyticsChartFrame
                ariaLabel="문항별 정답률"
                state={{ status: "ready", summary: "20개 문항의 정답률입니다." }}
                scrollable
                height={360}
                className="caller-chart"
                accessibleTable={(
                    <table><caption>문항별 정답률 데이터</caption><tbody><tr><td>82%</td></tr></tbody></table>
                )}
            >
                <div>넓은 차트</div>
            </AnalyticsChartFrame>,
        );

        const region = screen.getByRole("region", { name: "문항별 정답률 가로 스크롤 영역" });
        expect(region).toHaveAttribute("tabindex", "0");
        expect(screen.getByText("가로로 스크롤하여 더 보기")).toBeVisible();
        expect(container.firstElementChild).toHaveClass("caller-chart");
        expect(container.firstElementChild).toHaveStyle({ "--analytics-chart-height": "360px" });
        expect(region).not.toContainElement(screen.getByRole("table", { name: "문항별 정답률 데이터" }));
        expect(screen.getByRole("table", { name: "문항별 정답률 데이터" }).parentElement?.className)
            .toContain("accessibleData");

        expect(container.firstElementChild?.className).toContain("chartFrame");
        expect(region.className).toContain("chartScrollRegion");
    });

    it("uses a stable default chart height", async () => {
        const { AnalyticsChartFrame } = await import("./AnalyticsChartFrame");
        const { container } = render(
            <AnalyticsChartFrame ariaLabel="기본 차트" state={{ status: "ready", summary: "요약" }}>
                <div>차트</div>
            </AnalyticsChartFrame>,
        );

        expect(container.firstElementChild).toHaveStyle({ "--analytics-chart-height": "320px" });
        expect(container.firstElementChild?.className).not.toContain("hasAccessibleData");
        expect(screen.getByRole("img", { name: "기본 차트" })).toBeInTheDocument();
        expect(screen.queryByText("데이터 표를 가로로 스크롤하여 더 보기")).not.toBeInTheDocument();
    });
});
