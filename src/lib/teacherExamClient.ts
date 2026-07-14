import type { Exam } from "@/types/omr";
import type { TeacherDataStatus } from "@/lib/teacherServerAccess";
import {
    deleteExam as deleteExamLegacy,
    deleteLocalExam,
    loadExam as loadExamLegacy,
    loadExams as loadExamsLegacy,
    readLocalExam,
    readLocalExams,
    saveExam as saveExamLegacy,
    saveLocalExam,
    sortByNewestActivity,
    type PersistenceResult,
} from "@/lib/omrPersistence";
import {
    deleteTeacherExamAction,
    listTeacherExamsAction,
    loadTeacherExamAction,
    saveTeacherExamAction,
} from "@/app/actions/teacherExams";

/**
 * Client-side wrapper over the teacher exam server actions (B1).
 *
 * Policy (설계 §5.1 / §8, account-security checklist):
 * - The server boundary (service-role, org-scoped, session-bound) is the primary
 *   path whenever a service role is configured.
 * - `degraded_local` — no service role outside production — is the ONLY status
 *   that keeps the existing local + publishable-key path alive, so dev / alpha
 *   / self-hosted setups keep their current offline-first sync.
 * - `denied` (production without the service role, or a session/ownership
 *   refusal) is a hard stop for anything remote: the client reads/writes ONLY
 *   its own on-device cache and NEVER touches the publishable key. This is what
 *   lets production RLS be enabled without breaking a teacher-side client query.
 */

export type TeacherLoadSource = "server" | "local";

export interface TeacherLoadResult<T> {
    items: T[];
    remoteLoaded: boolean;
    remoteSynced?: boolean;
    pendingSyncCount?: number;
    remoteError?: string;
    source: TeacherLoadSource;
}

type ServerFirstDecision = "server" | "degraded_fallback" | "local_only";

/**
 * Map a server action status onto the client fallback decision.
 * - `ok`             → trust the server response.
 * - `degraded_local` → keep the existing local + publishable-key path.
 * - anything else (`denied`, `unauthenticated`, `not_found`, `error`) → the
 *   on-device cache only. Critically, `denied` is here and NOT in
 *   `degraded_fallback`, so a fail-closed production refusal never revives the
 *   publishable-key path.
 */
export function classifyTeacherServerStatus(status: string): ServerFirstDecision {
    if (status === "ok") return "server";
    if (status === "degraded_local") return "degraded_fallback";
    return "local_only";
}

function mergeServerFirst(serverExams: Exam[], localExams: Exam[]): Exam[] {
    const serverIds = new Set(serverExams.map(exam => exam.id));
    const localOnly = localExams.filter(exam => !serverIds.has(exam.id));
    return sortByNewestActivity([...serverExams, ...localOnly]);
}

export interface ListTeacherExamsDeps {
    server: () => Promise<{ status: string; exams?: Exam[] }>;
    readLocalExams: () => Exam[];
    cacheExam: (exam: Exam) => void;
    loadExistingFull: () => Promise<TeacherLoadResult<Exam> | { items: Exam[]; remoteLoaded: boolean; remoteError?: string; remoteSynced?: boolean; pendingSyncCount?: number }>;
}

export async function loadTeacherExamsWithDeps(deps: ListTeacherExamsDeps): Promise<TeacherLoadResult<Exam>> {
    let status = "degraded_local";
    let serverExams: Exam[] | undefined;
    try {
        const res = await deps.server();
        status = res.status;
        serverExams = res.exams;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server") {
        const exams = serverExams ?? [];
        for (const exam of exams) deps.cacheExam(exam);
        return {
            items: mergeServerFirst(exams, deps.readLocalExams()),
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
        items: deps.readLocalExams(),
        remoteLoaded: false,
        remoteError: `server_${status}`,
        source: "local",
    };
}

export interface LoadTeacherExamDeps {
    server: (examId: string) => Promise<{ status: string; exam?: Exam }>;
    readLocalExam: (examId: string) => Exam | null;
    cacheExam: (exam: Exam) => void;
    loadExistingFull: (examId: string) => Promise<Exam | null>;
}

export async function loadTeacherExamWithDeps(examId: string, deps: LoadTeacherExamDeps): Promise<Exam | null> {
    let status = "degraded_local";
    let serverExam: Exam | undefined;
    try {
        const res = await deps.server(examId);
        status = res.status;
        serverExam = res.exam;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server" && serverExam) {
        deps.cacheExam(serverExam);
        return serverExam;
    }
    if (decision === "degraded_fallback") {
        return deps.loadExistingFull(examId);
    }
    // local_only (includes not_found → the exam may be a local-only draft).
    return deps.readLocalExam(examId);
}

export interface SaveTeacherExamDeps {
    server: (exam: Exam) => Promise<{ status: string; exam?: Exam }>;
    saveLocal: (exam: Exam) => boolean;
    saveExistingFull: (exam: Exam) => Promise<PersistenceResult>;
}

export async function saveTeacherExamWithDeps(exam: Exam, deps: SaveTeacherExamDeps): Promise<PersistenceResult> {
    let status = "degraded_local";
    let savedExam: Exam | undefined;
    try {
        const res = await deps.server(exam);
        status = res.status;
        savedExam = res.exam;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server") {
        const localSaved = deps.saveLocal(savedExam ?? exam);
        return { localSaved, remoteSaved: true };
    }
    if (decision === "degraded_fallback") {
        return deps.saveExistingFull(exam);
    }
    // Fail-closed: keep the answer on-device (offline-first) but never publishable-key write.
    const localSaved = deps.saveLocal(exam);
    return { localSaved, remoteSaved: false, remoteError: `server_${status}` };
}

export interface DeleteTeacherExamDeps {
    server: (examId: string) => Promise<{ status: string }>;
    deleteLocal: (examId: string) => boolean;
    deleteExistingFull: (examId: string) => Promise<PersistenceResult>;
}

export async function deleteTeacherExamWithDeps(examId: string, deps: DeleteTeacherExamDeps): Promise<PersistenceResult> {
    let status = "degraded_local";
    try {
        const res = await deps.server(examId);
        status = res.status;
    } catch {
        status = "degraded_local";
    }

    const decision = classifyTeacherServerStatus(status);
    if (decision === "server") {
        const localSaved = deps.deleteLocal(examId);
        return { localSaved, remoteSaved: true };
    }
    if (decision === "degraded_fallback") {
        return deps.deleteExistingFull(examId);
    }
    const localSaved = deps.deleteLocal(examId);
    return { localSaved, remoteSaved: false, remoteError: `server_${status}` };
}

/* --------------------------------------------- bound wrappers for screens -- */

export function loadTeacherExams(): Promise<TeacherLoadResult<Exam>> {
    return loadTeacherExamsWithDeps({
        server: () => listTeacherExamsAction() as Promise<{ status: TeacherDataStatus; exams?: Exam[] }>,
        readLocalExams,
        cacheExam: saveLocalExam,
        loadExistingFull: loadExamsLegacy,
    });
}

export function loadTeacherExam(examId: string): Promise<Exam | null> {
    return loadTeacherExamWithDeps(examId, {
        server: (id) => loadTeacherExamAction(id) as Promise<{ status: TeacherDataStatus; exam?: Exam }>,
        readLocalExam,
        cacheExam: saveLocalExam,
        loadExistingFull: loadExamLegacy,
    });
}

export function saveTeacherExam(exam: Exam): Promise<PersistenceResult> {
    return saveTeacherExamWithDeps(exam, {
        server: (payload) => saveTeacherExamAction(payload) as Promise<{ status: TeacherDataStatus; exam?: Exam }>,
        saveLocal: saveLocalExam,
        saveExistingFull: saveExamLegacy,
    });
}

export function deleteTeacherExam(examId: string): Promise<PersistenceResult> {
    return deleteTeacherExamWithDeps(examId, {
        server: (id) => deleteTeacherExamAction(id) as Promise<{ status: TeacherDataStatus }>,
        deleteLocal: deleteLocalExam,
        deleteExistingFull: deleteExamLegacy,
    });
}
