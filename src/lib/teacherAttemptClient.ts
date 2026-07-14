import type { Attempt } from "@/types/omr";
import type { TeacherDataStatus } from "@/lib/teacherServerAccess";
import {
    classifyTeacherServerStatus,
    type TeacherLoadResult,
} from "@/lib/teacherExamClient";
import {
    loadAttempt as loadAttemptLegacy,
    loadAttempts as loadAttemptsLegacy,
    readLocalAttempts,
    saveAttempt as saveAttemptLegacy,
    saveLocalAttempt,
    sortByNewestActivity,
    type PersistenceResult,
} from "@/lib/omrPersistence";
import {
    listTeacherAttemptsAction,
    loadTeacherAttemptAction,
    saveTeacherAttemptAction,
} from "@/app/actions/teacherAttempts";

/**
 * Client-side wrapper over the teacher attempt server actions (B2). Same
 * server-first, fail-closed policy as the exam layer (teacherExamClient): the
 * org-scoped service-role boundary is primary; `degraded_local` keeps the
 * existing local + publishable-key path; `denied` reads/writes only the
 * on-device cache and never revives the publishable key.
 */

function mergeServerFirst(serverAttempts: Attempt[], localAttempts: Attempt[]): Attempt[] {
    const serverIds = new Set(serverAttempts.map(attempt => attempt.id));
    const localOnly = localAttempts.filter(attempt => !serverIds.has(attempt.id));
    return sortByNewestActivity([...serverAttempts, ...localOnly]);
}

export interface ListTeacherAttemptsDeps {
    server: () => Promise<{ status: string; attempts?: Attempt[] }>;
    readLocalAttempts: () => Attempt[];
    loadExistingFull: () => Promise<{ items: Attempt[]; remoteLoaded: boolean; remoteError?: string; remoteSynced?: boolean; pendingSyncCount?: number }>;
}

export async function loadTeacherAttemptsWithDeps(deps: ListTeacherAttemptsDeps): Promise<TeacherLoadResult<Attempt>> {
    let status = "degraded_local";
    let serverAttempts: Attempt[] | undefined;
    try {
        const res = await deps.server();
        status = res.status;
        serverAttempts = res.attempts;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server") {
        const attempts = serverAttempts ?? [];
        return {
            items: mergeServerFirst(attempts, deps.readLocalAttempts()),
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
            source: "server",
        };
    }
    if (decision === "degraded_fallback") {
        return { ...(await deps.loadExistingFull()), source: "local" };
    }
    return {
        items: deps.readLocalAttempts(),
        remoteLoaded: false,
        remoteError: `server_${status}`,
        source: "local",
    };
}

export interface LoadTeacherAttemptDeps {
    server: (attemptId: string) => Promise<{ status: string; attempt?: Attempt }>;
    readLocalAttempt: (attemptId: string) => Attempt | null;
    loadExistingFull: (attemptId: string) => Promise<Attempt | null>;
}

export async function loadTeacherAttemptWithDeps(attemptId: string, deps: LoadTeacherAttemptDeps): Promise<Attempt | null> {
    let status = "degraded_local";
    let serverAttempt: Attempt | undefined;
    try {
        const res = await deps.server(attemptId);
        status = res.status;
        serverAttempt = res.attempt;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server" && serverAttempt) {
        return serverAttempt;
    }
    if (decision === "degraded_fallback") {
        return deps.loadExistingFull(attemptId);
    }
    // local_only (includes not_found): the attempt may be an on-device draft.
    return deps.readLocalAttempt(attemptId);
}

export interface SaveTeacherAttemptDeps {
    server: (attempt: Attempt) => Promise<{ status: string; attempt?: Attempt }>;
    saveLocal: (attempt: Attempt) => boolean;
    saveExistingFull: (attempt: Attempt) => Promise<PersistenceResult>;
}

export async function saveTeacherAttemptWithDeps(attempt: Attempt, deps: SaveTeacherAttemptDeps): Promise<PersistenceResult> {
    let status = "degraded_local";
    let savedAttempt: Attempt | undefined;
    try {
        const res = await deps.server(attempt);
        status = res.status;
        savedAttempt = res.attempt;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server") {
        const localSaved = deps.saveLocal(savedAttempt ?? attempt);
        return { localSaved, remoteSaved: true };
    }
    if (decision === "degraded_fallback") {
        return deps.saveExistingFull(attempt);
    }
    // Fail-closed: keep the edit on-device (offline-first) but no publishable-key write.
    const localSaved = deps.saveLocal(attempt);
    return { localSaved, remoteSaved: false, remoteError: `server_${status}` };
}

/* --------------------------------------------- bound wrappers for screens -- */

function readLocalAttempt(attemptId: string): Attempt | null {
    return readLocalAttempts().find(attempt => attempt.id === attemptId) ?? null;
}

export function loadTeacherAttempts(): Promise<TeacherLoadResult<Attempt>> {
    return loadTeacherAttemptsWithDeps({
        server: () => listTeacherAttemptsAction() as Promise<{ status: TeacherDataStatus; attempts?: Attempt[] }>,
        readLocalAttempts,
        loadExistingFull: loadAttemptsLegacy,
    });
}

export function loadTeacherAttempt(attemptId: string): Promise<Attempt | null> {
    return loadTeacherAttemptWithDeps(attemptId, {
        server: (id) => loadTeacherAttemptAction(id) as Promise<{ status: TeacherDataStatus; attempt?: Attempt }>,
        readLocalAttempt,
        loadExistingFull: loadAttemptLegacy,
    });
}

export function saveTeacherAttempt(attempt: Attempt): Promise<PersistenceResult> {
    return saveTeacherAttemptWithDeps(attempt, {
        server: (payload) => saveTeacherAttemptAction(payload) as Promise<{ status: TeacherDataStatus; attempt?: Attempt }>,
        saveLocal: saveLocalAttempt,
        saveExistingFull: saveAttemptLegacy,
    });
}
