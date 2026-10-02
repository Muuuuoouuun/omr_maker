import {
    loadTeacherCanonicalFeedback,
    returnTeacherCanonicalFeedback,
    saveTeacherCanonicalFeedback,
} from "@/app/actions/feedback";
import { cacheFeedbackEnvelope } from "@/lib/feedbackClientCache";
import {
    loadAttemptFeedback as loadLegacyAttemptFeedback,
    returnAttemptFeedback as returnLegacyAttemptFeedback,
    saveAttemptFeedbackDraft as saveLegacyAttemptFeedbackDraft,
} from "@/lib/feedbackPersistence";
import type { PersistenceResult } from "@/lib/omrPersistence";
import type { AttemptFeedback, PdfDrawings } from "@/types/omr";

function feedbackConflictMessage(currentStatus?: string): string {
    if (currentStatus === "returned" || currentStatus === "archived") {
        return "이미 반환된 피드백은 유지되었습니다. 새로고침 후 서버 내용을 비교해 주세요.";
    }
    if (currentStatus === "draft") {
        return "다른 탭에서 더 최신 초안이 저장되었습니다. 새로고침 후 서버 내용을 비교해 주세요.";
    }
    return "서버의 피드백 상태가 변경되었습니다. 새로고침 후 다시 확인해 주세요.";
}

export async function loadTeacherAttemptFeedback(attemptId: string): Promise<AttemptFeedback | null> {
    const result = await loadTeacherCanonicalFeedback(attemptId);
    if (result.status === "loaded") return cacheFeedbackEnvelope(result.item);
    if (result.status === "local_only") return loadLegacyAttemptFeedback(attemptId);
    return null;
}

export async function saveTeacherAttemptFeedbackDraft(
    feedback: AttemptFeedback,
    markup?: PdfDrawings,
): Promise<PersistenceResult> {
    const result = await saveTeacherCanonicalFeedback(feedback, markup);
    if (result.status === "saved") {
        const cached = await cacheFeedbackEnvelope(result.item);
        return { localSaved: !!cached, remoteSaved: true };
    }
    if (result.status === "local_only") return saveLegacyAttemptFeedbackDraft(feedback, markup);
    if (result.status === "conflict") {
        return {
            localSaved: false,
            remoteSaved: false,
            remoteError: feedbackConflictMessage(result.currentStatus),
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical feedback gateway unavailable",
    };
}

export async function returnTeacherAttemptFeedback(feedback: AttemptFeedback): Promise<PersistenceResult> {
    const result = await returnTeacherCanonicalFeedback(feedback);
    if (result.status === "returned") {
        const cached = await cacheFeedbackEnvelope(result.item);
        return { localSaved: !!cached, remoteSaved: true };
    }
    if (result.status === "local_only") return returnLegacyAttemptFeedback(feedback.id);
    if (result.status === "conflict") {
        return {
            localSaved: false,
            remoteSaved: false,
            remoteError: feedbackConflictMessage(result.currentStatus),
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical feedback gateway unavailable",
    };
}
