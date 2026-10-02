import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("Kakao review server persistence", () => {
    it("routes writes through the atomic paid-plan gateway without direct service-role DML", () => {
        const persistence = source("src/lib/kakaoCandidateReviewPersistence.ts");
        const action = source("src/app/actions/kakaoReview.ts");
        expect(persistence).not.toContain("NEXT_PUBLIC_SUPABASE");
        expect(persistence).not.toContain('import("@supabase/supabase-js")');
        expect(action).toContain("TEACHER_SERVER_SESSION_COOKIE");
        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("workspaceContextFromTeacherSession");
        expect(action).toContain("saveKakaoCandidateReviewWithGateway");
        expect(action).toContain("saveKakaoSimulationDispatchWithGateway");
        expect(action).not.toContain(".from(");
        expect(action).not.toContain(".upsert(");
        expect(action).not.toContain("verifyScopedRow");
        expect(action).not.toContain("canUpsertScopedId");
        expect(action).toContain("현재 서버 플랜에서 카카오 리마인더를 사용할 수 없습니다.");
        expect(action).toContain("기존 카카오 리마인더 기록의 운영자 조정이 필요합니다.");
        expect(action).not.toContain("result.error.message");
    });
});
