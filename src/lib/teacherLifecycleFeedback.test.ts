import { describe, expect, it } from "vitest";
import { teacherLifecycleFeedback, TEACHER_LIFECYCLE_SERVICE_UNAVAILABLE } from "./teacherLifecycleFeedback";

describe("teacher sign-up and recovery feedback", () => {
    it("confirms completed requests instead of reporting them as errors", () => {
        for (const status of ["accepted", "completed", "verified"]) {
            expect(teacherLifecycleFeedback(status).tone, status).toBe("success");
        }
        expect(teacherLifecycleFeedback("verified").text).toBe("이메일 확인이 완료되었습니다. 이제 로그인할 수 있습니다.");
    });

    it("keeps account existence hidden behind the same acceptance message", () => {
        expect(teacherLifecycleFeedback("accepted").text).toContain("계정 존재 여부와 관계없이");
    });

    it("explains each failure truthfully without promising delivery", () => {
        expect(teacherLifecycleFeedback("delivery_unavailable")).toMatchObject({
            tone: "error",
            text: expect.stringContaining("이메일 전송 기능이 아직 연결되지 않았습니다"),
        });
        expect(teacherLifecycleFeedback("invalid_input").text).toContain("12자 이상");
        expect(teacherLifecycleFeedback("rate_limited").text).toContain("잠시 후 다시 시도");
        expect(teacherLifecycleFeedback("invalid_or_expired").text).toContain("새 링크를 요청");
    });

    it("falls back to the service message for unknown or infrastructure statuses", () => {
        for (const status of ["service_unavailable", "dependency_unavailable", "unauthenticated", "constructor", ""]) {
            expect(teacherLifecycleFeedback(status), status).toEqual({
                status,
                tone: "error",
                text: TEACHER_LIFECYCLE_SERVICE_UNAVAILABLE,
            });
        }
    });
});
