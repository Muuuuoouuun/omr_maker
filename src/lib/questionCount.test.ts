import { describe, expect, it } from "vitest";
import {
    MAX_QUESTION_COUNT,
    MIN_QUESTION_COUNT,
    parseQuestionCountInput,
    QUESTION_COUNT_CLAMPED_NOTICE,
    resolveQuestionCountInput,
} from "./questionCount";

describe("question count", () => {
    it("accepts whole-number counts throughout the supported range", () => {
        expect(parseQuestionCountInput("1")).toBe(MIN_QUESTION_COUNT);
        expect(parseQuestionCountInput("45")).toBe(45);
        expect(parseQuestionCountInput("50")).toBe(MAX_QUESTION_COUNT);
    });

    it.each(["", "0", "51", "4.5", "abc"])("rejects %s", value => {
        expect(parseQuestionCountInput(value)).toBeNull();
    });

    it("clamps whole numbers above the maximum instead of rejecting them", () => {
        expect(resolveQuestionCountInput("45")).toEqual({ status: "ok", count: 45 });
        expect(resolveQuestionCountInput("50")).toEqual({ status: "ok", count: MAX_QUESTION_COUNT });
        expect(resolveQuestionCountInput("51")).toEqual({ status: "clamped", count: MAX_QUESTION_COUNT });
        expect(resolveQuestionCountInput(" 120 ")).toEqual({ status: "clamped", count: MAX_QUESTION_COUNT });
        expect(QUESTION_COUNT_CLAMPED_NOTICE).toBe("최대 50문항까지 만들 수 있어 50으로 맞췄습니다");
    });

    it.each(["", "0", "4.5", "abc", "-3"])("still rejects %s", value => {
        expect(resolveQuestionCountInput(value)).toEqual({ status: "invalid" });
    });
});
