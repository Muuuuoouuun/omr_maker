import { describe, expect, it } from "vitest";
import {
    MAX_QUESTION_COUNT,
    MIN_QUESTION_COUNT,
    parseQuestionCountInput,
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
});
