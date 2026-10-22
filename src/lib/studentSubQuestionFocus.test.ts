// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { findMissingRequiredSubQuestions } from "./subQuestions";
import { focusMissingSubQuestionInput } from "./studentSubQuestionFocus";

afterEach(() => { document.body.replaceChildren(); });

describe("required response focus recovery", () => {
    it("focuses the second missing response while keeping the first completed response intact", () => {
        const questions = [{ id: 1, number: 1, subQuestions: [
            { schemaVersion: 1 as const, id: "first", prompt: "첫 응답", kind: "free_text" as const, required: true },
            { schemaVersion: 1 as const, id: "second", prompt: "둘째 응답", kind: "free_text" as const, required: true },
        ] }];
        const missing = findMissingRequiredSubQuestions(questions, {
            1: { first: { schemaVersion: 1, body: "작성한 첫 응답", reviewStatus: "needs_review" } },
        });
        const [first, second] = ["first", "second"].map(id => {
            const input = document.createElement("textarea");
            input.dataset.questionId = "1";
            input.dataset.subQuestionId = id;
            document.body.append(input);
            return input;
        });
        first.value = "작성한 첫 응답";

        expect(missing).toEqual([{ questionId: 1, subQuestionId: "second" }]);
        expect(focusMissingSubQuestionInput(document, missing[0])).toBe(true);
        expect(document.activeElement).toBe(second);
        expect(first.value).toBe("작성한 첫 응답");
    });

    it("matches imported special-character IDs exactly and never falls back to a different input", () => {
        const input = document.createElement("textarea");
        input.dataset.questionId = "2";
        input.dataset.subQuestionId = '__proto__"]';
        document.body.append(input);
        expect(focusMissingSubQuestionInput(document, { questionId: 1, subQuestionId: '__proto__"]' })).toBe(false);
        expect(focusMissingSubQuestionInput(document, { questionId: 2, subQuestionId: '__proto__"]' })).toBe(true);
        expect(document.activeElement).toBe(input);
    });
});
