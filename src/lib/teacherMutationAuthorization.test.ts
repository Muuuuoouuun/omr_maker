import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isTeacherMutationAuthorized } from "./teacherMutationAuthorization";

const readProjectFile = (relativePath: string): string =>
    readFileSync(path.join(process.cwd(), relativePath), "utf8");

describe("teacher mutation authorization", () => {
    it("fails closed for viewer, mockup, and missing role sessions", () => {
        expect(isTeacherMutationAuthorized({ memberRole: "viewer" })).toBe(false);
        expect(isTeacherMutationAuthorized({ memberRole: undefined })).toBe(false);
        expect(isTeacherMutationAuthorized(null)).toBe(false);
    });

    it("allows every configured editor role", () => {
        expect(isTeacherMutationAuthorized({ memberRole: "owner" })).toBe(true);
        expect(isTeacherMutationAuthorized({ memberRole: "admin" })).toBe(true);
        expect(isTeacherMutationAuthorized({ memberRole: "teacher" })).toBe(true);
        expect(isTeacherMutationAuthorized({ memberRole: "assistant" })).toBe(true);
    });

    it("guards every teacher service-role mutation surface before creating an admin client", () => {
        const actionPaths = [
            "src/app/actions/teacherRoster.ts",
            "src/app/actions/teacherExam.ts",
            "src/app/actions/feedback.ts",
            "src/app/actions/kakaoReview.ts",
            "src/app/actions/remoteAssets.ts",
        ];

        for (const actionPath of actionPaths) {
            const source = readProjectFile(actionPath);
            const authorizationIndex = source.indexOf("isTeacherMutationAuthorized(");
            const adminClientIndex = source.indexOf("createSupabaseAdminClient(config)");
            expect(authorizationIndex, actionPath).toBeGreaterThan(-1);
            expect(adminClientIndex, actionPath).toBeGreaterThan(-1);
            expect(authorizationIndex, actionPath).toBeLessThan(adminClientIndex);
        }
    });
});
