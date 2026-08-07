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
import { INITIAL_CAPACITY_EXCEEDED_ERROR } from "@/lib/initialOperationsPolicy";

export type StudentFeedbackListClientResult =
    | { status: "loaded"; items: AttemptFeedback[] }
    | { status: "capacity_exceeded"; items: [] }
    | { status: "unauthorized"; items: [] }
    | { status: "service_unavailable"; items: []; error: string };

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
): Promise<StudentFeedbackListClientResult> {
    const result = await listStudentCanonicalFeedback();
    if (result.status === "loaded") {
        return { status: "loaded", items: result.items.map(item => item.feedback) };
    }
    if (result.status === "local_only") {
        return { status: "loaded", items: await loadLegacyReturnedFeedbackForStudent(studentProfileId) };
    }
    if (result.error === INITIAL_CAPACITY_EXCEEDED_ERROR) {
        return { status: "capacity_exceeded", items: [] };
    }
    if (result.status === "unauthorized") {
        return { status: "unauthorized", items: [] };
    }
    return {
        status: "service_unavailable",
        items: [],
        error: result.error || "피드백 목록을 불러올 수 없습니다.",
    };
}
