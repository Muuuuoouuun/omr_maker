import { describe, expect, it } from "vitest";
import { buildRetakeHref } from "./retakeLinks";

describe("retake links", () => {
    it("builds stable retake solve links with sorted unique question ids", () => {
        expect(buildRetakeHref("exam-1", "student:kim", [3, 2, 3], "similar", {
            labels: ["문학", ""],
            concepts: ["화자의 정서"],
        })).toBe("/solve/exam-1?retakeFrom=student%3Akim&questions=2%2C3&mode=similar&labels=%EB%AC%B8%ED%95%99&concepts=%ED%99%94%EC%9E%90%EC%9D%98+%EC%A0%95%EC%84%9C");
    });

    it("omits empty metadata while preserving explicit mode", () => {
        expect(buildRetakeHref("exam-2", "attempt-1", [5], "wrong")).toBe(
            "/solve/exam-2?retakeFrom=attempt-1&questions=5&mode=wrong"
        );
    });
});
