import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getVisibleToastItems } from "@/components/Toast";
import {
    DEFAULT_COMET_DELAY_MS,
    DEFAULT_COMET_DURATION_MS,
    shouldReduceCometMotion,
} from "@/components/dashboard/useCometReveal";

const rootDir = process.cwd();

function read(relativePath: string): string {
    return readFileSync(path.join(rootDir, relativePath), "utf8");
}

describe("design 93 surface regressions", () => {
    it("shows transient notifications one at a time so mobile actions stay reachable", () => {
        expect(getVisibleToastItems(["first", "second", "third"])).toEqual(["first"]);
        expect(getVisibleToastItems([])).toEqual([]);
    });

    it("respects both OS and in-app reduced-motion preferences for chart reveals", () => {
        expect(shouldReduceCometMotion(true, null)).toBe(true);
        expect(shouldReduceCometMotion(false, "off")).toBe(true);
        expect(shouldReduceCometMotion(false, "on")).toBe(false);
        expect(DEFAULT_COMET_DURATION_MS).toBeLessThanOrEqual(700);
        expect(DEFAULT_COMET_DELAY_MS).toBeLessThanOrEqual(120);
    });

    it("keeps the 320px distribution dialog inside the viewport with an independently scrollable body", () => {
        const modal = read("src/components/DistributeModal.tsx");
        const css = read("src/app/globals.css");

        expect(modal).toContain("balanced-dialog-panel distribute-dialog");
        expect(modal).toContain("distribute-dialog-body");
        expect(modal).toContain("height: 'var(--app-viewport-height, 100dvh)'");
        expect(css).toMatch(/\.distribute-dialog\s*\{[\s\S]*?max-height:\s*calc\([\s\S]*?var\(--app-viewport-height, 100dvh\)[\s\S]*?var\(--app-safe-area-top\)[\s\S]*?var\(--app-safe-area-bottom\)[\s\S]*?\);/);
        expect(css).toMatch(/\.distribute-dialog-body\s*\{[^}]*overflow-y:\s*auto/);
    });

    it("allows long review explanations and messages to break without clipping", () => {
        const review = read("src/app/student/review/[attemptId]/page.tsx");
        const css = read("src/app/globals.css");

        expect((review.match(/student-review-long-copy/g) || []).length).toBeGreaterThanOrEqual(4);
        expect(css).toMatch(/\.student-review-long-copy\s*\{[^}]*overflow-wrap:\s*anywhere/);
    });

    it("removes nonessential account controls from the narrow create toolbar", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.create-editor-actions \.teacher-session-chip[\s\S]*display:\s*none/);
        expect(css).toContain('.create-editor-actions button[aria-label="교사 로그아웃"]');
        expect(css).toContain('.create-editor-actions button[aria-label$="모드로 전환"]');
    });

    it("uses explicit transition properties instead of transition-all", () => {
        const css = read("src/app/globals.css");
        const themeToggle = read("src/components/ThemeToggle.tsx");

        expect(css).not.toMatch(/transition:\s*all\b/);
        expect(themeToggle).not.toMatch(/transition:\s*["']all\b/);
    });

    it("renders the teacher attempt loading state as localized, announced progress", () => {
        const attemptPage = read("src/app/teacher/attempt/[attemptId]/page.tsx");

        expect(attemptPage).not.toContain("Loading...");
        expect(attemptPage).toContain('role="status"');
        expect(attemptPage).toContain("응시 기록을 불러오는 중입니다");
    });

    it("protects long student names and gives narrow assignment cards a readable two-row layout", () => {
        const dashboard = read("src/app/student/dashboard/page.tsx");
        const assignment = read("src/components/dashboard/AssignmentBlock.tsx");
        const css = read("src/app/globals.css");

        expect(dashboard).toContain("student-dashboard-welcome");
        expect(assignment).toContain("student-assignment-row");
        expect(assignment).toContain("student-assignment-title");
        expect(assignment).not.toMatch(/transition:\s*["']all\b/);
        expect(css).toMatch(/\.student-dashboard-welcome h1\s*\{[^}]*overflow-wrap:\s*anywhere/);
        expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*\.student-assignment-row\s*\{[^}]*grid-template-columns/);
    });

    it("contains long review metadata and recommendation tokens", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/\.student-review-meta-chip\s*\{[^}]*overflow-wrap:\s*anywhere/);
        expect(css).toMatch(/\.student-review-recommendation-row span[\s\S]*overflow-wrap:\s*anywhere/);
        expect(css).toMatch(/\.student-review-recommendation-row small[\s\S]*overflow-wrap:\s*anywhere/);
    });

    it("keeps the solve workspace header in normal flow on touch layouts", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.solve-header\s*\{[^}]*position:\s*relative/);
        expect(css).toMatch(/@media \(max-width: 768px\)[\s\S]*\.pdf-viewer-toolbar\s*\{[^}]*overflow-x:\s*hidden/);
    });

    it("keeps teacher invite actions reachable and the records table scrollable on phones", () => {
        const invites = read("src/components/teacher/users/InvitesTab.tsx");
        const css = read("src/app/globals.css");

        expect(invites).toContain("teacher-invite-share");
        expect(invites).toContain("teacher-invite-table-scroll");
        expect(css).toMatch(/\.teacher-invite-table-scroll\s*\{[^}]*overflow-x:\s*auto/);
        expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.teacher-invite-share\s*\{[^}]*grid-template-columns/);
    });

    it("stacks question-level recommendation actions below long copy on phones", () => {
        const analytics = read("src/components/dashboard/tabs/ExamAnalyticsTab.tsx");
        const css = read("src/app/globals.css");

        expect(analytics).toContain("exam-type-recommendation-row");
        expect(analytics).toContain("exam-type-recommendation-action");
        expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.exam-type-recommendation-row\s*\{[^}]*grid-template-columns/);
    });

    it("keeps Korean analytics headings together while retaining emergency long-token breaks", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/\.dashboard-main :where\(h1, h2, h3, h4\)\s*\{[^}]*word-break:\s*keep-all[^}]*overflow-wrap:\s*break-word/);
    });

    it("switches the create workspace out of unusable three-pane mode below 1280px", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.create-workspace\s*\{[^}]*flex-direction:\s*column/);
        expect(css).toMatch(/@media \(max-width: 1279px\)[\s\S]*\.create-resizer\s*\{[^}]*display:\s*none/);
    });

    it("consolidates create PDF uploads and secondary view controls", () => {
        const create = read("src/app/create/page.tsx");

        expect(create).toContain('aria-label="PDF 관리"');
        expect(create).toContain('aria-expanded={isOpen}');
        expect(create).toContain('aria-controls={menuId}');
        expect(create).toContain('role="menuitem"');
        expect(create).toContain('className="create-settings-view-options"');
        expect(create).not.toContain("스마트 에디터");
        expect(create).not.toContain("<small>{designSummary.answered}/{questionsCount} 정답</small>");
        expect(create).not.toContain("<small>{serviceReadiness.label}</small>");
    });

    it("keeps create-page notifications above the mobile action rail", () => {
        const toast = read("src/components/Toast.tsx");
        const css = read("src/app/globals.css");

        expect(toast).toContain("toast-host");
        expect(css).toMatch(/body:has\(\.create-workspace\) \.toast-host\s*\{[^}]*bottom:/);
    });

    it("provides 44px create-editor touch targets without squeezing six presets into one row", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/@media \(max-width: 820px\)[\s\S]*\.create-settings-tool-button[\s\S]*min-height:\s*44px/);
        expect(css).toMatch(/@media \(max-width: 820px\)[\s\S]*\.create-count-buttons\s*\{[^}]*grid-template-columns:\s*repeat\(3/);
        expect(css).toMatch(/@media \(max-width: 820px\)[\s\S]*\.create-label-candidate-main[\s\S]*min-height:\s*44px/);
    });

    it("announces PDF success only after the viewer reports it is ready", () => {
        const create = read("src/app/create/page.tsx");

        expect(create).toContain("pendingPdfReadyToastRef");
        expect(create).toContain("handleActivePdfLoadSuccess");
        expect(create).toContain("PDF 미리보기 준비 완료");
        expect(create).not.toContain('toast.success("문제지 PDF 업로드됨"');
        expect(create).not.toContain('toast.success("답지 PDF 업로드됨"');
    });
});
