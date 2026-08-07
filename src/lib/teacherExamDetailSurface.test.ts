import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pageSource = readFileSync(
    join(process.cwd(), "src/app/teacher/exam/[id]/page.tsx"),
    "utf8",
);
const globalStyles = readFileSync(
    join(process.cwd(), "src/app/globals.css"),
    "utf8",
);

describe("teacher exam detail loading surface", () => {
    it("resolves the signed showcase workspace from the deterministic demo fixture", () => {
        expect(pageSource).toContain("shouldUseDemoData(readTeacherSession())");
        expect(pageSource).toContain("buildDemoDashboardData()");
        expect(pageSource).toContain("demo.exams.find(candidate => candidate.id === id)");
    });

    it("cannot leave a failed or missing exam behind an indefinite loading label", () => {
        expect(pageSource).toContain('type DetailLoadStatus = "loading" | "ready" | "not_found" | "error"');
        expect(pageSource).toContain("DETAIL_LOAD_TIMEOUT_MS");
        expect(pageSource).toContain('setLoadStatus("not_found")');
        expect(pageSource).toContain('setLoadStatus("error")');
        expect(pageSource).not.toContain("if (!exam) return <div style={{ padding: '2rem' }}>Loading...</div>");
    });

    it("distinguishes canonical not-found from authentication and service failures", () => {
        expect(pageSource).toContain("loadTeacherExamDetail(id)");
        expect(pageSource).toContain('loadedExamResult.status === "not_found"');
        expect(pageSource).toContain('loadedExamResult.status === "unauthorized"');
        expect(pageSource).toContain('loadedExamResult.status === "service_unavailable"');
        expect(pageSource).toContain("교사 인증을 다시 확인한 뒤 재시도해 주세요.");
        expect(pageSource).toContain("시험 정보를 서버에서 확인하지 못했습니다.");
    });

    it("does not present failed canonical attempt reads as zero submissions", () => {
        expect(pageSource).toContain("loadedAttempts.remoteError");
        expect(pageSource).toContain("제출 기록을 서버에서 확인하지 못했습니다.");
        expect(pageSource.indexOf('loadedExamResult.status === "not_found"'))
            .toBeLessThan(pageSource.indexOf("loadedAttempts.remoteError"));
    });

    it("offers useful recovery actions after the load resolves unsuccessfully", () => {
        expect(pageSource).toContain('data-testid="exam-detail-unavailable"');
        expect(pageSource).toContain("시험을 찾을 수 없습니다");
        expect(pageSource).toContain("다시 시도");
        expect(pageSource).toContain('href="/teacher/dashboard"');
    });

    it("keeps brand, page context, and primary actions in distinct mobile header rows", () => {
        expect(pageSource).toContain('className="layout-main teacher-exam-detail-page"');
        expect(pageSource).toContain('className="teacher-exam-context-bar"');
        expect(pageSource).toContain('className="teacher-exam-context-title"');
        expect(pageSource).toContain('<h1 className="teacher-exam-context-title">{exam.title}</h1>');
        expect(pageSource).toContain('className="teacher-exam-context-actions"');

        expect(globalStyles).toMatch(/@media \(max-width: 600px\)[\s\S]*\.teacher-exam-detail-page \.teacher-header-brand[\s\S]*flex-basis: 100%/);
        expect(globalStyles).toMatch(/\.teacher-exam-context-title[\s\S]*-webkit-line-clamp: 2/);
    });

    it("uses a bounded progressive result list on mobile while retaining the desktop table", () => {
        expect(pageSource).toContain('const MOBILE_RESULT_BATCH_SIZE = 6');
        expect(pageSource).toContain('className="teacher-exam-results-table"');
        expect(pageSource).toContain('className="teacher-exam-mobile-results"');
        expect(pageSource).toContain('sortedAttempts.slice(0, mobileResultLimit).map');
        expect(pageSource).toContain('data-testid="teacher-exam-mobile-result-card"');
        expect(pageSource).toContain('setMobileResultLimit(limit => limit + MOBILE_RESULT_BATCH_SIZE)');
        expect(pageSource).toContain("CSV 내보내기");

        expect(globalStyles).toMatch(/\.teacher-exam-mobile-results\s*\{[\s\S]*display: none/);
        expect(globalStyles).toMatch(/@media \(max-width: 600px\)[\s\S]*\.teacher-exam-results-table[\s\S]*display: none/);
        expect(globalStyles).toMatch(/@media \(max-width: 600px\)[\s\S]*\.teacher-exam-mobile-results[\s\S]*display: grid/);
    });

    it("uses semantic theme tokens instead of fixed light surfaces", () => {
        expect(pageSource).not.toContain("background: '#f8fafc'");
        expect(pageSource).not.toContain("color: '#0f172a'");
        expect(pageSource).not.toContain("color: '#475569'");
        expect(pageSource).toContain('className="layout-main teacher-exam-detail-page"');
        expect(pageSource).toContain('className="teacher-exam-results-table-head"');
    });
});
