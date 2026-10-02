import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("student UI simplification surface", () => {
    it("collapses alternate login methods without changing the primary account form", () => {
        const home = read("src/app/page.tsx");

        expect(home).toContain('className="student-alternate-entry"');
        expect(home).toContain("다른 방법으로 참여");
        expect(home).not.toContain("학생 포털");
        expect(home.indexOf('className="student-account-login-form"')).toBeLessThan(home.indexOf('className="student-alternate-entry"'));
    });

    it("removes repeated dashboard identity and zero-completion surfaces", () => {
        const dashboard = read("src/app/student/dashboard/page.tsx");

        expect(dashboard).not.toContain("getTimeGreeting");
        expect(dashboard).not.toContain("student-dashboard-role-badge");
        expect(dashboard).not.toContain("상세 보기");
        expect(dashboard).toContain("stats.completedCount > 0");
        expect(dashboard).toContain('title={`${displayStudentName(user.name)}님`}');
    });

    it("trims the solve entry dialog to a confirm-or-switch choice for logged-in students", () => {
        const solve = read("src/app/solve/[id]/page.tsx");
        const switchHandler = solve.slice(solve.indexOf("const switchToAnotherStudent"));

        expect(solve).toContain("consumeSolveEntryIntent(target)");
        expect(solve).toContain("현재 로그인: {studentLabel}");
        expect(solve).toContain("내가 아니에요 · 다른 학생으로 로그인");
        expect(solve).toContain('className="solve-entry-guest-disclosure"');
        expect(solve).toContain('placeholder="이름 (선생님 화면에 표시돼요)"');
        expect(solve).not.toContain("Guest Student");
        // The signed cookie must be gone before the login page sees the
        // request, or restoreSignedStudentScope bounces straight back here.
        expect(switchHandler.indexOf("clearStudentServerSession()")).toBeGreaterThan(-1);
        expect(switchHandler.indexOf("clearStudentServerSession()")).toBeLessThan(switchHandler.indexOf("clearSession()"));
        expect(switchHandler.indexOf("clearSession()")).toBeLessThan(switchHandler.indexOf("router.push("));
        expect(solve).toContain('router.push(user && !user.isGuest ? "/student/dashboard" : "/?role=student")');
    });

    it("keeps secondary solve tools behind one disclosure and defines a three-row phone header", () => {
        const solve = read("src/app/solve/[id]/page.tsx");
        const css = read("src/app/globals.css");

        expect(solve).toContain('className="solve-status-row"');
        expect(solve).toContain('className="solve-tools-disclosure"');
        expect(solve).toContain("<summary");
        expect(solve).toContain("도구");
        expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*\.solve-title-group[\s\S]*grid-row:\s*1/);
        expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*\.solve-status-row[\s\S]*grid-row:\s*2/);
        expect(css).toMatch(/@media \(max-width: 360px\)[\s\S]*\.solve-controls[\s\S]*grid-row:\s*3/);
    });

    it("contains every long review copy surface", () => {
        const css = read("src/app/globals.css");

        expect(css).toMatch(/\.student-review-long-copy\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
        expect(css).toMatch(/\.student-review-meta-chip\s*\{[^}]*min-width:\s*0[^}]*max-width:\s*100%[^}]*overflow-wrap:\s*anywhere/);
        expect(css).toMatch(/\.student-review-recommendation-row (?:span|small)[\s\S]*max-width:\s*100%[\s\S]*overflow-wrap:\s*anywhere/);
    });
});
