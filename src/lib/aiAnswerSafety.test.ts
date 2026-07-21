import { describe, expect, it } from "vitest";
import {
    AI_ANSWER_IMAGE_LIMITS,
    extractAnswerJsonArrayPayload,
    invalidAiJsonError,
    safeAiAnswerErrorMessage,
    safeAiAnswerLogMeta,
    shouldRetryAiAnswerModelError,
    validateAnswerImageParts,
} from "./aiAnswerSafety";

describe("AI answer safety", () => {
    it("extracts only the JSON answer array from fenced AI responses", () => {
        expect(extractAnswerJsonArrayPayload("```json\n[{\"questionNum\":1,\"answer\":3}]\n```")).toBe('[{"questionNum":1,"answer":3}]');
        expect(extractAnswerJsonArrayPayload("앞 설명 [{\"questionNum\":2,\"answer\":4}] 뒤 설명")).toBe('[{"questionNum":2,"answer":4}]');
    });

    it("returns safe user-facing messages without leaking raw AI text", () => {
        const rawResponse = "원본 응답: [{\"questionNum\":1,\"answer\":5,\"student\":\"김학생\"}]";
        expect(safeAiAnswerErrorMessage(invalidAiJsonError(rawResponse.length))).toBe(
            "AI가 유효한 정답 형식을 반환하지 않았습니다. 이미지가 선명한지 확인해주세요."
        );
        expect(safeAiAnswerErrorMessage(new Error(rawResponse))).toBe(
            "AI 인식 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요."
        );
    });

    it("keeps log metadata bounded and free of raw response content", () => {
        const rawResponse = "정답 1번 A, 2번 B, 3번 C";
        const meta = safeAiAnswerLogMeta(new Error(rawResponse), { imageCount: 2 });

        expect(meta).toMatchObject({
            imageCount: 2,
            category: "unknown",
            errorName: "Error",
            messageLength: rawResponse.length,
        });
        expect(JSON.stringify(meta)).not.toContain("정답 1번");
    });

    it("normalizes valid answer image parts before provider calls", () => {
        expect(validateAnswerImageParts(["data:image/jpg;base64, Zm9v\n"])).toEqual([
            { data: "Zm9v", mimeType: "image/jpeg" },
        ]);
        expect(validateAnswerImageParts(["YmFy"])).toEqual([
            { data: "YmFy", mimeType: "image/jpeg" },
        ]);
    });

    it("rejects invalid or excessive answer image inputs with safe messages", () => {
        const invalidInputs: unknown[] = [
            [],
            new Array(AI_ANSWER_IMAGE_LIMITS.maxImages + 1).fill("data:image/jpeg;base64,Zm9v"),
            ["data:text/html;base64,PHNjcmlwdD4="],
            ["data:image/jpeg,Zm9v"],
            ["data:image/jpeg;base64,not base64!"],
            ["data:image/png;base64," + "A".repeat(AI_ANSWER_IMAGE_LIMITS.maxSingleBase64Chars + 1)],
        ];

        for (const input of invalidInputs) {
            let error: unknown;
            try {
                validateAnswerImageParts(input);
            } catch (caught) {
                error = caught;
            }

            expect(error).toBeInstanceOf(Error);
            expect(safeAiAnswerErrorMessage(error)).toBe("정답 이미지 형식 또는 용량을 확인해주세요.");
            expect(safeAiAnswerLogMeta(error)).toMatchObject({
                category: "invalid_image_input",
                errorName: "AIAnswerInputError",
            });
        }
    });

    it("retries only errors that another model can plausibly recover", () => {
        expect(shouldRetryAiAnswerModelError(invalidAiJsonError(120))).toBe(true);
        expect(shouldRetryAiAnswerModelError(new Error("model not found: 404"))).toBe(true);

        expect(shouldRetryAiAnswerModelError(new Error("invalid API key: 401"))).toBe(false);
        expect(shouldRetryAiAnswerModelError(new Error("quota exhausted: 429"))).toBe(false);
        expect(shouldRetryAiAnswerModelError(new Error("network fetch failed"))).toBe(false);
        expect(shouldRetryAiAnswerModelError(new Error("request aborted due to timeout"))).toBe(false);
    });

    it("reports provider timeouts without exposing raw errors", () => {
        const timeoutError = new Error("request aborted due to timeout after secret payload");

        expect(safeAiAnswerErrorMessage(timeoutError)).toBe(
            "AI 인식 시간이 초과되었습니다. 잠시 후 다시 시도해주세요.",
        );
        expect(safeAiAnswerLogMeta(timeoutError)).toMatchObject({ category: "timeout" });
    });
});
