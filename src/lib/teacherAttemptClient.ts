import {
    listTeacherCanonicalAttempts,
    loadTeacherCanonicalAttempt,
    saveTeacherCanonicalAttempt,
} from "@/app/actions/teacherAttempts";
import {
    loadAttempt,
    loadAttempts,
    readLocalAttempts,
    saveLocalAttempt,
    saveLocalAttempts,
} from "@/lib/omrPersistence";
import type { Attempt } from "@/types/omr";

export async function loadTeacherAttempt(attemptId: string): Promise<Attempt | null> {
    const result = await loadTeacherCanonicalAttempt(attemptId);
    if (result.status === "loaded") {
        saveLocalAttempt(result.attempt);
        return result.attempt;
    }
    if (result.status === "local_only") return loadAttempt(attemptId);
    return null;
}

export async function loadTeacherAttempts(examId?: string) {
    const result = await listTeacherCanonicalAttempts(examId);
    if (result.status === "loaded") {
        if (examId?.trim()) {
            result.attempts.forEach(saveLocalAttempt);
        } else {
            saveLocalAttempts(result.attempts);
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

export async function saveTeacherAttempt(attempt: Attempt) {
    const result = await saveTeacherCanonicalAttempt(attempt);
    if (result.status === "saved") {
        return {
            localSaved: saveLocalAttempt(result.attempt),
            remoteSaved: true,
        };
    }
    if (result.status === "local_only") {
        return {
            localSaved: saveLocalAttempt(attempt),
            remoteSaved: false,
        };
    }
    return {
        localSaved: false,
        remoteSaved: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical attempt gateway unavailable",
    };
}
