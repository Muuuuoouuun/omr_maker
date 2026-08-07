import { afterEach, describe, expect, it, vi } from "vitest";
import {
    SUBMISSION_DELAY_NOTICE_MS,
    runSubmissionWithConfirmationRetry,
    submissionCompletionNotice,
    submissionProgressCopy,
    withSubmissionTimeout,
} from "./submissionProgress";

afterEach(() => vi.useRealTimers());

describe("submission progress", () => {
    it("explains that the initial wait includes server grading and saving", () => {
        expect(submissionProgressCopy("submitting", false)).toEqual({
            title: "답안을 제출하고 있습니다",
            detail: "서버에서 채점하고 결과를 안전하게 저장하는 중입니다.",
        });
    });

    it("reassures students when a submission takes longer than usual", () => {
        expect(SUBMISSION_DELAY_NOTICE_MS).toBe(8_000);
        expect(submissionProgressCopy("submitting", true)).toEqual({
            title: "제출 처리가 평소보다 오래 걸리고 있습니다",
            detail: "서버 응답을 기다리는 중입니다. 창을 닫지 마세요. 답안 임시저장은 이 기기에 유지됩니다.",
        });
    });

    it("separates post-grading handwriting upload from opening the review", () => {
        expect(submissionProgressCopy("saving_handwriting", false).title).toBe("채점 완료 · 필기 저장 중");
        expect(submissionProgressCopy("opening_review", false)).toEqual({
            title: "제출이 완료되었습니다",
            detail: "채점 결과 화면을 여는 중입니다.",
        });
    });

    it("describes an uncertain submission as confirmation-required, not cancelled", () => {
        expect(submissionProgressCopy("confirmation_required", false)).toEqual({
            title: "제출 상태 확인이 필요합니다",
            detail: "응답 시간은 초과했지만 서버 처리는 완료됐을 수 있습니다. 답안은 잠겨 있으며 같은 답안으로 상태를 확인해야 합니다.",
        });
    });

    it("shows durable queued and fail-closed blocked submission states", () => {
        expect(submissionProgressCopy("queued", false)).toEqual({
            title: "제출 재시도 대기",
            detail: "동일한 답안을 이 기기에 안전하게 보관했습니다. 온라인으로 돌아오면 자동으로 다시 시도합니다.",
        });
        expect(submissionProgressCopy("blocked", false)).toEqual({
            title: "제출 확인 필요",
            detail: "다른 기기 상태 또는 응시 세션을 확인해야 합니다. 자동으로 세션을 가져오지 않으며 직접 다시 시도할 수 있습니다.",
        });
    });

    it("releases a submission that never receives a server response", async () => {
        vi.useFakeTimers();
        const pendingForever = new Promise<never>(() => undefined);
        const timedOperation = withSubmissionTimeout(pendingForever, 50);
        const assertion = expect(timedOperation).rejects.toMatchObject({
            name: "SubmissionTimeoutError",
        });

        await vi.advanceTimersByTimeAsync(50);
        await assertion;
    });

    it("combines automatic-submit and device-cache failures in one honest notice", () => {
        expect(submissionCompletionNotice({
            autoSubmitted: true,
            handwritingUploadFailed: false,
            deviceCacheFailed: true,
        })).toEqual({
            title: "시간 종료 · 서버 제출 완료",
            detail: "답안은 자동 제출되어 공식 저장됐지만 이 기기의 결과 캐시는 저장하지 못했습니다. 결과 화면은 서버 기록으로 엽니다.",
        });
    });

    it("reports both handwriting-upload and device-cache failures after official confirmation", () => {
        expect(submissionCompletionNotice({
            autoSubmitted: false,
            handwritingUploadFailed: true,
            deviceCacheFailed: true,
        })).toEqual({
            title: "답안 제출 완료 · 기기 저장 주의",
            detail: "공식 답안은 저장됐지만 필기 업로드와 이 기기의 결과 캐시 저장에 실패했습니다. 필기 임시저장은 유지됩니다.",
        });
    });

    it("waits for explicit confirmation and retries the same operation after timeout", async () => {
        vi.useFakeTimers();
        let confirm: (() => void) | undefined;
        const waitForConfirmation = vi.fn(() => new Promise<void>(resolve => { confirm = resolve; }));
        const operation = vi.fn()
            .mockImplementationOnce(() => new Promise<never>(() => undefined))
            .mockResolvedValueOnce("confirmed");

        const result = runSubmissionWithConfirmationRetry(operation, waitForConfirmation, 50);
        await vi.advanceTimersByTimeAsync(50);
        expect(waitForConfirmation).toHaveBeenCalledOnce();
        expect(operation).toHaveBeenCalledOnce();

        confirm?.();
        await expect(result).resolves.toBe("confirmed");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("treats the first thrown transport failure as ambiguous and waits for confirmation", async () => {
        let confirm: (() => void) | undefined;
        const waitForConfirmation = vi.fn(() => new Promise<void>(resolve => { confirm = resolve; }));
        const operation = vi.fn()
            .mockRejectedValueOnce(new Error("connection reset after dispatch"))
            .mockResolvedValueOnce("confirmed");

        const result = runSubmissionWithConfirmationRetry(operation, waitForConfirmation, 50);
        await vi.waitFor(() => expect(waitForConfirmation).toHaveBeenCalledOnce());
        expect(operation).toHaveBeenCalledOnce();

        confirm?.();
        await expect(result).resolves.toBe("confirmed");
        expect(operation).toHaveBeenCalledTimes(2);
    });

    it("keeps a repeated replay transport failure locked behind another explicit confirmation", async () => {
        const confirmations: Array<() => void> = [];
        const waitForConfirmation = vi.fn(() => new Promise<void>(resolve => { confirmations.push(resolve); }));
        const operation = vi.fn()
            .mockRejectedValueOnce(new Error("first transport failure"))
            .mockRejectedValueOnce(new Error("confirmed replay failed"))
            .mockResolvedValueOnce("confirmed");

        const result = runSubmissionWithConfirmationRetry(operation, waitForConfirmation, 50);
        await vi.waitFor(() => expect(waitForConfirmation).toHaveBeenCalledOnce());
        confirmations[0]?.();
        await vi.waitFor(() => expect(waitForConfirmation).toHaveBeenCalledTimes(2));

        expect(operation).toHaveBeenCalledTimes(2);
        confirmations[1]?.();
        await expect(result).resolves.toBe("confirmed");
        expect(operation).toHaveBeenCalledTimes(3);
    });
});
