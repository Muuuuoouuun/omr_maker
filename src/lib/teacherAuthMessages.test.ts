import { describe, expect, it } from "vitest";
import {
    TEACHER_AUTH_DEPLOYMENT_HELP,
    TEACHER_AUTH_ERROR,
    shouldShowTeacherDeploymentHelp,
} from "./teacherAuthMessages";

describe("teacher auth messages", () => {
    it("keeps the public failure generic while giving deployment operators a safe hint", () => {
        expect(TEACHER_AUTH_ERROR).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
        expect(TEACHER_AUTH_DEPLOYMENT_HELP).toContain("Supabase가 아니라");
        expect(TEACHER_AUTH_DEPLOYMENT_HELP).toContain("TEACHER_ACCOUNTS");
        expect(TEACHER_AUTH_DEPLOYMENT_HELP).toContain("TEACHER_LOGIN_ID/TEACHER_PASSWORD");
    });

    it("only shows the deployment hint for credential failures", () => {
        expect(shouldShowTeacherDeploymentHelp(TEACHER_AUTH_ERROR)).toBe(true);
        expect(shouldShowTeacherDeploymentHelp("아이디와 비밀번호를 모두 입력해주세요.")).toBe(false);
        expect(shouldShowTeacherDeploymentHelp(undefined)).toBe(false);
    });
});
