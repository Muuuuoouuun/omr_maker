import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("student guest merge login", () => {
    // Regression: ISSUE-001 — guest-attempt sync blocked student login navigation
    // Found by /qa on 2026-07-22
    // Report: .gstack/qa-reports/qa-report-localhost-2026-07-22.md
    it("starts guest-attempt server sync without waiting before finishing login", () => {
        const homePage = readFileSync(resolve(process.cwd(), "src/app/page.tsx"), "utf8");

        expect(homePage).not.toContain("await syncMergedGuestAttempts(session.studentId");
        expect(homePage).toContain("void syncMergedGuestAttempts(session.studentId");
    });
});
