import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const solvePage = () => readFileSync("src/app/solve/[id]/page.tsx", "utf8");

describe("solve submission reliability integration", () => {
    it("bounds both official submission paths instead of leaving the UI locked forever", () => {
        const source = solvePage();

        expect(source).toContain("runSubmissionWithConfirmationRetry(");
        expect(source).toContain("queueSecureSubmission(");
        expect(source).toContain("replaySecureSubmissionsForOwner(");
        expect(source).toContain("() => submitAttemptClient(submitInput, submissionPin");
        expect(source).not.toContain("제출 응답 시간 초과");
    });

    it("bounds pre-submit handwriting persistence and leaves the draft intact on failure", () => {
        const source = solvePage();
        const handwritingStart = source.indexOf('let drawingsRef: Attempt["drawingsRef"]');
        const handwritingEnd = source.indexOf("const activeSubmitter = submitter", handwritingStart);
        const handwritingPersistence = source.slice(handwritingStart, handwritingEnd);

        expect(handwritingPersistence).toContain("withSubmissionTimeout(saveJsonRecord(");
        expect(handwritingPersistence).toContain("resetFailedSubmission();");
        expect(handwritingPersistence).not.toContain("removeItem(DRAFT_KEY)");
        expect(handwritingPersistence).not.toContain("removeItem(LEGACY_DRAFT_KEY)");
    });

    it("keeps an official server confirmation successful when only device persistence fails", () => {
        const source = solvePage();

        expect(source).toContain("shouldBlockSubmissionCompletion({");
        expect(source).toContain('source: "server"');
        expect(source).toContain('receiptStatus: "confirmed"');
        expect(source).not.toContain('toast.error(\n                        "제출 확인 저장 실패"');
    });

    it("builds one completion notice from every simultaneous post-confirmation condition", () => {
        const source = solvePage();

        expect(source).toContain("submissionCompletionNotice({");
        expect(source).toContain("handwritingUploadFailed: shouldArchiveDrawings");
        expect(source).toContain("deviceCacheFailed: !deviceConfirmationDurable");
        expect(source).toContain("deviceCacheFailed: res.source === \"server\"");
    });

    it("creates a private handwriting recovery job only after the server receipt is confirmed", () => {
        const source = solvePage();
        const submittedGuard = Math.max(
            source.indexOf('if (result.status !== "submitted")'),
            source.indexOf('result = { status: "submitted", receipt: replay.submitted[0] };'),
        );
        const sourcePersistence = source.indexOf("handwritingUploadSourceKey(result.receipt.attemptId)", submittedGuard);
        const manifestPersistence = source.indexOf("persistHandwritingUploadRecovery(window.localStorage", sourcePersistence);
        const upload = source.indexOf("runHandwritingUploadRecovery(result.receipt.attemptId", manifestPersistence);

        expect(submittedGuard).toBeGreaterThan(0);
        expect(sourcePersistence).toBeGreaterThan(submittedGuard);
        expect(manifestPersistence).toBeGreaterThan(sourcePersistence);
        expect(upload).toBeGreaterThan(manifestPersistence);
        expect(source).toContain("fingerprintHandwritingUploadOwner({");
        expect(source).toContain("deleteStoredData");
        expect(source).toContain("clearHandwritingUploadRecovery(");
        expect(source).toContain("handwritingUpload?.status === \"uploaded\"");
        expect(source).toContain("shouldDeleteHandwritingUploadRecovery(handwritingUpload.status)");
        expect(source).not.toContain('handwritingUpload.status === "invalid_ticket" || handwritingUpload.status === "invalid_asset"');
        const draftCleanup = source.indexOf('if (!shouldArchiveDrawings || handwritingUpload?.status === "uploaded")', upload);
        const reviewNavigation = source.indexOf('router.push(`/student/review/${result.receipt.attemptId}`)', draftCleanup);
        expect(draftCleanup).toBeGreaterThan(upload);
        expect(reviewNavigation).toBeGreaterThan(draftCleanup);
    });

    it("moves an official timeout into an interactive confirmation state without unlocking answers", () => {
        const source = solvePage();

        expect(source).toContain("submissionConfirmationRetryRef");
        expect(source).toContain('setSubmissionProgress("confirmation_required")');
        expect(source).toContain("runSubmissionWithConfirmationRetry(");
        expect(source).toContain("onRetry={retryUncertainSubmission}");
        expect(source).toContain("if (submittedRef.current) return;\n        const nowMs = Date.now();");
        expect(source).toContain("const handleSubQuestionAnswer = (questionId: number, subQuestionId: string, body: string, maxLength: number) => {\n        if (submittedRef.current) return;");
        expect(source).toContain("const handleDrawingsChange = (page: number, newPaths: string[]) => {\n        if (submittedRef.current) return;");
    });

    it("gives the confirmation dialog an accessible name and contains keyboard focus", () => {
        const source = solvePage();

        expect(source).toContain('aria-labelledby="solve-submission-title"');
        expect(source).toContain('<h2 id="solve-submission-title">{copy.title}</h2>');
        expect(source).toContain("confirmationDialogRef");
        expect(source).toContain('document.addEventListener("keydown", handleConfirmationKeyDown, true)');
        expect(source).toContain('document.removeEventListener("keydown", handleConfirmationKeyDown, true)');
        expect(source).toContain('event.key !== "Tab"');
    });

    it("reconciles with the immutable first-submit payload and identity", () => {
        const source = solvePage();

        expect(source).toContain("const submissionAnswers = { ...studentAnswersRef.current }");
        expect(source).toContain("answers: submissionAnswers");
        expect(source).toContain("subQuestionAnswers: submissionSubQuestionAnswers");
        expect(source).toContain("focusLossEvents: submissionFocusLossEvents");
        expect(source).toContain("const submissionPin = pinRef.current || undefined");
        expect(source).toContain("queueSecureSubmission(");
        expect(source).toContain("replaySecureSubmissionsForOwner(");
        expect(source).toContain("() => submitAttemptClient(submitInput, submissionPin");
    });

    it("persists the secure immutable submission before sending and supports manual replay", () => {
        const source = solvePage();
        const queue = source.indexOf("queueSecureSubmission(");
        const replay = source.indexOf("replaySecureSubmissionsForOwner(", queue);

        expect(queue).toBeGreaterThan(0);
        expect(replay).toBeGreaterThan(queue);
        expect(source).toContain("secureSubmissionOwnerFingerprint(");
        expect(source).toContain('setSubmissionProgress("queued")');
        expect(source).toContain('setSubmissionProgress("blocked")');
        expect(source).toContain("retryBlockedSecureSubmission(");
        expect(source).toContain("SECURE_SUBMISSION_OUTBOX_EVENT");
    });
});
