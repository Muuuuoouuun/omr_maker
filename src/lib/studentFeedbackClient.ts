import {
    listStudentCanonicalFeedback,
    loadStudentCanonicalFeedback,
    markStudentCanonicalFeedbackOpened,
} from "@/app/actions/feedback";
import { cacheFeedbackEnvelope } from "@/lib/feedbackClientCache";
import {
    loadReturnedAttemptFeedbackForStudent as loadLegacyReturnedAttemptFeedbackForStudent,
    loadReturnedFeedbackForStudent as loadLegacyReturnedFeedbackForStudent,
    markFeedbackOpenedForStudent as markLegacyFeedbackOpenedForStudent,
} from "@/lib/feedbackPersistence";
import type { PersistenceResult } from "@/lib/omrPersistence";
import type { AttemptFeedback } from "@/types/omr";

export async function loadStudentReturnedFeedback(): Promise<AttemptFeedback[]> {
    const result = await listStudentCanonicalFeedback();
    if (result.status === "loaded") return Promise.all(result.items.map(cacheFeedbackEnvelope));
    return [];
}

export async function loadStudentReturnedFeedbackForAttempt(
    attemptId: string,
    studentProfileId: string,
): Promise<AttemptFeedback | null> {
    const result = await loadStudentCanonicalFeedback(attemptId);
    if (result.status === "loaded") return cacheFeedbackEnvelope(result.item);
    if (result.status === "local_only") {
        return loadLegacyReturnedAttemptFeedbackForStudent(attemptId, studentProfileId);
    }
    return null;
}

export async function markStudentFeedbackOpened(
    feedbackId: string,
    studentProfileId: string,
): Promise<PersistenceResult> {
    const result = await markStudentCanonicalFeedbackOpened(feedbackId);
    if (result.status === "opened") {
        const cached = await cacheFeedbackEnvelope(result.item);
        return { localSaved: !!cached, remoteSaved: true };
    }
    if (result.status === "local_only") {
        return markLegacyFeedbackOpenedForStudent(feedbackId, studentProfileId);
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "unauthorized"
            ? "Student server session is missing"
            : result.error || "Canonical feedback gateway unavailable",
    };
}

export async function loadStudentReturnedFeedbackWithDevFallback(
    studentProfileId: string,
): Promise<AttemptFeedback[]> {
    const result = await listStudentCanonicalFeedback();
    if (result.status === "loaded") return Promise.all(result.items.map(cacheFeedbackEnvelope));
    if (result.status === "local_only") return loadLegacyReturnedFeedbackForStudent(studentProfileId);
    return [];
}
