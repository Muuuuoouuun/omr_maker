import { describe, expect, it } from "vitest";
import { DEFAULT_CHOICE_COUNT, normalizeChoiceCount, questionChoiceCount } from "./omr";

describe("OMR choice count helpers", () => {
    it("defaults unspecified multiple-choice questions to 5 choices", () => {
        expect(DEFAULT_CHOICE_COUNT).toBe(5);
        expect(normalizeChoiceCount(undefined)).toBe(5);
        expect(questionChoiceCount({})).toBe(5);
    });

    it("preserves explicit 4-choice and 5-choice questions", () => {
        expect(normalizeChoiceCount(4)).toBe(4);
        expect(normalizeChoiceCount(5)).toBe(5);
        expect(questionChoiceCount({ choices: 4 })).toBe(4);
        expect(questionChoiceCount({ choices: 5 })).toBe(5);
    });
});
