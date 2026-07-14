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

export async function loadTeacherAttempts() {
    const result = await listTeacherCanonicalAttempts();
    if (result.status === "loaded") {
        saveLocalAttempts(result.attempts);
        return {
            items: result.attempts,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
        };
    }
    if (result.status === "local_only") return loadAttempts();
    return {
        items: readLocalAttempts(),
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
