import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("teacher account lifecycle surface", () => {
    it("authenticates active database accounts before explicit bootstrap credentials", () => {
        const action = source("src/app/actions/auth.ts");
        expect(action).toContain("findActiveTeacherAccount");
        expect(action).toContain("verifyTeacherAccountPasswordConstantWork");
        expect(action).toContain("isTeacherBootstrapLoginEnabled");
        expect(action.indexOf("findActiveTeacherAccount"))
            .toBeLessThan(action.indexOf("verifyTeacherLogin(identifier, password)"));
        expect(action).toMatch(
            /await verifyTeacherAccountPasswordConstantWorkAsync\(\s*password,\s*account\?\.passwordHash,?\s*\)/,
        );
        expect(action).toContain("OMR_ALLOW_TEACHER_BOOTSTRAP_LOGIN");
    });

    it("offers truthful signup and password recovery without promising delivery", () => {
        const page = source("src/app/page.tsx");
        expect(page).toContain("requestTeacherSignup");
        expect(page).toContain("requestTeacherPasswordReset");
        expect(page).toContain("finishTeacherPasswordReset");
        expect(page).toContain("confirmTeacherSignupEmail");
        expect(page).toContain("teacherResetToken");
        expect(page).toContain("teacherVerifyToken");
        expect(page).toContain("교사 계정 만들기");
        expect(page).toContain("비밀번호 재설정");
        expect(page).toContain("이메일 전송 기능이 아직 연결되지 않았습니다");
        expect(page).toContain("부트스트랩 계정");
    });

    it("submits the visible teacher account mode with matching fields and browser semantics", () => {
        const page = source("src/app/page.tsx");
        const teacherSurface = page.slice(
            page.indexOf('{role === "teacher" ? ('),
            page.indexOf("{/* Student form */}"),
        );

        expect(teacherSurface.match(/<form\b/g)).toHaveLength(1);
        expect(teacherSurface).toContain('aria-label={teacherAccountFormLabel}');
        expect(teacherSurface).toContain("void handleTeacherAccountSubmit();");

        expect(page).toContain('if (teacherAccountMode === "signup") return handleTeacherSignup();');
        expect(page).toContain('if (teacherAccountMode === "reset") return handleTeacherPasswordReset();');
        expect(page).toContain('if (teacherAccountMode === "reset_complete") return handleTeacherPasswordResetCompletion();');
        expect(page).toContain("return handleTeacherLogin();");

        expect(teacherSurface).toContain('htmlFor="teacher-display-name"');
        expect(teacherSurface).toContain('id="teacher-display-name"');
        expect(teacherSurface).toContain('autoComplete="name"');
        expect(teacherSurface).toContain('autoComplete={teacherAccountMode === "login" ? "current-password" : "new-password"}');

        expect(page).toContain('teacherAccountMode === "signup" ? "가입 이메일 요청"');
        expect(page).toContain('teacherAccountMode === "reset" ? "재설정 이메일 요청"');
        expect(page).toContain('teacherAccountMode === "reset_complete" ? "새 비밀번호 저장"');
        expect(page).toContain(': "대시보드 입장"');
    });
});
