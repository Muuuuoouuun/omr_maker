import {
    listTeacherCanonicalExams,
    loadTeacherCanonicalExam,
    saveTeacherCanonicalExam,
    deleteTeacherCanonicalExam,
} from "@/app/actions/teacherExam";
import {
    loadExam,
    loadExams,
    readLocalExams,
    saveLocalExam,
    saveLocalExams,
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
    localOnly?: boolean;
    error?: string;
}

export async function saveTeacherExamMutation(exam: Exam): Promise<TeacherExamMutationResult> {
    const result = await saveTeacherCanonicalExam(exam);
    if (result.status === "saved") {
        saveLocalExam(result.exam);
        return { ok: true };
    }
    if (result.status === "local_only") return { ok: saveLocalExam(exam), localOnly: true };
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
        deleteLocalExam(examId);
        return { ok: true };
    }
    if (result.status === "local_only") return { ok: deleteLocalExam(examId), localOnly: true };
    return {
        ok: false,
        error: result.status === "unauthorized"
            ? "교사 로그인이 필요합니다."
            : result.status === "not_found"
                ? "삭제할 시험을 찾지 못했습니다."
                : ("error" in result ? result.error : undefined) || "시험을 서버에서 삭제하지 못했습니다.",
    };
}

export async function loadTeacherExam(examId: string): Promise<Exam | null> {
    const result = await loadTeacherCanonicalExam(examId);
    if (result.status === "loaded") {
        saveLocalExam(result.exam);
        return result.exam;
    }
    if (result.status === "local_only") return loadExam(examId);
    return null;
}

export async function loadTeacherExams(): Promise<TeacherExamLoadResult> {
    const result = await listTeacherCanonicalExams();
    if (result.status === "loaded") {
        saveLocalExams(result.exams);
        return {
            items: result.exams,
            remoteLoaded: true,
            remoteSynced: true,
            pendingSyncCount: 0,
        };
    }
    if (result.status === "local_only") return loadExams();
    return {
        items: readLocalExams(),
        remoteLoaded: false,
        remoteSynced: false,
        remoteError: result.status === "unauthorized"
            ? "Teacher server session is missing"
            : result.error || "Canonical exam gateway unavailable",
    };
}
