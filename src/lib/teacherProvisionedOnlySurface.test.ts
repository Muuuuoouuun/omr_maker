import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("provisioned-only teacher identity surface", () => {
    it("passes the server-resolved mode through a fail-closed client context", () => {
        const layout = source("src/app/layout.tsx");
        const provider = source("src/components/TeacherIdentityModeProvider.tsx");

        expect(layout).toContain('import { resolveTeacherIdentityMode } from "@/lib/teacherIdentityMode.server";');
        expect(layout).toContain("const teacherIdentityMode = resolveTeacherIdentityMode();");
        expect(layout).toContain("<TeacherIdentityModeProvider mode={teacherIdentityMode}>");
        expect(provider).toContain('createContext<TeacherIdentityMode>("provisioned_only")');
        expect(layout + provider).not.toContain("NEXT_PUBLIC");
        expect(provider).not.toMatch(/localStorage|sessionStorage|URLSearchParams/);
    });

    it("renders login and operator recovery guidance without provisioned-only lifecycle controls", () => {
        const page = source("src/app/page.tsx");

        expect(page).toContain("const teacherSelfServiceEnabled = teacherIdentityMode === \"self_service\";");
        expect(page).toContain('const visibleTeacherAccountMode = teacherSelfServiceEnabled ? teacherAccountMode : "login";');
        expect(page).toContain("운영자에게 계정 또는 비밀번호 재발급을 요청해주세요");
        expect(page).toContain("{teacherSelfServiceEnabled ? (");
        expect(page).toContain("교사 계정 만들기");
        expect(page).toContain("비밀번호 재설정");
        expect(page).toContain("requestTeacherSignup");
        expect(page).toContain("requestTeacherPasswordReset");
    });

    it("does not let reset or verification query parameters enter self-service in provisioned-only mode", () => {
        const page = source("src/app/page.tsx");
        const layout = source("src/app/layout.tsx");
        const queryLifecycle = page.slice(
            page.indexOf('const resetToken = query.get("teacherResetToken")'),
            page.indexOf('const requestedExam = query.get("exam")'),
        );

        expect(queryLifecycle).toContain("if (teacherSelfServiceEnabled && resetToken)");
        expect(queryLifecycle).toContain("else if (teacherSelfServiceEnabled && verifyToken)");
        expect(queryLifecycle).toContain("setTeacherLegacyLinkBlocked(true)");
        expect(queryLifecycle).toContain("scrubTeacherLifecycleQuery(query)");
        expect(page).toContain("현재 운영 모드에서는 이 링크를 사용할 수 없습니다.");
        expect(layout).toContain('teacherIdentityMode === "provisioned_only"');
        expect(layout).toContain("window.location.replace");
        expect(layout).toContain("teacherRecovery");
        expect(page).not.toMatch(/NEXT_PUBLIC_OMR_TEACHER_IDENTITY_MODE/);
    });

    it("makes canonical operator recovery dominate student and exam handoffs", () => {
        const page = source("src/app/page.tsx");
        const queryEffect = page.slice(
            page.indexOf("const query = new URLSearchParams(window.location.search)"),
            page.indexOf("}, [router, teacherSelfServiceEnabled])"),
        );

        expect(queryEffect).toContain('query.get("teacherRecovery") === "legacy_link"');
        expect(queryEffect).toContain("!teacherOperatorRecovery && requestedInvite && requestedExam");
        expect(queryEffect).toContain('!teacherOperatorRecovery && requestedRole === "student"');
    });

    it("rebuilds provisioned recovery URLs from a strict shared allowlist", () => {
        const layout = source("src/app/layout.tsx");
        const page = source("src/app/page.tsx");
        const provisionedRedirect = page.slice(
            page.indexOf("function redirectToCanonicalTeacherRecovery"),
            page.indexOf("export default function Home"),
        );

        expect(layout).toContain("TEACHER_RECOVERY_SAFE_NEXT_PATHS");
        expect(layout).toContain("var canonicalSearch = new URLSearchParams();");
        expect(layout).toContain("url.searchParams.getAll('next')");
        expect(layout).not.toContain("url.searchParams.delete('teacherResetToken')");
        expect(layout).not.toContain("+ url.hash");
        expect(page).toContain("buildTeacherRecoveryCanonicalUrl(new URL(window.location.href))");
        expect(provisionedRedirect).not.toContain("new URLSearchParams(query)");
    });

    it("stores or uses valid self-service tokens before scrubbing them from the address bar", () => {
        const page = source("src/app/page.tsx");
        const queryLifecycle = page.slice(
            page.indexOf('const resetToken = query.get("teacherResetToken")'),
            page.indexOf('const requestedExam = query.get("exam")'),
        );
        const scrub = queryLifecycle.indexOf("scrubTeacherLifecycleQuery(query)");

        expect(queryLifecycle.indexOf("setTeacherResetToken(resetToken)")).toBeLessThan(scrub);
        expect(queryLifecycle.indexOf("confirmTeacherSignupEmail(verifyToken)")).toBeLessThan(scrub);
        expect(queryLifecycle).toContain("!teacherSelfServiceEnabled && hasTeacherLifecycleQuery");
    });
});
