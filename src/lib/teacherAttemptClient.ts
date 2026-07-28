import {
    answerTeacherCanonicalAttemptQuestion,
    forceFinishTeacherCanonicalAttempts,
    listTeacherCanonicalAttempts,
    loadTeacherCanonicalAttempt,
    setTeacherCanonicalSubquestionReview,
} from "@/app/actions/teacherAttempts";
import {
    loadAttempt,
    loadAttempts,
    readLocalAttempts,
    saveLocalAttempt,
    saveLocalAttempts,
} from "@/lib/omrPersistence";
import { answerStudentQuestion } from "@/lib/studentQuestions";
import type { Attempt } from "@/types/omr";

export async function loadTeacherAttempt(attemptId: string): Promise<Attempt | null> {
    const result = await loadTeacherCanonicalAttempt(attemptId);
    if (result.status === "loaded") {
        await saveLocalAttempt(result.attempt);
        return result.attempt;
    }
    if (result.status === "local_only") return loadAttempt(attemptId);
    return null;
}

export async function loadTeacherAttempts(examId?: string) {
    const result = await listTeacherCanonicalAttempts(examId);
    if (result.status === "loaded") {
        if (examId?.trim()) {
            await Promise.all(result.attempts.map(attempt => saveLocalAttempt(attempt)));
        } else {
            await saveLocalAttempts(result.attempts);
        }
        return {
            items: result.attempts,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
        };
    }
    if (result.status === "local_only") {
        const local = await loadAttempts();
        if (!examId?.trim()) return local;
        return { ...local, items: local.items.filter(attempt => attempt.examId === examId.trim()) };
    }
    const cached = readLocalAttempts();
    return {
        items: examId?.trim() ? cached.filter(attempt => attempt.examId === examId.trim()) : cached,
        remoteLoaded: false,
        remoteSynced: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical attempt gateway unavailable",
    };
}

function remoteMutationError(result: { status: string; error?: string }): string {
    if (result.status === "unauthorized") return "Teacher server session is missing";
    if (result.status === "forbidden") return "Teacher role cannot change attempts";
    if (result.status === "not_found") return "Canonical attempt was not found";
    if (result.status === "invalid_request") return "Attempt mutation was invalid";
    return result.error || "Canonical attempt gateway unavailable";
}

export async function answerTeacherAttemptQuestion(
    attempt: Attempt,
    questionId: number,
    answer: string,
    teacherName?: string,
) {
    const result = await answerTeacherCanonicalAttemptQuestion(attempt.id, questionId, answer);
    if (result.status === "saved") {
        return {
            localSaved: await saveLocalAttempt(result.attempt),
            remoteSaved: true,
            attempt: result.attempt,
        };
    }
    if (result.status === "local_only") {
        const updated = answerStudentQuestion(attempt, questionId, answer, new Date().toISOString(), teacherName);
        if (!updated) {
            return { localSaved: false, remoteSaved: false, remoteError: "Student question was not found" };
        }
        return {
            localSaved: await saveLocalAttempt(updated),
            remoteSaved: false,
            attempt: updated,
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: remoteMutationError(result),
    };
}

export async function setTeacherAttemptSubquestionReview(
    attempt: Attempt,
    questionId: number,
    subquestionId: string,
    status: "needs_review" | "reviewed",
    teacherName?: string,
) {
    const result = await setTeacherCanonicalSubquestionReview(
        attempt.id,
        questionId,
        subquestionId,
        status,
    );
    if (result.status === "saved") {
        return {
            localSaved: await saveLocalAttempt(result.attempt),
            remoteSaved: true,
            attempt: result.attempt,
        };
    }
    if (result.status === "local_only") {
        const current = attempt.subQuestionAnswers?.[questionId]?.[subquestionId];
        if (!current) {
            return { localSaved: false, remoteSaved: false, remoteError: "Subquestion answer was not found" };
        }
        const updated: Attempt = {
            ...attempt,
            subQuestionAnswers: {
                ...(attempt.subQuestionAnswers || {}),
                [questionId]: {
                    ...(attempt.subQuestionAnswers?.[questionId] || {}),
                    [subquestionId]: {
                        ...current,
                        reviewStatus: status,
                        reviewedAt: status === "reviewed" ? new Date().toISOString() : undefined,
                        reviewedBy: status === "reviewed" ? teacherName : undefined,
                    },
                },
            },
        };
        return {
            localSaved: await saveLocalAttempt(updated),
            remoteSaved: false,
            attempt: updated,
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: remoteMutationError(result),
    };
}

export async function forceFinishTeacherAttempts(
    attempts: Attempt[],
    finishedAt: string,
) {
    const result = await forceFinishTeacherCanonicalAttempts(
        attempts.map(attempt => attempt.id),
        finishedAt,
    );
    if (result.status === "saved") {
        const localResults = await Promise.all(result.attempts.map(saveLocalAttempt));
        return {
            localSaved: localResults.every(Boolean),
            remoteSaved: true,
            attempts: result.attempts,
        };
    }
    if (result.status === "local_only") {
        const completed = attempts.map(attempt => ({
            ...attempt,
            status: "completed" as const,
            finishedAt,
            autoSubmitted: true,
        }));
        const localResults = await Promise.all(completed.map(saveLocalAttempt));
        return {
            localSaved: localResults.every(Boolean),
            remoteSaved: false,
            attempts: completed,
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        attempts,
        remoteError: remoteMutationError(result),
    };
}
