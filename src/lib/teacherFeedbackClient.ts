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
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical feedback gateway unavailable",
    };
}

export async function returnTeacherAttemptFeedback(feedbackId: string): Promise<PersistenceResult> {
    const result = await returnTeacherCanonicalFeedback(feedbackId);
    if (result.status === "returned") {
        const cached = await cacheFeedbackEnvelope(result.item);
        return { localSaved: !!cached, remoteSaved: true };
    }
    if (result.status === "local_only") return returnLegacyAttemptFeedback(feedbackId);
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical feedback gateway unavailable",
    };
}
