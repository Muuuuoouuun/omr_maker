import { describe, expect, it } from "vitest";
import {
    SUBMISSION_DELAY_NOTICE_MS,
    submissionProgressCopy,
} from "./submissionProgress";

describe("submission progress", () => {
    it("explains that the initial wait includes server grading and saving", () => {
        expect(submissionProgressCopy("submitting", false)).toEqual({
            title: "답안을 제출하고 있습니다",
            detail: "서버에서 채점하고 결과를 안전하게 저장하는 중입니다.",
        });
    });

    it("reassures students when a submission takes longer than usual", () => {
        expect(SUBMISSION_DELAY_NOTICE_MS).toBe(8_000);
        expect(submissionProgressCopy("submitting", true)).toEqual({
            title: "제출 처리가 평소보다 오래 걸리고 있습니다",
            detail: "서버 응답을 기다리는 중입니다. 창을 닫지 마세요. 답안 임시저장은 이 기기에 유지됩니다.",
        });
    });

    it("separates post-grading handwriting upload from opening the review", () => {
        expect(submissionProgressCopy("saving_handwriting", false).title).toBe("채점 완료 · 필기 저장 중");
        expect(submissionProgressCopy("opening_review", false)).toEqual({
            title: "제출이 완료되었습니다",
            detail: "채점 결과 화면을 여는 중입니다.",
        });
    });
});
