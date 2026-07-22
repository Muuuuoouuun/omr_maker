export const SUBMISSION_DELAY_NOTICE_MS = 8_000;

export type SubmitProgressPhase = "submitting" | "saving_handwriting" | "opening_review";

interface SubmissionProgressCopy {
    title: string;
    detail: string;
}

export function submissionProgressCopy(
    phase: SubmitProgressPhase,
    delayed: boolean,
): SubmissionProgressCopy {
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
