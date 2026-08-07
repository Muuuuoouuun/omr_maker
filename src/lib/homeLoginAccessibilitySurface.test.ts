import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const homeSource = readFileSync(join(process.cwd(), "src/app/page.tsx"), "utf8");

describe("home login accessibility and recovery", () => {
    it("keeps authentication errors available until the user edits or resubmits", () => {
        expect(homeSource).not.toContain('setTimeout(() => setError(""),');
        expect(homeSource).toContain('const clearLoginError = () => setError("");');
        expect(homeSource).toContain('setTeacherIdentifier(e.target.value);\n                      clearLoginError();');
        expect(homeSource).toContain('setStudentName(e.target.value);\n                      clearLoginError();');
        expect(homeSource).toContain('id="student-login-feedback"');
        expect(homeSource).toContain('aria-live="polite"');
    });

    it("does not mark an unrelated teacher credential invalid", () => {
        expect(homeSource).toContain("teacherIdentifierInvalid");
        expect(homeSource).toContain("teacherPasswordInvalid");
        expect(homeSource).not.toContain('aria-invalid={Boolean(error)}');
    });

    it("keeps invalid local teacher credentials in the login feedback alert until the form changes", () => {
        const teacherLogin = homeSource.slice(
            homeSource.indexOf("const handleTeacherLogin = async () =>"),
            homeSource.indexOf("const handleMockupLogin"),
        );
        const teacherFeedback = homeSource.slice(
            homeSource.indexOf('id="teacher-login-feedback"'),
            homeSource.indexOf("</form>", homeSource.indexOf('id="teacher-login-feedback"')),
        );

        expect(teacherLogin).toContain('setError(res.error || "잘못된 비밀번호입니다.");');
        expect(teacherFeedback).toContain('id="teacher-login-feedback"');
        expect(teacherFeedback).toContain("{error ? (");
        expect(teacherFeedback).toContain('<p role="alert"');
        expect(homeSource).not.toContain('setTimeout(() => setError(""),');
    });

    it("uses a native student account form and explicitly associated labels", () => {
        expect(homeSource).toContain('className="student-account-login-form"');
        expect(homeSource).toContain('onSubmit={(event) => {');
        expect(homeSource).toContain('htmlFor="student-name"');
        expect(homeSource).toContain('htmlFor="student-lookup"');
        expect(homeSource).toContain('htmlFor="student-group"');
        expect(homeSource).toContain('htmlFor="student-start-code"');
        expect(homeSource).toContain('type="submit"');
    });

    it("requires explicit consent before retaining a student identity on the device", () => {
        expect(homeSource).toContain("rememberStudentOnDevice");
        expect(homeSource).toContain("이 기기에서 로그인 유지");
        expect(homeSource).toContain("공용 기기에서는 선택하지 마세요");
        expect(homeSource).toContain("saveSession(session, { rememberDevice: rememberStudentOnDevice })");
    });

    it("preserves the requested student workspace when returning to roles but clears it for explicit home navigation", () => {
        const handleBack = homeSource.slice(
            homeSource.indexOf("const handleBack = () => {"),
            homeSource.indexOf("const handleHomeNavigation"),
        );
        const handleHomeNavigation = homeSource.slice(
            homeSource.indexOf("const handleHomeNavigation"),
            homeSource.indexOf("return (", homeSource.indexOf("const handleHomeNavigation")),
        );

        expect(handleBack).not.toContain("setWorkspaceId(");
        expect(handleBack).not.toContain("setStudentDirectoryStatus(");
        expect(handleHomeNavigation).toContain('setWorkspaceId("");');
        expect(handleHomeNavigation).toContain('setStudentDirectoryStatus("local");');
    });
});
