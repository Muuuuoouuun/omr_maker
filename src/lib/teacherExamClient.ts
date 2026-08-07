import {
    listTeacherCanonicalExams,
    loadTeacherCanonicalExam,
    saveTeacherCanonicalExam,
    deleteTeacherCanonicalExam,
} from "@/app/actions/teacherExam";
import {
    loadExam,
    loadExams,
    saveExam,
    saveLocalExam,
    deleteLocalExam,
} from "@/lib/omrPersistence";
import type { Exam } from "@/types/omr";

export interface TeacherExamLoadResult {
    items: Exam[];
    remoteLoaded: boolean;
    remoteError?: string;
    remoteSynced?: boolean;
    pendingSyncCount?: number;
}

export interface TeacherExamMutationResult {
    ok: boolean;
    exam?: Exam;
    localOnly?: boolean;
    conflict?: boolean;
    currentRevision?: number;
    serverUpdatedAt?: string;
    error?: string;
}

export interface TeacherExamDashboardMutationResult extends TeacherExamMutationResult {
    exam?: Exam;
}

export type TeacherExamDetailLoadResult =
    | { status: "loaded"; exam: Exam; source: "server" | "local" }
    | { status: "not_found" }
    | { status: "unauthorized"; error: string }
    | { status: "service_unavailable"; error: string };

export async function saveTeacherExamMutation(exam: Exam): Promise<TeacherExamMutationResult> {
    const result = await saveTeacherCanonicalExam(exam);
    if (result.status === "saved") {
        saveLocalExam(result.exam);
        return { ok: true, exam: result.exam };
    }
    if (result.status === "local_only") {
        const localResult = await saveExam(exam);
        return { ok: localResult.localSaved, localOnly: true };
    }
    if (result.status === "conflict") {
        return {
            ok: false,
            conflict: true,
            currentRevision: result.currentRevision,
            ...(result.serverUpdatedAt ? { serverUpdatedAt: result.serverUpdatedAt } : {}),
            error: "다른 기기나 탭에서 시험이 먼저 변경되었습니다. 현재 초안은 유지됩니다.",
        };
    }
    return {
        ok: false,
        error: result.status === "unauthorized"
            ? "교사 로그인이 필요합니다."
            : ("error" in result ? result.error : undefined) || "시험을 서버에 저장하지 못했습니다.",
    };
}

export async function deleteTeacherExamMutation(examId: string): Promise<TeacherExamMutationResult> {
    const result = await deleteTeacherCanonicalExam(examId);
    if (result.status === "deleted") {
        await deleteLocalExam(examId);
        return { ok: true };
    }
    if (result.status === "local_only") return { ok: await deleteLocalExam(examId), localOnly: true };
    return {
        ok: false,
        error: result.status === "unauthorized"
            ? "교사 로그인이 필요합니다."
            : result.status === "not_found"
                ? "삭제할 시험을 찾지 못했습니다."
                : ("error" in result ? result.error : undefined) || "시험을 서버에서 삭제하지 못했습니다.",
    };
}

export async function loadTeacherExamDetail(examId: string): Promise<TeacherExamDetailLoadResult> {
    const result = await loadTeacherCanonicalExam(examId);
    if (result.status === "loaded") {
        saveLocalExam(result.exam);
        return { status: "loaded", exam: result.exam, source: "server" };
    }
    if (result.status === "local_only") {
        const exam = await loadExam(examId);
        return exam
            ? { status: "loaded", exam, source: "local" }
            : { status: "not_found" };
    }
    if (result.status === "not_found") return { status: "not_found" };
    if (result.status === "unauthorized") {
        return {
            status: "unauthorized",
            error: result.error || "Teacher server session is missing",
        };
    }
    return {
        status: "service_unavailable",
        error: result.error || "Canonical exam gateway unavailable",
    };
}

export async function loadTeacherExam(examId: string): Promise<Exam | null> {
    const result = await loadTeacherExamDetail(examId);
    return result.status === "loaded" ? result.exam : null;
}

function detailLoadError(result: Exclude<TeacherExamDetailLoadResult, { status: "loaded" }>): string {
    if (result.status === "not_found") return "시험 상세 정보를 찾지 못했습니다.";
    return result.error;
}

export async function setTeacherExamArchivedFromSummary(
    summary: Pick<Exam, "id">,
    desiredArchived: boolean,
): Promise<TeacherExamDashboardMutationResult> {
    const detail = await loadTeacherExamDetail(summary.id);
    if (detail.status !== "loaded") return { ok: false, error: detailLoadError(detail) };
    if (!!detail.exam.archived === desiredArchived) {
        return { ok: true, exam: detail.exam };
    }
    const updated: Exam = {
        ...detail.exam,
        archived: desiredArchived,
        updatedAt: new Date().toISOString(),
    };
    const result = await saveTeacherExamMutation(updated);
    return result.ok ? { ...result, exam: result.exam || updated } : result;
}

export async function loadTeacherExams(): Promise<TeacherExamLoadResult> {
    const result = await listTeacherCanonicalExams();
    if (result.status === "loaded") {
        return {
            items: result.exams,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
        };
    }
    if (result.status === "local_only") return loadExams();
    return {
        items: [],
        remoteLoaded: false,
        remoteSynced: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical exam gateway unavailable",
    };
}
