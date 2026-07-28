import type { SubmitAttemptInput } from "@/lib/studentExamCore";
import {
    persistSubmissionReceipt,
    queuePendingSubmissionReceipt,
    type SubmissionReceiptStatus,
} from "@/lib/studentAttemptReceipt";

export interface StudentSubmissionDisposition {
    attemptId: string;
    receiptStatus: SubmissionReceiptStatus;
    input: SubmitAttemptInput;
    requiresPin?: boolean;
}

export type StudentSubmissionDurabilityResult =
    | { durable: true }
    | { durable: false; error: string };

const STORAGE_ERROR = "제출 재시도 정보를 저장하지 못했습니다. 브라우저 저장 공간을 확보한 뒤 다시 제출해주세요.";

export async function persistStudentSubmissionDisposition(
    disposition: StudentSubmissionDisposition,
): Promise<StudentSubmissionDurabilityResult> {
    const updatedAt = new Date().toISOString();
    const durable = disposition.receiptStatus === "pending"
        ? await queuePendingSubmissionReceipt({
            attemptId: disposition.attemptId,
            input: disposition.input,
            ...(disposition.requiresPin ? { requiresPin: true } : {}),
        }, updatedAt)
        : await persistSubmissionReceipt({
            attemptId: disposition.attemptId,
            status: disposition.receiptStatus,
            updatedAt,
        });
    return durable ? { durable: true } : { durable: false, error: STORAGE_ERROR };
}
