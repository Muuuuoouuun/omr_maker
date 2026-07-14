import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Kakao review server persistence", () => {
    it("removes browser publishable writes and enforces teacher server scope", () => {
        const persistence = source("src/lib/kakaoCandidateReviewPersistence.ts");
        const action = source("src/app/actions/kakaoReview.ts");
        expect(persistence).not.toContain("NEXT_PUBLIC_SUPABASE");
        expect(persistence).not.toContain('import("@supabase/supabase-js")');
        expect(action).toContain("TEACHER_SERVER_SESSION_COOKIE");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("workspaceContextFromTeacherSession");
        expect(action).toContain("reviewed_by_user_id: gateway.workspace.actorUserId");
        expect(action).toContain('verifyScopedRow(gateway.client, "omr_exams"');
        expect(action).toMatch(/verifyScopedRow\([\s\S]*?"omr_kakao_candidate_reviews"/);
        expect(action).toContain('canUpsertScopedId(gateway.client, "omr_kakao_candidate_reviews"');
        expect(action).toContain('canUpsertScopedId(gateway.client, "omr_kakao_dispatch_logs"');
        expect(action).toContain("{ exam_id: examId }");
        expect(action).toContain("await Promise.all([");
        expect(action).not.toContain("result.error.message } : { status: \"saved\"");
    });
});
