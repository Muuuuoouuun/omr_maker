import { describe, expect, it } from "vitest";
import { parseFastAnswerInput } from "./fastAnswerInput";

describe("parseFastAnswerInput", () => {
    it("maps each digit to the next question in order", () => {
        expect(parseFastAnswerInput("31251", 5)).toEqual({ value: "31251", answers: [3, 1, 2, 5, 1], rejectedCount: 0 });
    });

    it("treats - as a blank that keeps its position so later answers do not shift", () => {
        const result = parseFastAnswerInput("3-25", 5);
        expect(result.answers).toEqual([3, undefined, 2, 5]);
        expect(result.answers[3]).toBe(5);
        expect(result.value).toBe("3-25");
        expect(result.rejectedCount).toBe(0);
    });

    it("uses spaces and commas only as separators", () => {
        expect(parseFastAnswerInput("12 34,5-", 5)).toEqual({
            value: "12 34,5-",
            answers: [1, 2, 3, 4, 5, undefined],
            rejectedCount: 0,
        });
    });

    it("rejects out-of-range digits and other characters with a count", () => {
        expect(parseFastAnswerInput("1502a3", 4)).toEqual({ value: "123", answers: [1, 2, 3], rejectedCount: 3 });
        expect(parseFastAnswerInput("5", 5).rejectedCount).toBe(0);
        expect(parseFastAnswerInput("5", 4)).toEqual({ value: "", answers: [], rejectedCount: 1 });
    });

    it("only accepts - as the blank marker", () => {
        expect(parseFastAnswerInput("1.0", 5)).toEqual({ value: "1", answers: [1], rejectedCount: 2 });
    });

    it("returns no answers for empty input", () => {
        expect(parseFastAnswerInput("", 5)).toEqual({ value: "", answers: [], rejectedCount: 0 });
    });
});
