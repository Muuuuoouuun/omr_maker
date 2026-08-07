import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const cardSource = () => readFileSync("src/components/student/HandwritingUploadRecoveryCard.tsx", "utf8");
const reviewSource = () => readFileSync("src/app/student/review/[attemptId]/page.tsx", "utf8");
const globalCss = () => readFileSync("src/app/globals.css", "utf8");
const remoteAssetAction = () => readFileSync("src/app/actions/remoteAssets.ts", "utf8");
const flusherSource = () => readFileSync("src/components/SyncFlusher.tsx", "utf8");

describe("student handwriting upload recovery surface", () => {
    it("mounts recovery for the exact review attempt and reloads authoritative data after success", () => {
        const review = reviewSource();

        expect(review).toContain('import HandwritingUploadRecoveryCard from "@/components/student/HandwritingUploadRecoveryCard"');
        expect(review).toContain("<HandwritingUploadRecoveryCard");
        expect(review).toContain("attemptId={attempt.id}");
        expect(review).toContain("examId={attempt.examId || exam?.id || \"\"}");
        expect(review).toContain("onRecovered={() => setReloadKey(value => value + 1)}");
    });

    it("restores only the signed-in owner manifest and has no unused client ticket input", () => {
        const card = cardSource();
        const action = remoteAssetAction();

        expect(card).toContain("fingerprintHandwritingUploadOwner({");
        expect(card).toContain("readHandwritingUploadRecovery(window.localStorage");
        expect(card).toContain("getSession()");
        expect(card).toContain("STUDENT_SESSION_CHANGED_EVENT");
        expect(card).toContain("sessionId: manifest.sessionId");
        expect(card).not.toMatch(/ticket:|signedUrl|studentName|answers:/);
        const actionStart = action.indexOf("export async function uploadStudentAttemptHandwriting(input:");
        const actionBody = action.slice(actionStart, action.indexOf("): Promise<", actionStart));
        expect(actionBody).not.toContain("ticket:");
    });

    it("exposes explicit pending, waiting, uploading, success, and failure states", () => {
        const card = cardSource();

        expect(card).toContain('type RecoveryViewState = "loading" | "pending" | "waiting" | "uploading" | "succeeded" | "failed"');
        expect(card).toContain('aria-live="polite"');
        expect(card).toContain("필기 업로드 다시 시도");
        expect(card).toContain("재시도 대기 중");
        expect(card).toContain("필기 업로드 중");
        expect(card).toContain("필기 저장 완료");
        expect(card).toContain("필기 업로드 실패");
        expect(card).toContain("disabled={state === \"waiting\" || state === \"uploading\"}");
        expect(card).toContain("runHandwritingUploadRecovery(manifest.attemptId");
    });

    it("cleans expired manifests globally and removes source data when manifest persistence fails", () => {
        const solve = readFileSync("src/app/solve/[id]/page.tsx", "utf8");
        const flusher = flusherSource();

        expect(solve.indexOf("persistHandwritingUploadRecovery(window.localStorage"))
            .toBeLessThan(solve.indexOf("withSubmissionTimeout(saveJsonRecord(sourceKey, activeDrawings))"));
        expect(flusher).toContain("maintainHandwritingUploadRecovery(window.localStorage");
        expect(flusher).toContain("isHandwritingUploadRecoveryStorageKey(event.key)");
    });

    it("keeps the recovery action touch-safe and readable on phone and tablet layouts", () => {
        const css = globalCss();

        expect(css).toContain(".student-handwriting-recovery");
        expect(css).toContain("min-height: 44px");
        expect(css).toContain("overflow-wrap: anywhere");
        expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*\.student-handwriting-recovery-actions/);
        expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*\.student-handwriting-recovery-button/);
    });
});
