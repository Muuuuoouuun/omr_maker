import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canUseCanonicalBrowserDataPlane } from "./productionBrowserBoundary";

function source(path: string): string {
    return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("canonical browser data-plane boundary", () => {
    it("stays disabled in production when public Supabase configuration exists", () => {
        expect(canUseCanonicalBrowserDataPlane({
            nodeEnv: "production",
            hasPublicSupabase: true,
        })).toBe(false);
    });

    it("is available outside production only when public Supabase is configured", () => {
        expect(canUseCanonicalBrowserDataPlane({
            nodeEnv: "development",
            hasPublicSupabase: true,
        })).toBe(true);
        expect(canUseCanonicalBrowserDataPlane({
            nodeEnv: "test",
            hasPublicSupabase: true,
        })).toBe(true);
        expect(canUseCanonicalBrowserDataPlane({
            nodeEnv: "development",
            hasPublicSupabase: false,
        })).toBe(false);
    });

    it("guards both legacy persistence clients before constructing Supabase", () => {
        for (const path of [
            "src/lib/omrPersistence.ts",
            "src/lib/feedbackPersistence.ts",
        ]) {
            const persistence = source(path);
            expect(persistence).toContain('from "@/lib/productionBrowserBoundary"');
            const clientFactory = persistence.slice(
                persistence.indexOf("async function getSupabaseClient()"),
                persistence.indexOf("async function getAvailableSupabaseClient()"),
            );
            expect(clientFactory).toContain("canUseCanonicalBrowserDataPlane({");
            expect(clientFactory.indexOf("canUseCanonicalBrowserDataPlane({"))
                .toBeLessThan(clientFactory.indexOf('import("@supabase/supabase-js")'));
        }
    });

    it("keeps official student pages on server clients and local-only cache helpers", () => {
        const home = source("src/app/page.tsx");
        const dashboard = source("src/app/student/dashboard/page.tsx");
        const history = source("src/app/student/history/page.tsx");
        const review = source("src/app/student/review/[attemptId]/page.tsx");

        expect(dashboard).toContain("listMyAssignmentsClient({");
        expect(history).toContain("loadStudentOfficialAttempts(currentSession)");
        expect(review).toContain("flushPendingStudentQuestions(base.id, askAttemptQuestion)");

        for (const page of [home, dashboard]) {
            expect(page).not.toContain("syncMergedGuestAttempts");
        }
        expect(history).not.toContain("loadExams");
        expect(review).not.toMatch(/\bsaveAttempt\b/);
    });

    it("claims a signed guest owner before issuing the verified student cookie", () => {
        const action = source("src/app/actions/studentSession.ts");
        const home = source("src/app/page.tsx");
        const migration = source("supabase/migrations/202607280000_student_guest_claim.sql");

        expect(action).toContain("isSameOriginServerActionRequest");
        expect(action).toContain("claimSignedGuestAttempts");
        expect(action).toContain("existingGuestSession");
        expect(action.indexOf("await claimSignedGuestAttempts"))
            .toBeLessThan(action.indexOf("await setSessionCookie({", action.indexOf("await claimSignedGuestAttempts")));
        expect(home).toContain("result.guestClaim");
        expect(home).toContain("guestClaim.status === \"claimed\"");
        expect(home).toContain("acknowledgedAttemptIds");
        expect(home).toContain("await reconcileGuestAttempts");
        expect(home).toContain("if (!guestReconciliationComplete) return false");
        expect(home.indexOf("if (!guestReconciliationComplete) return false"))
            .toBeLessThan(home.indexOf("saveSession(session)"));
        expect(action).toContain("GUEST_CLAIM_CAPABILITY_COOKIE");
        expect(action).toContain("createSignedGuestClaimCapability");
        expect(migration).toContain("omr_claim_guest_attempts_v1");
        expect(migration).toContain("for update");
        expect(migration).toContain("grant execute on function public.omr_claim_guest_attempts_v1");
    });

    it("keeps failed student questions visible and retries the durable full union", () => {
        const review = source("src/app/student/review/[attemptId]/page.tsx");

        expect(review).toContain("queuePendingStudentQuestion");
        expect(review).toContain("await queuePendingStudentQuestion");
        expect(review).toContain("pendingStudentQuestionNotesById");
        expect(review).toContain("flushPendingStudentQuestions");
        expect(review).toContain("질문 전송 보류");
        expect(review).toContain("return false");

        const action = source("src/app/actions/studentExam.ts");
        const questionStart = action.indexOf("export async function askAttemptQuestion");
        const questionAction = action.slice(questionStart);
        expect(questionAction).toContain("isSameOriginServerActionRequest");
        expect(questionAction).toContain("validateStudentQuestionForAttempt");
        expect(questionAction.indexOf("isSameOriginServerActionRequest"))
            .toBeLessThan(questionAction.indexOf("resolveCtx()"));
    });
});
