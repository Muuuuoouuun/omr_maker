import {
    listStudentCanonicalAttempts,
    loadStudentCanonicalAttempt,
} from "@/app/actions/studentAttempts";
import {
    attemptFromStudentAttemptRecord,
    examFromStudentAttemptReviewExam,
} from "@/lib/studentAttemptHistoryContract";
import {
    readLocalAttempts,
    readLocalExams,
    saveLocalAttempt,
    saveLocalAttempts,
    saveLocalExam,
} from "@/lib/omrPersistence";
import { attemptBelongsToSession, type StudentSession } from "@/utils/storage";
import type { Attempt, Exam } from "@/types/omr";

export interface StudentAttemptClientListResult {
    items: Attempt[];
    remoteLoaded: boolean;
    remoteError?: string;
}

export interface StudentAttemptClientDetail {
    attempt: Attempt;
    exam: Exam;
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
    return exam ? { attempt, exam } : null;
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
        const attempts = result.attempts.map(record =>
            withLocalStudentArtifacts(attemptFromStudentAttemptRecord(record), session)
        );
        saveLocalAttempts(attempts);
        return { items: attempts, remoteLoaded: true };
    }
    if (result.status === "local_only") {
        return { items: localAttemptsForSession(session), remoteLoaded: false };
    }
    return {
        items: [],
        remoteLoaded: false,
        remoteError: result.status === "unauthorized"
            ? "Student server session is missing"
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
        const attempt = withLocalStudentArtifacts(
            attemptFromStudentAttemptRecord(result.detail.attempt),
            session,
        );
        const exam = examFromStudentAttemptReviewExam(result.detail.exam);
        saveLocalAttempt(attempt);
        saveLocalExam(exam);
        return { attempt, exam };
    }
    if (result.status === "local_only") return localAttemptDetail(attemptId, session);
    return null;
}
