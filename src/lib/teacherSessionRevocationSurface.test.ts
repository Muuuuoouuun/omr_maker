import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

const protectedTeacherBoundaries = [
    "src/app/actions/feedback.ts",
    "src/app/actions/kakaoReview.ts",
    "src/app/actions/premiumAccess.ts",
    "src/app/actions/remoteAssets.ts",
    "src/app/actions/studentAuth.ts",
    "src/app/actions/teacherAttempts.ts",
    "src/app/actions/teacherExam.ts",
    "src/app/actions/teacherNotifications.ts",
    "src/app/actions/teacherRoster.ts",
    "src/app/create/layout.tsx",
    "src/app/teacher/layout.tsx",
] as const;

describe("teacher session revocation server surface", () => {
    it.each(protectedTeacherBoundaries)("validates account generation at %s", path => {
        const contents = source(path);
        expect(contents).toContain("resolveAuthorizedTeacherSessionCookie");
        expect(contents).not.toContain("parseSignedTeacherSessionCookie");
    });

    it("validates account generation before deployment readiness access", () => {
        const authAction = source("src/app/actions/auth.ts");
        const readinessStart = authAction.indexOf("export async function getTeacherDeploymentReadiness");
        const readinessAction = authAction.slice(readinessStart);

        expect(readinessAction).toContain("resolveAuthorizedTeacherSessionCookie");
        expect(readinessAction).not.toContain("parseSignedTeacherSessionCookie");
    });

    it("mints database login cookies with the lookup generation and explicit account authority", () => {
        const authAction = source("src/app/actions/auth.ts");
        expect(authAction).toContain("accountSessionGeneration: account.sessionGeneration");
        expect(authAction).toContain('sessionAuthority: result.accountSessionGeneration ? "account" : "bootstrap"');
        expect(authAction.indexOf("accountSessionGeneration: result.accountSessionGeneration"))
            .toBeLessThan(authAction.indexOf("cookieStore.set(TEACHER_SERVER_SESSION_COOKIE"));
    });

    it("validates account generation before AI quota or provider access", () => {
        const analyzeAction = source("src/app/actions/analyzeKey.ts");
        const requireAccess = analyzeAction.slice(
            analyzeAction.indexOf("async function requireTeacherAiAccess"),
            analyzeAction.indexOf("function buildAnswerImageParts"),
        );
        expect(requireAccess).toContain("resolveAuthorizedTeacherSessionCookie");
        expect(requireAccess.indexOf("resolveAuthorizedTeacherSessionCookie"))
            .toBeLessThan(requireAccess.indexOf("authorizeTeacherAiActionRequest"));
    });
});
