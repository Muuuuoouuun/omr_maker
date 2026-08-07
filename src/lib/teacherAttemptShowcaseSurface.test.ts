import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
    join(process.cwd(), "src/app/teacher/attempt/[attemptId]/page.tsx"),
    "utf8",
);

describe("teacher showcase attempt surface", () => {
    it("resolves the selected demo result without falling through to canonical storage", () => {
        expect(pageSource).toContain("resolveDemoAttemptDetail(readTeacherSession(), id)");
        expect(pageSource).toContain("setPeerAttempts(demoDetail.peerAttempts)");
        expect(pageSource).toContain("setExam(demoDetail.exam)");
    });

    it("keeps transport failures separate from missing attempts and offers an in-place retry", () => {
        expect(pageSource).toContain("loadTeacherAttemptDetail as loadTeacherAttemptRecord");
        expect(pageSource).toContain('type AttemptDetailLoadStatus = "loading" | "ready" | "not_found" | "error"');
        expect(pageSource).toContain('detailResult.status === "not_found"');
        expect(pageSource).toContain('detailResult.status === "service_unavailable"');
        expect(pageSource).toContain('data-testid="teacher-attempt-load-error"');
        expect(pageSource).toContain("응시 기록을 서버에서 불러오지 못했습니다.");
        expect(pageSource).toContain("setDetailLoadRequest(request => request + 1)");
        expect(pageSource).toContain("다시 시도");
        expect(pageSource).toContain("응시 기록을 찾을 수 없습니다.");
    });
});
