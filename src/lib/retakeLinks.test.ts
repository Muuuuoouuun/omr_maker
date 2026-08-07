import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRetakeHref, supportedReviewRetakeModes } from "./retakeLinks";

describe("retake links", () => {
    it("offers only the backend-supported wrong-answer scope for canonical attempts", () => {
        expect(supportedReviewRetakeModes("server")).toEqual(["wrong"]);
        expect(supportedReviewRetakeModes("local")).toEqual(["wrong", "custom", "similar"]);
        expect(supportedReviewRetakeModes(null)).toEqual(["wrong"]);
    });

    it("hides custom and similar actions on the canonical review surface", () => {
        const review = readFileSync(
            join(process.cwd(), "src/app/student/review/[attemptId]/page.tsx"),
            "utf8",
        );

        expect(review).toContain("setAttemptSource(result.source)");
        expect(review).toContain('supportedReviewRetakeModes(attemptSource).includes("custom")');
        expect(review).not.toContain("오답과 같은 유형을 바로 다시 풉니다.");
        expect(review).toContain("retakeHref={canUseScopedRetakes ? buildRetakeHref");
        expect(review).toContain("운영 기록은 서버가 검증한 오답 전체 재시험만 지원합니다.");
    });

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
