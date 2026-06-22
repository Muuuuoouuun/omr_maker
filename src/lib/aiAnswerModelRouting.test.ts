import { describe, expect, it } from "vitest";
import {
    AI_ANSWER_MODELS,
    evaluateAnswerRowsQuality,
    shouldUseHighAccuracyAnswerModel,
} from "./aiAnswerModelRouting";

describe("AI answer model routing", () => {
    it("uses Gemini 3.5 Flash by default with Pro fallback models", () => {
        expect(AI_ANSWER_MODELS).toEqual({
            default: "gemini-3.5-flash",
            highAccuracy: "gemini-3.1-pro-preview",
            fallback: "gemini-2.5-pro",
        });
    });

    it("keeps clean answer rows on the default model path", () => {
        const report = evaluateAnswerRowsQuality([
            { questionNum: 1, answer: 3, confidence: 0.91 },
            { questionNum: 2, answer: 1, confidence: 0.88 },
            { questionNum: 3, answer: 5, confidence: 0.94 },
        ]);

        expect(report).toMatchObject({
            status: "ok",
            reason: "ok",
            validRows: 3,
            invalidRows: 0,
        });
        expect(shouldUseHighAccuracyAnswerModel({}, report)).toBe(false);
    });

    it("routes rerecognition to the high accuracy model", () => {
        expect(shouldUseHighAccuracyAnswerModel({ recognitionMode: "rerecognition" })).toBe(true);
    });

    it("routes low quality rows to the high accuracy model", () => {
        const report = evaluateAnswerRowsQuality([
            { questionNum: 1, answer: 3, confidence: 0.5 },
            { questionNum: 2, answer: 1, confidence: 0.6 },
            { questionNum: 2, answer: 4, confidence: 0.8 },
            { questionNum: "bad", answer: 9 },
        ]);

        expect(report.status).toBe("many_errors");
        expect(shouldUseHighAccuracyAnswerModel({}, report)).toBe(true);
    });
});
