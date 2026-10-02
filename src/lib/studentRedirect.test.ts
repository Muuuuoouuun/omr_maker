import { describe, expect, it } from "vitest";
import { buildStudentLoginHref, normalizeStudentRedirectPath } from "./studentRedirect";

describe("student redirects", () => {
    it("allows solve and student app paths", () => {
        expect(normalizeStudentRedirectPath("/solve/exam-1?classCode=a")).toBe("/solve/exam-1?classCode=a");
        expect(normalizeStudentRedirectPath("/student/history")).toBe("/student/history");
    });

    it("falls back for missing, external, protocol-relative, or teacher paths", () => {
        expect(normalizeStudentRedirectPath(null)).toBe("/student/dashboard");
        expect(normalizeStudentRedirectPath("https://evil.test/solve/exam")).toBe("/student/dashboard");
        expect(normalizeStudentRedirectPath("//evil.test/solve/exam")).toBe("/student/dashboard");
        expect(normalizeStudentRedirectPath("/teacher/dashboard")).toBe("/student/dashboard");
    });

    it("builds student login links that return to a safe student path", () => {
        expect(buildStudentLoginHref()).toBe("/?role=student");
        expect(buildStudentLoginHref("/student/dashboard")).toBe("/?role=student&next=%2Fstudent%2Fdashboard");
        expect(buildStudentLoginHref("/solve/exam-1?classCode=a", { reason: "expired" }))
            .toBe("/?role=student&reason=expired&next=%2Fsolve%2Fexam-1%3FclassCode%3Da");
        expect(buildStudentLoginHref("https://evil.test/solve/x")).toBe("/?role=student&next=%2Fstudent%2Fdashboard");
    });
});
