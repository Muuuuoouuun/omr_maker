// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyticsReportSection } from "./AnalyticsReportSection";

afterEach(cleanup);

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
    });
});
