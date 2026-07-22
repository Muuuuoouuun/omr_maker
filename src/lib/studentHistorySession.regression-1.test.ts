import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listStudentCanonicalAttempts } from "@/app/actions/studentAttempts";
import { loadStudentOfficialAttempts } from "./studentAttemptClient";
import type { StudentSession } from "@/utils/storage";

vi.mock("@/app/actions/studentAttempts", () => ({
    listStudentCanonicalAttempts: vi.fn(),
    loadStudentCanonicalAttempt: vi.fn(),
}));

const studentSession: StudentSession = {
    studentId: "student-1",
    name: "학생 1",
    isGuest: false,
    identityType: "temporary",
};

describe("student history session failures", () => {
    beforeEach(() => vi.clearAllMocks());

    // Regression: ISSUE-002 — an expired server session looked like empty history
    // Found by /qa on 2026-07-22
    // Report: .gstack/qa-reports/qa-report-localhost-2026-07-22.md
    it("preserves an unauthorized status so history asks the student to log in again", async () => {
        vi.mocked(listStudentCanonicalAttempts).mockResolvedValue({ status: "unauthorized" });

        await expect(loadStudentOfficialAttempts(studentSession)).resolves.toMatchObject({
            items: [],
            remoteLoaded: false,
            remoteStatus: "unauthorized",
        });

        const historyPage = readFileSync(resolve(process.cwd(), "src/app/student/history/page.tsx"), "utf8");
        expect(historyPage).toContain('attemptResult.remoteStatus === "unauthorized"');
        expect(historyPage).toContain("로그인 세션이 만료되었습니다.");
    });

    it("preserves a service failure so history offers retry instead of claiming there are no records", async () => {
        vi.mocked(listStudentCanonicalAttempts).mockResolvedValue({
            status: "service_unavailable",
            error: "database timeout",
        });

        await expect(loadStudentOfficialAttempts(studentSession)).resolves.toMatchObject({
            items: [],
            remoteLoaded: false,
            remoteStatus: "service_unavailable",
            remoteError: "database timeout",
        });

        const historyPage = readFileSync(resolve(process.cwd(), "src/app/student/history/page.tsx"), "utf8");
        expect(historyPage).toContain('attemptResult.remoteStatus === "service_unavailable"');
    });
});
