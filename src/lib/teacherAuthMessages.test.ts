import { describe, expect, it } from "vitest";
import {
    TEACHER_AUTH_ACCOUNT_OPERATOR_HELP,
    TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR,
    TEACHER_AUTH_ERROR,
    TEACHER_AUTH_SESSION_CONFIG_ERROR,
    TEACHER_AUTH_SESSION_COOKIE_ERROR,
    TEACHER_AUTH_SESSION_OPERATOR_HELP,
    TEACHER_LOGIN_UNAVAILABLE_MESSAGE,
    teacherLoginHelpFor,
} from "./teacherAuthMessages";

const ENV_VAR_PATTERN = /[A-Z]{2,}_[A-Z_]+/;

describe("teacher auth messages", () => {
    it("keeps the server error codes stable", () => {
        expect(TEACHER_AUTH_ERROR).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
        expect(TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR).toBe("배포 환경에 교사 계정이 설정되어 있지 않습니다.");
        expect(TEACHER_AUTH_SESSION_CONFIG_ERROR).toContain("세션 서명키");
        expect(TEACHER_AUTH_SESSION_COOKIE_ERROR).toContain("쿠키 설정");
    });

    it("operator guidance matches the current identity-mode policy", () => {
        expect(TEACHER_AUTH_ACCOUNT_OPERATOR_HELP).toContain("OMR_TEACHER_IDENTITY_MODE=self_service");
        expect(TEACHER_AUTH_ACCOUNT_OPERATOR_HELP).toContain("TEACHER_ACCOUNTS");
        expect(TEACHER_AUTH_ACCOUNT_OPERATOR_HELP).toContain("provisioned_only");
        // Production is provisioned_only, so env accounts are not a production fix.
        expect(TEACHER_AUTH_ACCOUNT_OPERATOR_HELP).not.toContain("Supabase가 아니라");
        expect(TEACHER_AUTH_SESSION_OPERATOR_HELP).toContain("TEACHER_SESSION_SECRET");
    });

    it("never attaches configuration hints to a wrong password", () => {
        for (const production of [true, false]) {
            expect(teacherLoginHelpFor(TEACHER_AUTH_ERROR, { production })).toEqual({ message: TEACHER_AUTH_ERROR });
        }
    });

    it("shows a plain contact-your-admin message for config errors in production", () => {
        for (const error of [TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR, TEACHER_AUTH_SESSION_CONFIG_ERROR]) {
            const help = teacherLoginHelpFor(error, { production: true });
            expect(help).toEqual({ message: TEACHER_LOGIN_UNAVAILABLE_MESSAGE });
            expect(help.message).toBe("지금은 교사 로그인을 사용할 수 없습니다. 학원 관리자에게 문의해주세요.");
            expect(help.message).not.toMatch(ENV_VAR_PATTERN);
        }
    });

    it("keeps operator guidance for config errors outside production only", () => {
        expect(teacherLoginHelpFor(TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR, { production: false })).toEqual({
            message: TEACHER_AUTH_DEPLOYMENT_CONFIG_ERROR,
            operatorHelp: TEACHER_AUTH_ACCOUNT_OPERATOR_HELP,
        });
        expect(teacherLoginHelpFor(TEACHER_AUTH_SESSION_CONFIG_ERROR, { production: false })).toEqual({
            message: TEACHER_AUTH_SESSION_CONFIG_ERROR,
            operatorHelp: TEACHER_AUTH_SESSION_OPERATOR_HELP,
        });
    });

    it("passes other errors through untouched", () => {
        expect(teacherLoginHelpFor(TEACHER_AUTH_SESSION_COOKIE_ERROR, { production: true }))
            .toEqual({ message: TEACHER_AUTH_SESSION_COOKIE_ERROR });
        expect(teacherLoginHelpFor("아이디와 비밀번호를 모두 입력해주세요.", { production: false }))
            .toEqual({ message: "아이디와 비밀번호를 모두 입력해주세요." });
    });
});
