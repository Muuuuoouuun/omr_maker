import { describe, expect, it } from "vitest";
import { buildExamSharePath, buildExamShareUrl } from "./examLinks";

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
});
