export const SUBMISSION_DELAY_NOTICE_MS = 8_000;
export const SUBMISSION_REQUEST_TIMEOUT_MS = 20_000;

export class SubmissionTimeoutError extends Error {
    constructor() {
        super("Submission request timed out");
        this.name = "SubmissionTimeoutError";
    }
}

export async function withSubmissionTimeout<T>(
    operation: Promise<T>,
    timeoutMs = SUBMISSION_REQUEST_TIMEOUT_MS,
): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new SubmissionTimeoutError()), timeoutMs);
    });

    try {
        return await Promise.race([operation, timeout]);
    } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
}

export async function runSubmissionWithConfirmationRetry<T>(
    operation: () => Promise<T>,
    waitForConfirmation: () => Promise<void>,
    timeoutMs = SUBMISSION_REQUEST_TIMEOUT_MS,
): Promise<T> {
    while (true) {
        try {
            return await withSubmissionTimeout(operation(), timeoutMs);
        } catch {
            await waitForConfirmation();
        }
    }
}

export type SubmitProgressPhase = "submitting" | "confirmation_required" | "saving_handwriting" | "opening_review";

interface SubmissionProgressCopy {
    title: string;
    detail: string;
}

interface SubmissionCompletionState {
    autoSubmitted: boolean;
    handwritingUploadFailed: boolean;
    deviceCacheFailed: boolean;
}

export function submissionCompletionNotice(
    state: SubmissionCompletionState,
): SubmissionProgressCopy | null {
    if (state.autoSubmitted && state.handwritingUploadFailed && state.deviceCacheFailed) {
        return {
            title: "시간 종료 · 서버 제출 완료",
            detail: "답안은 자동 제출되어 공식 저장됐지만 필기 업로드와 이 기기의 결과 캐시 저장에 실패했습니다. 필기 임시저장은 유지됩니다.",
        };
    }
    if (state.handwritingUploadFailed && state.deviceCacheFailed) {
        return {
            title: "답안 제출 완료 · 기기 저장 주의",
            detail: "공식 답안은 저장됐지만 필기 업로드와 이 기기의 결과 캐시 저장에 실패했습니다. 필기 임시저장은 유지됩니다.",
        };
    }
    if (state.autoSubmitted && state.handwritingUploadFailed) {
        return {
            title: "시간 종료 · 서버 제출 완료",
            detail: "답안은 자동 제출되어 공식 저장됐지만 필기 업로드에 실패했습니다. 필기 임시저장은 유지됩니다.",
        };
    }
    if (state.handwritingUploadFailed) {
        return {
            title: "답안 제출 완료 · 필기 재시도 필요",
            detail: "답안은 공식 저장됐지만 필기 업로드가 실패했습니다. 이 기기의 임시저장은 유지됩니다.",
        };
    }
    if (state.autoSubmitted && state.deviceCacheFailed) {
        return {
            title: "시간 종료 · 서버 제출 완료",
            detail: "답안은 자동 제출되어 공식 저장됐지만 이 기기의 결과 캐시는 저장하지 못했습니다. 결과 화면은 서버 기록으로 엽니다.",
        };
    }
    if (state.deviceCacheFailed) {
        return {
            title: "서버 제출 완료 · 기기 저장 주의",
            detail: "공식 답안은 저장됐지만 이 기기의 결과 캐시를 저장하지 못했습니다. 결과 화면은 서버 기록으로 엽니다.",
        };
    }
    if (state.autoSubmitted) {
        return {
            title: "시간 종료",
            detail: "답안이 자동으로 제출되었습니다.",
        };
    }
    return null;
}

export function submissionProgressCopy(
    phase: SubmitProgressPhase,
    delayed: boolean,
): SubmissionProgressCopy {
    if (phase === "confirmation_required") {
        return {
            title: "제출 상태 확인이 필요합니다",
            detail: "응답 시간은 초과했지만 서버 처리는 완료됐을 수 있습니다. 답안은 잠겨 있으며 같은 답안으로 상태를 확인해야 합니다.",
        };
    }
    if (phase === "saving_handwriting") {
        return {
            title: "채점 완료 · 필기 저장 중",
            detail: "공식 답안은 저장되었습니다. 필기 원본을 안전하게 보관하는 중입니다.",
        };
    }
    if (phase === "opening_review") {
        return {
            title: "제출이 완료되었습니다",
            detail: "채점 결과 화면을 여는 중입니다.",
        };
    }
    if (delayed) {
        return {
            title: "제출 처리가 평소보다 오래 걸리고 있습니다",
            detail: "서버 응답을 기다리는 중입니다. 창을 닫지 마세요. 답안 임시저장은 이 기기에 유지됩니다.",
        };
    }
    return {
        title: "답안을 제출하고 있습니다",
        detail: "서버에서 채점하고 결과를 안전하게 저장하는 중입니다.",
    };
}
