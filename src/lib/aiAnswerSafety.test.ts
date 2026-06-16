import { describe, expect, it } from "vitest";
import {
    extractAnswerJsonArrayPayload,
    invalidAiJsonError,
    safeAiAnswerErrorMessage,
    safeAiAnswerLogMeta,
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
});
