import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("guest recovery security boundary", () => {
    it("has no canonical endpoint that accepts a client local attempt, exam, payload, answers, or time", () => {
        const examAction = source("src/app/actions/studentExam.ts");
        expect(examAction).not.toContain("reconcileGuestAttempts");
        expect(examAction).not.toContain("GuestAttemptReconcileItem");
        expect(examAction).not.toContain("studentGuestReconcileGateway");
        expect(examAction).not.toContain("studentGuestClaimCapability");
    });

    it("keeps login successful when DB claim retry fails or local pending is too large/unverifiable", () => {
        const sessionAction = source("src/app/actions/studentSession.ts");
        expect(sessionAction).toContain("createSignedGuestClaimOwnerProof");
        expect(sessionAction).toContain("GUEST_CLAIM_OWNER_COOKIE");
        expect(sessionAction).not.toContain("GUEST_CLAIM_CAPABILITY_MAX_ATTEMPTS");
        expect(sessionAction).not.toContain('error: "게스트 기록을 서버에 연결하지 못했습니다. 다시 시도해주세요."');
        expect(sessionAction.indexOf("setGuestClaimOwnerCookie"))
            .toBeLessThan(sessionAction.indexOf("setSessionCookie({", sessionAction.indexOf("setGuestClaimOwnerCookie")));
    });

    it("exposes unverified recovery, export, retry, and explicit discard on dashboard and history", () => {
        for (const path of [
            "src/app/student/dashboard/page.tsx",
            "src/app/student/history/page.tsx",
        ]) {
            expect(source(path)).toContain("<StudentGuestRecoveryPanel");
        }
        const panel = source("src/components/StudentGuestRecoveryPanel.tsx");
        expect(panel).toContain("미검증 로컬 기록 복구");
        expect(panel).toContain("복구 파일 내보내기");
        expect(panel).toContain("서버 소유 기록 다시 확인");
        expect(panel).toContain("로컬 기록 폐기");
        expect(panel).toContain("retryGuestServerClaims");
    });

    it("never treats unverified local records as canonical or pairs one id with a client exam", () => {
        const home = source("src/app/page.tsx");
        expect(home).not.toContain("guestAttemptToReconcileItem");
        expect(home).not.toContain("await reconcileGuestAttempts");
        expect(home).not.toContain("guestReconciliationComplete");
        expect(home).toContain("acknowledgedAttemptIds");
        expect(home).toContain("미검증 로컬 기록");
    });
});
