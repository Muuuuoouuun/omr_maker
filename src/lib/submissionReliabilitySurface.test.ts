import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const solvePage = () => readFileSync("src/app/solve/[id]/page.tsx", "utf8");

describe("solve submission reliability integration", () => {
    it("bounds both official submission paths instead of leaving the UI locked forever", () => {
        const source = solvePage();

        expect(source).toContain("runSubmissionWithConfirmationRetry(");
        expect(source).toContain("() => submitStudentAttempt(secureSubmissionPayload)");
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

        expect(source).toContain("const secureSubmissionPayload = {");
        expect(source).toContain("const submissionAnswers = { ...studentAnswersRef.current }");
        expect(source).toContain("answers: submissionAnswers");
        expect(source).toContain("subQuestionAnswers: submissionSubQuestionAnswers");
        expect(source).toContain("focusLossEvents: submissionFocusLossEvents");
        expect(source).toContain("const submissionPin = pinRef.current || undefined");
        expect(source).toContain("() => submitStudentAttempt(secureSubmissionPayload)");
        expect(source).toContain("() => submitAttemptClient(submitInput, submissionPin");
    });
});
