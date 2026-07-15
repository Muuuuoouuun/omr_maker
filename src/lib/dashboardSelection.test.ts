import { describe, expect, it } from "vitest";
import {
    buildRegionScopedAnalyticsHref,
    formatRegionScopedLabel,
    resolveExamSelection,
    resolveExamSelectionInputValue,
    resolveScopedSelection,
} from "./dashboardSelection";

const exams = [
    { id: "exam-a", title: "중간고사 A" },
    { id: "exam-b", title: "중간고사 B" },
    { id: "exam-c", title: "중간고사 C" },
];

describe("dashboard selection", () => {
    it("keeps a valid manually selected exam", () => {
        expect(resolveExamSelection(exams, "exam-b")).toBe("exam-b");
    });

    it("falls back to the first available exam when the selected exam disappears", () => {
        expect(resolveExamSelection(exams, "deleted-exam")).toBe("exam-a");
    });

    it("clears selection when no exams are available", () => {
        expect(resolveExamSelection([], "exam-a")).toBe("");
    });

    it("keeps the exam search input aligned with the resolved selection", () => {
        expect(resolveExamSelectionInputValue(exams, "exam-b")).toBe("중간고사 B");
        expect(resolveExamSelectionInputValue(exams, "deleted-exam")).toBe("");
        expect(resolveExamSelectionInputValue([], "exam-a")).toBe("");
        expect(resolveExamSelectionInputValue(exams, "")).toBe("");
    });

    it("keeps valid scoped selections and falls back to the first option", () => {
        const options = [
            { key: "seoul-a", label: "A반 · 서울" },
            { key: "busan-a", label: "A반 · 부산" },
        ];

        expect(resolveScopedSelection(options, "busan-a")).toBe("busan-a");
        expect(resolveScopedSelection(options, "deleted")).toBe("seoul-a");
        expect(resolveScopedSelection([], "busan-a")).toBe("");
    });

    it("formats duplicate class or student labels with region context", () => {
        expect(formatRegionScopedLabel("A반", "서울")).toBe("A반 · 서울");
        expect(formatRegionScopedLabel("A반", "")).toBe("A반");
    });

    it("builds a region-scoped dashboard analytics href", () => {
        expect(buildRegionScopedAnalyticsHref("student", "seoul")).toBe("/teacher/dashboard?tab=student&region=seoul");
        expect(buildRegionScopedAnalyticsHref("exam", "busan")).toBe("/teacher/dashboard?tab=exam&region=busan");
    });

    it("omits the region param when no region is given", () => {
        expect(buildRegionScopedAnalyticsHref("student")).toBe("/teacher/dashboard?tab=student");
        expect(buildRegionScopedAnalyticsHref("student", "")).toBe("/teacher/dashboard?tab=student");
    });
});
