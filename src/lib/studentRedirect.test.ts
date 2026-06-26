import { describe, expect, it } from "vitest";
import { normalizeStudentRedirectPath } from "./studentRedirect";

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
});
