// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StudentGrowthReportModel } from "@/lib/studentGrowthReport";

vi.mock("recharts", () => ({
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
        <div data-testid="responsive-container">{children}</div>
    ),
    LineChart: ({ children, data }: { children: React.ReactNode; data: Array<{ axisLabel: string }> }) => (
        <div data-testid="line-chart">
            <output data-testid="chart-axis-labels">{data.map(row => row.axisLabel).join("|")}</output>
            {children}
        </div>
    ),
    Line: ({
        dataKey,
        isAnimationActive,
        strokeDasharray,
        className,
        dot,
        connectNulls,
    }: {
        dataKey: string;
        isAnimationActive: boolean;
        strokeDasharray?: string;
        className?: string;
        dot?: React.ReactNode | boolean;
        connectNulls?: boolean;
    }) => (
        <i
            data-testid={`line-${dataKey}`}
            data-animation-active={String(isAnimationActive)}
            data-stroke-dasharray={strokeDasharray}
            data-dot={dot === false ? "false" : dot ? "custom" : "default"}
            data-connect-nulls={String(connectNulls)}
            className={className}
        />
    ),
    XAxis: () => <i data-testid="x-axis" />,
    YAxis: () => <i data-testid="y-axis" />,
    CartesianGrid: () => <i data-testid="cartesian-grid" />,
    Customized: ({ component }: { component: React.ReactNode }) => component,
}));

import StudentGrowthReport from "./StudentGrowthReport";
import GrowthTrendChart from "./GrowthTrendChart";

const manyPointModel: StudentGrowthReportModel = {
    status: "ready",
    rows: [
        {
            examId: "e1",
            examTitle: "1차 진단",
            finishedAt: "2026-01-01T09:00:00.000Z",
            studentScore: 60,
            classAverage: 70,
            gap: -10,
            rank: 3,
            participantCount: 12,
            isLatest: false,
        },
        {
            examId: "e2",
            examTitle: "2차 진단",
            finishedAt: "2026-02-01T09:00:00.000Z",
            studentScore: 82,
            classAverage: 76,
            gap: 6,
            rank: 2,
            participantCount: 12,
            isLatest: true,
        },
    ],
    latestScore: 82,
    averageGap: -2,
    currentRank: 2,
    currentPercentile: 17,
    rankDelta: 1,
    trend: "up",
    omittedCount: 0,
    selectedAttemptIncluded: true,
};

const onePointModel: StudentGrowthReportModel = {
    status: "ready",
    rows: [{
        examId: "e1",
        examTitle: "기초 진단",
        finishedAt: "2026-01-01T09:00:00.000Z",
        studentScore: 60,
        classAverage: 70,
        gap: -10,
        rank: null,
        participantCount: 1,
        isLatest: true,
    }],
    latestScore: 60,
    averageGap: null,
    currentRank: null,
    currentPercentile: null,
    rankDelta: null,
    trend: "insufficient",
    omittedCount: 0,
    selectedAttemptIncluded: true,
};

beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: vi.fn().mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        callback(0);
        return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-motion");
    vi.unstubAllGlobals();
});

describe("StudentGrowthReport", () => {
    it("switches between summary and trend-only panels while keeping the chart available", async () => {
        render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);

        expect(screen.getByRole("tab", { name: "요약" })).toHaveAttribute("aria-selected", "true");
        expect(screen.getByLabelText("최근 시험 요약")).toBeInTheDocument();
        const chartShell = await screen.findByTestId("growth-chart-shell");
        expect(chartShell.className).toContain("growthChartAnimated");

        fireEvent.click(screen.getByRole("tab", { name: "추세만" }));

        expect(screen.getByRole("tab", { name: "추세만" })).toHaveAttribute("aria-selected", "true");
        expect(screen.queryByLabelText("최근 시험 요약")).not.toBeInTheDocument();
        expect(screen.getByRole("table", { name: "개인 성장 데이터" })).toBeInTheDocument();
        expect(screen.getByTestId("growth-chart-shell")).toBe(chartShell);
        expect(chartShell.className).toContain("growthChartAnimated");
    });

    it("links tabs and panel with ARIA and supports roving keyboard focus and activation", () => {
        render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);
        const summaryTab = screen.getByRole("tab", { name: "요약" });
        const trendTab = screen.getByRole("tab", { name: "추세만" });
        const panel = screen.getByRole("tabpanel");

        expect(summaryTab).toHaveAttribute("aria-controls", panel.id);
        expect(panel).toHaveAttribute("aria-labelledby", summaryTab.id);

        summaryTab.focus();
        fireEvent.keyDown(summaryTab, { key: "ArrowRight" });
        expect(trendTab).toHaveFocus();
        expect(summaryTab).toHaveAttribute("aria-selected", "true");
        fireEvent.keyDown(trendTab, { key: "Enter" });
        expect(trendTab).toHaveAttribute("aria-selected", "true");

        fireEvent.keyDown(trendTab, { key: "Home" });
        expect(summaryTab).toHaveFocus();
        fireEvent.keyDown(summaryTab, { key: "End" });
        expect(trendTab).toHaveFocus();
        fireEvent.keyDown(trendTab, { key: " " });
        expect(trendTab).toHaveAttribute("aria-selected", "true");
        fireEvent.keyDown(trendTab, { key: "ArrowLeft" });
        expect(summaryTab).toHaveFocus();
    });

    it("renders a dense summary rail with score, gap, rank, and trend evidence", () => {
        render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);

        const rail = screen.getByLabelText("최근 시험 요약");
        expect(rail).toHaveTextContent("82점");
        expect(rail).toHaveTextContent("-2%p");
        expect(rail).toHaveTextContent("2등 / 12명");
        expect(rail).toHaveTextContent("1계단 상승");
    });

    it("renders a readable one-point state without claiming a trend", () => {
        render(<StudentGrowthReport state={{ status: "ready", model: onePointModel }} enabled onRetry={() => {}} />);

        expect(screen.getByText("비교할 시험이 더 필요합니다.")).toHaveAttribute("role", "status");
        expect(screen.getByLabelText("최근 시험 요약")).toHaveTextContent("반 비교 불가");
    });

    it("does not present a solo student's class comparison as authoritative", async () => {
        render(<StudentGrowthReport state={{ status: "ready", model: onePointModel }} enabled onRetry={() => {}} />);

        await screen.findByTestId("growth-chart-shell");
        expect(screen.getByRole("status", { name: "반 비교 안내" })).toHaveTextContent("비교 가능한 같은 반 응시자가 없습니다");
        expect(screen.getByLabelText("최근 시험 요약")).toHaveTextContent("반 비교 불가");
        expect(screen.getByLabelText("최근 시험 요약")).not.toHaveTextContent("-10%p");
        expect(screen.queryByTestId("line-classAverage")).not.toBeInTheDocument();
        const table = screen.getByRole("table", { name: "개인 성장 데이터" });
        expect(table).toHaveTextContent("60점");
        expect(table).not.toHaveTextContent("70점");
        expect(table).not.toHaveTextContent("-10%p");
        expect(table).toHaveTextContent("비교 불가");
    });

    it("excludes unavailable rows from a mixed comparison summary and explains the omission", async () => {
        const mixedModel: StudentGrowthReportModel = {
            ...manyPointModel,
            rows: [
                { ...manyPointModel.rows[0], participantCount: 1, rank: null },
                manyPointModel.rows[1],
            ],
            averageGap: 3.5,
        };
        render(<StudentGrowthReport state={{ status: "ready", model: mixedModel }} enabled onRetry={() => {}} />);

        await screen.findByTestId("growth-chart-shell");
        expect(screen.getByRole("status", { name: "반 비교 안내" })).toHaveTextContent("1명인 시험은 개인 점수만 표시");
        expect(screen.getByLabelText("최근 시험 요약")).toHaveTextContent("+3.5%p");
        expect(screen.getByLabelText("최근 시험 요약")).not.toHaveTextContent("-2%p");
        expect(screen.getByTestId("line-classAverage")).toBeInTheDocument();
    });

    it("discloses omitted records for both populated and empty growth reports", () => {
        const { rerender } = render(<StudentGrowthReport
            state={{ status: "ready", model: { ...manyPointModel, omittedCount: 2 } }}
            enabled
            onRetry={() => {}}
        />);

        expect(screen.getByRole("status", { name: "제외된 성장 데이터" })).toHaveTextContent("식별 정보가 부족한 2개 응시");

        rerender(<StudentGrowthReport
            state={{
                status: "ready",
                model: {
                    ...manyPointModel,
                    rows: [],
                    latestScore: null,
                    averageGap: null,
                    currentRank: null,
                    currentPercentile: null,
                    omittedCount: 1,
                },
            }}
            enabled
            onRetry={() => {}}
        />);

        expect(screen.getByRole("status", { name: "제외된 성장 데이터" })).toHaveTextContent("식별 정보가 부족한 1개 응시");
        expect(screen.getByRole("status", { name: "성장 데이터 없음" })).toBeInTheDocument();
    });

    it("keeps an isolated comparable class average visible without connecting unavailable gaps", async () => {
        const isolatedComparisonRows = [
            { ...manyPointModel.rows[0], examId: "solo-before", participantCount: 1, rank: null },
            { ...manyPointModel.rows[1], examId: "comparable", isLatest: false },
            { ...manyPointModel.rows[0], examId: "solo-after", participantCount: 1, rank: null, isLatest: true },
        ];
        render(<StudentGrowthReport
            state={{ status: "ready", model: { ...manyPointModel, rows: isolatedComparisonRows } }}
            enabled
            onRetry={() => {}}
        />);

        await screen.findByTestId("growth-chart-shell");
        const averageLine = screen.getByTestId("line-classAverage");
        expect(averageLine).toHaveAttribute("data-connect-nulls", "false");
        expect(averageLine).toHaveAttribute("data-dot", "custom");
        const table = screen.getByRole("table", { name: "개인 성장 데이터" });
        expect(table).toHaveTextContent("76점");
        expect(table).toHaveTextContent("비교 불가");
    });

    it("renders loading, idle, empty, ready-zero, and error boundaries", () => {
        const onRetry = vi.fn();
        const { rerender } = render(<StudentGrowthReport state={{ status: "loading" }} enabled onRetry={onRetry} />);
        expect(screen.getByRole("status")).toHaveTextContent("개인 성장 데이터를 불러오는 중입니다");

        rerender(<StudentGrowthReport state={{ status: "idle" }} enabled onRetry={onRetry} />);
        expect(screen.getByRole("status")).toHaveTextContent("개인 성장 데이터를 준비하고 있습니다");

        rerender(<StudentGrowthReport state={{ status: "empty", message: "완료한 시험이 없습니다." }} enabled onRetry={onRetry} />);
        expect(screen.getByRole("status")).toHaveTextContent("완료한 시험이 없습니다.");

        rerender(<StudentGrowthReport state={{
            status: "ready",
            model: { ...onePointModel, rows: [], latestScore: null, averageGap: null },
        }} enabled onRetry={onRetry} />);
        expect(screen.getByRole("status")).toHaveTextContent("표시할 성장 데이터가 없습니다");

        rerender(<StudentGrowthReport state={{ status: "error", message: "연결에 실패했습니다." }} enabled onRetry={onRetry} />);
        expect(screen.getByRole("alert")).toHaveTextContent("연결에 실패했습니다.");
        fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
        expect(onRetry).toHaveBeenCalledOnce();
    });

    it("preserves the existing plan lock experience", () => {
        render(<StudentGrowthReport state={{ status: "loading" }} enabled={false} onRetry={() => {}} />);

        expect(screen.getByRole("note", { name: "개인 성장 제한" })).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "플랜 보기" })).toHaveAttribute("href", "/teacher/billing");
    });

    it("shows explicit stale and partial data notes alongside usable metrics", () => {
        const { rerender } = render(<StudentGrowthReport
            state={{ status: "stale", model: { ...manyPointModel, status: "stale" }, message: "최근 동기화에 실패했습니다." }}
            enabled
            onRetry={() => {}}
        />);
        expect(screen.getByRole("status")).toHaveTextContent("저장된 성장 데이터");
        expect(screen.getByRole("status")).toHaveTextContent("최근 동기화에 실패했습니다.");
        expect(screen.getByLabelText("최근 시험 요약")).toHaveTextContent("82점");

        rerender(<StudentGrowthReport
            state={{ status: "partial", model: { ...manyPointModel, status: "partial" }, message: "일부 제출만 집계되었습니다." }}
            enabled
            onRetry={() => {}}
        />);
        expect(screen.getByRole("status")).toHaveTextContent("일부 제출 기준");
        expect(screen.getByRole("status")).toHaveTextContent("일부 제출만 집계되었습니다.");
    });

    it("keeps stale and partial diagnostics when their model has no rows", () => {
        const onRetry = vi.fn();
        const emptyModel: StudentGrowthReportModel = {
            ...manyPointModel,
            rows: [],
            latestScore: null,
            averageGap: null,
            currentRank: null,
            rankDelta: null,
            trend: "insufficient",
        };
        const { rerender } = render(<StudentGrowthReport
            state={{ status: "stale", model: { ...emptyModel, status: "stale" }, message: "캐시만 확인했습니다." }}
            enabled
            onRetry={onRetry}
        />);

        expect(screen.getByText(/저장된 성장 데이터를 표시합니다/)).toHaveTextContent("캐시만 확인했습니다.");
        expect(screen.getByRole("status", { name: "성장 데이터 없음" })).toHaveTextContent("표시할 성장 데이터가 없습니다");
        fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
        expect(onRetry).toHaveBeenCalledOnce();

        rerender(<StudentGrowthReport
            state={{ status: "partial", model: { ...emptyModel, status: "partial" }, message: "일부 제출만 도착했습니다." }}
            enabled
            onRetry={onRetry}
        />);
        expect(screen.getByText(/일부 제출 기준으로 계산했습니다/)).toHaveTextContent("일부 제출만 도착했습니다.");
        expect(screen.getByRole("status", { name: "성장 데이터 없음" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    });

    it("provides a named focusable internal scroll region, visible hint, and complete accessible table", async () => {
        render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);

        await screen.findByTestId("growth-chart-shell");
        const scrollRegion = screen.getByRole("region", { name: "개인 성장 그래프 가로 스크롤 영역" });
        expect(scrollRegion).toHaveAttribute("tabindex", "0");
        expect(screen.getByText("가로로 스크롤하여 시험별 추세 더 보기")).toBeVisible();

        const table = screen.getByRole("table", { name: "개인 성장 데이터" });
        expect(table).toHaveTextContent("시험");
        expect(table).toHaveTextContent("학생 점수");
        expect(table).toHaveTextContent("반 평균");
        expect(table).toHaveTextContent("평균 격차");
        expect(table).toHaveTextContent("등수");
        expect(table).toHaveTextContent("참여 인원");
        expect(table).toHaveTextContent("1차 진단");
        expect(table).toHaveTextContent("60점");
        expect(table).toHaveTextContent("70점");
        expect(table).toHaveTextContent("-10%p");
        expect(table).toHaveTextContent("3등");
        expect(table).toHaveTextContent("12명");
    });

    it("keeps both Recharts lines static and differentiates the class average", async () => {
        render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);

        await screen.findByTestId("growth-chart-shell");
        expect(screen.getByTestId("line-studentScore")).toHaveAttribute("data-animation-active", "false");
        expect(screen.getByTestId("line-classAverage")).toHaveAttribute("data-animation-active", "false");
        expect(screen.getByTestId("line-classAverage")).toHaveAttribute("data-stroke-dasharray", "6 6");
        expect(screen.getByTestId("line-studentScore")).toHaveClass("studentLine");
    });

    it("fits zero or one point to the viewport and expands many points for internal scrolling", () => {
        const { rerender } = render(<GrowthTrendChart rows={[]} />);
        expect(screen.getByTestId("growth-chart-canvas")).toHaveStyle({ minWidth: "100%" });

        rerender(<GrowthTrendChart rows={onePointModel.rows} />);
        expect(screen.getByTestId("growth-chart-canvas")).toHaveStyle({ minWidth: "100%" });

        const eightRows = Array.from({ length: 8 }, (_, index) => ({
            ...manyPointModel.rows[index % 2],
            examId: `exam-${index + 1}`,
            examTitle: `진단 ${index + 1}`,
            finishedAt: `2026-${String(index + 1).padStart(2, "0")}-01T09:00:00.000Z`,
            isLatest: index === 7,
        }));
        rerender(<GrowthTrendChart rows={eightRows} />);
        expect(screen.getByTestId("growth-chart-canvas")).toHaveStyle({ minWidth: "896px" });
    });

    it("adds a visible ordinal discriminator when exam titles share the same prefix", async () => {
        const duplicatePrefixRows = manyPointModel.rows.map((row, index) => ({
            ...row,
            examId: `duplicate-${index}`,
            examTitle: `2026학년도 공통 진단 ${index + 1}`,
        }));
        render(<StudentGrowthReport
            state={{ status: "ready", model: { ...manyPointModel, rows: duplicatePrefixRows } }}
            enabled
            onRetry={() => {}}
        />);

        await screen.findByTestId("growth-chart-shell");
        const labels = screen.getByTestId("chart-axis-labels").textContent?.split("|") ?? [];
        expect(labels).toHaveLength(2);
        expect(labels[0]).not.toBe(labels[1]);
        expect(labels[0]).toMatch(/^1 · /);
        expect(labels[1]).toMatch(/^2 · /);
    });

    it("animates evidence content without overriding the SVG positioning transform", () => {
        const css = readFileSync("src/components/teacher/student-results/StudentResultHub.module.css", "utf8");

        expect(css).not.toMatch(/\.growthChartAnimated \.growthGapPill[\s\S]{0,180}animation:\s*growth-evidence-reveal/);
        expect(css).toMatch(/\.growthChartAnimated \.growthEvidenceContent[\s\S]{0,180}animation:\s*growth-evidence-reveal/);
    });

    it("keeps Korean report heading tracking at a nonnegative token", () => {
        const css = readFileSync("src/components/teacher/student-results/StudentResultHub.module.css", "utf8");

        expect(css).toMatch(/\.studentSummary h1\s*\{[^}]*letter-spacing:\s*(?:0|normal);/);
        expect(css).not.toMatch(/\.studentSummary h1\s*\{[^}]*letter-spacing:\s*-/);
    });

    it("does not retain a fixed dash pattern on the student line after mount motion", () => {
        const css = readFileSync("src/components/teacher/student-results/StudentResultHub.module.css", "utf8");

        expect(css).not.toMatch(/stroke-dasharray:\s*1000/);
        expect(css).toMatch(/\.growthChartAnimated \.studentLine[\s\S]{0,140}animation:\s*growth-line-reveal/);
    });

    it("centers scale motion on class-average SVG points", () => {
        const css = readFileSync("src/components/teacher/student-results/StudentResultHub.module.css", "utf8");

        expect(css).toMatch(
            /\.growthPoint,\s*\.latestGrowthPoint,\s*\.growthAveragePoint,\s*\.latestPointHalo\s*\{[^}]*transform-box:\s*fill-box;[^}]*transform-origin:\s*center;/,
        );
    });

    it("skips the mount animation for OS and app reduced-motion settings", async () => {
        vi.mocked(window.matchMedia).mockReturnValue({
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        } as unknown as MediaQueryList);
        const { unmount } = render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);
        await screen.findByTestId("growth-chart-shell");
        expect(screen.getByTestId("growth-chart-shell").className).not.toContain("growthChartAnimated");
        unmount();

        document.documentElement.dataset.motion = "off";
        vi.mocked(window.matchMedia).mockReturnValue({
            matches: false,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        } as unknown as MediaQueryList);
        render(<StudentGrowthReport state={{ status: "ready", model: manyPointModel }} enabled onRetry={() => {}} />);
        await screen.findByTestId("growth-chart-shell");
        expect(screen.getByTestId("growth-chart-shell").className).not.toContain("growthChartAnimated");
    });
});
