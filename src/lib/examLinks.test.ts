import { describe, expect, it } from "vitest";
import { buildExamSharePath, buildExamShareUrl, buildStudentExamLoginHref } from "./examLinks";

describe("exam share links", () => {
    it("keeps public exam links clean", () => {
        expect(buildExamSharePath("exam-1", { type: "public" })).toBe("/solve/exam-1");
    });

    it("adds a class code when one group is selected", () => {
        expect(buildExamSharePath("exam-1", {
            type: "group",
            groupIds: ["class-a"],
        })).toBe("/solve/exam-1?classCode=class-a");
    });

    it("leaves multi-group links code-free so the entry screen can ask", () => {
        expect(buildExamSharePath("exam-1", {
            type: "group",
            groupIds: ["class-a", "class-b"],
        })).toBe("/solve/exam-1");
    });

    it("builds absolute web/app share URLs", () => {
        expect(buildExamShareUrl("https://example.edu", "exam-1", {
            type: "group",
            groupIds: ["A반"],
        })).toBe("https://example.edu/solve/exam-1?classCode=A%EB%B0%98");
    });

    it("uses only the opaque invite for canonical group share links", () => {
        const token = "a".repeat(43);
        expect(buildExamSharePath("exam-1", {
            type: "group",
            groupIds: ["raw-class-a"],
        }, token)).toBe(`/solve/exam-1#invite=${token}`);
        expect(buildExamShareUrl("https://example.edu", "exam-1", {
            type: "group",
            groupIds: ["raw-class-a"],
        }, token)).toBe(`https://example.edu/solve/exam-1#invite=${token}`);
    });

    it("preserves non-secret solve query through login without putting the bearer in a URL", () => {
        const href = buildStudentExamLoginHref("/solve/exam-1?retake=1", "exam-1");
        const query = new URLSearchParams(href.slice(2));

        expect(query.get("role")).toBe("student");
        expect(query.get("exam")).toBe("exam-1");
        expect(query.has("invite")).toBe(false);
        expect(query.get("next")).toBe("/solve/exam-1?retake=1");
        expect(query.has("workspace")).toBe(false);
    });
});
