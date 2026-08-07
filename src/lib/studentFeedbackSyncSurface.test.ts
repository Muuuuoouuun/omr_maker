import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("student feedback synchronization surface", () => {
    it("makes feedback authentication and service failures retryable on the dashboard", () => {
        const source = fs.readFileSync(path.join(root, "src/app/student/dashboard/page.tsx"), "utf8");

        expect(source).toContain('returnedFeedbackResult.status === "unauthorized"');
        expect(source).toContain('returnedFeedbackResult.status === "service_unavailable"');
        expect(source).toContain('data-testid="student-feedback-sync-error"');
        expect(source).toContain("피드백 알림을 불러오지 못했습니다");
    });

    it("does not show a successful history state when its feedback inbox failed", () => {
        const source = fs.readFileSync(path.join(root, "src/app/student/history/page.tsx"), "utf8");

        expect(source).toContain('feedbackResult.status === "unauthorized"');
        expect(source).toContain('feedbackResult.status === "service_unavailable"');
        expect(source).toContain("피드백 알림을 불러오지 못했습니다");
        expect(source).toContain('window.addEventListener("focus"');
        expect(source).toContain('document.addEventListener("visibilitychange"');
    });
});
