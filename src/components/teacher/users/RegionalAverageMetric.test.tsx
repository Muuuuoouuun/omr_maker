// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RegionalAverageMetric } from "./parts";

afterEach(cleanup);

describe("RegionalAverageMetric", () => {
    it("renders a fully ungraded regional average as neutral copy", () => {
        render(<RegionalAverageMetric averageScore={null} />);

        const metric = screen.getByText("평균").parentElement;
        expect(metric).toHaveTextContent("평균미채점");
        expect(metric).not.toHaveTextContent("null점");
    });

    it("keeps a graded regional average in points", () => {
        render(<RegionalAverageMetric averageScore={82} />);

        expect(screen.getByText("평균").parentElement).toHaveTextContent("평균82점");
    });
});
