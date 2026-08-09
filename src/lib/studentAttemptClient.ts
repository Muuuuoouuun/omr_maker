import {
    listStudentCanonicalAttempts,
    loadStudentCanonicalAttempt,
} from "@/app/actions/studentAttempts";
import {
    attemptFromStudentAttemptRecord,
    examFromStudentAttemptReviewExam,
    studentTrustedOfficialReviewFromUnknown,
    type StudentTrustedOfficialReview,
} from "@/lib/studentAttemptHistoryContract";
import {
    readLocalAttempts,
    readLocalExams,
    saveLocalAttempt,
    withLocalServerConfirmation,
    saveLocalExam,
} from "@/lib/omrPersistence";
import { attemptBelongsToSession, type StudentSession } from "@/utils/storage";
import type { Attempt, Exam } from "@/types/omr";
import { INITIAL_CAPACITY_EXCEEDED_ERROR } from "@/lib/initialOperationsPolicy";

type StudentAttemptDetailSource = "server" | "local";

export interface StudentAttemptClientListResult {
    items: Attempt[];
    remoteLoaded: boolean;
    remoteStatus?: "unauthorized" | "service_unavailable";
    remoteError?: string;
}

export interface StudentAttemptClientDetail {
    attempt: Attempt;
    exam: Exam;
    source: StudentAttemptDetailSource;
    retakeEligibleQuestionIds?: number[];
    trustedReview?: StudentTrustedOfficialReview;
}

export function safeExamStubFromStudentAttempt(attempt: Attempt): Exam {
    return {
        id: attempt.examId,
        title: attempt.examTitle,
        createdAt: attempt.startedAt,
        questions: (attempt.questionResults || []).map(result => ({
            id: result.questionId,
            number: result.questionNumber,
        })),
    };
}

function localAttemptsForSession(session: StudentSession): Attempt[] {
    return readLocalAttempts().filter(attempt => attemptBelongsToSession(attempt, session));
}

function localAttemptDetail(attemptId: string, session: StudentSession): StudentAttemptClientDetail | null {
    const attempt = localAttemptsForSession(session).find(candidate => candidate.id === attemptId);
    if (!attempt) return null;
    const exam = readLocalExams().find(candidate => candidate.id === attempt.examId);
    return exam ? { attempt, exam, source: "local" } : null;
}

function withLocalStudentArtifacts(attempt: Attempt, session: StudentSession): Attempt {
    const local = localAttemptsForSession(session).find(candidate => candidate.id === attempt.id);
    if (!local) return attempt;
    return {
        ...attempt,
        drawings: local.drawings,
        drawingsRef: local.drawingsRef,
        handwriting: local.handwriting,
        handwritingArchived: local.handwritingArchived,
        handwritingPlan: local.handwritingPlan,
        drawingPageCount: local.drawingPageCount,
        drawingStrokeCount: local.drawingStrokeCount,
        questionDrawings: local.questionDrawings,
    };
}

export async function loadStudentOfficialAttempts(
    session: StudentSession,
): Promise<StudentAttemptClientListResult> {
    if (session.isGuest) {
        return { items: localAttemptsForSession(session), remoteLoaded: false };
    }

    const result = await listStudentCanonicalAttempts();
    if (result.status === "loaded") {
        const attempts = result.attempts.map(record => withLocalServerConfirmation(
            withLocalStudentArtifacts(attemptFromStudentAttemptRecord(record), session),
        ));
        return { items: attempts, remoteLoaded: true };
    }
    if (result.status === "local_only") {
        return { items: localAttemptsForSession(session), remoteLoaded: false };
    }
    return {
        items: [],
        remoteLoaded: false,
        remoteStatus: result.status,
        remoteError: result.status === "unauthorized"
            ? "Student server session is missing"
            : result.error === INITIAL_CAPACITY_EXCEEDED_ERROR
                ? INITIAL_CAPACITY_EXCEEDED_ERROR
                : result.error || "Official student attempts unavailable",
    };
}

export async function loadStudentOfficialAttempt(
    attemptId: string,
    session: StudentSession,
): Promise<StudentAttemptClientDetail | null> {
    if (session.isGuest) return localAttemptDetail(attemptId, session);

    const result = await loadStudentCanonicalAttempt(attemptId);
    if (result.status === "loaded") {
        const trustedReview = studentTrustedOfficialReviewFromUnknown(result.detail.trustedReview);
        const attempt = withLocalServerConfirmation(withLocalStudentArtifacts(
            attemptFromStudentAttemptRecord(result.detail.attempt),
            session,
        ));
        const exam = examFromStudentAttemptReviewExam(result.detail.exam);
        try {
            await saveLocalAttempt(attempt);
            saveLocalExam(exam);
        } catch {
            // The signed owner detail remains authoritative even when the
            // optional device cache is unavailable.
        }
        return {
            attempt,
            exam,
            source: "server",
            ...(result.detail.retakeEligibleQuestionIds
                ? { retakeEligibleQuestionIds: [...result.detail.retakeEligibleQuestionIds] }
                : {}),
            ...(trustedReview
                ? { trustedReview }
                : {}),
        };
    }
    if (result.status === "local_only") return localAttemptDetail(attemptId, session);
    return null;
}
