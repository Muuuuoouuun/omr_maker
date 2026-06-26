import type { Exam } from "@/types/omr";

export const SOLVE_CLASS_CODE_PARAM = "classCode";

function clean(value: string | undefined): string {
    return value?.trim() || "";
}

function appendSolveParams(path: string, params: URLSearchParams): string {
    const query = params.toString();
    return query ? `${path}?${query}` : path;
}

export function buildExamSharePath(
    examId: string,
    accessConfig?: Exam["accessConfig"],
): string {
    const path = `/solve/${encodeURIComponent(examId)}`;
    const params = new URLSearchParams();
    const groupIds = accessConfig?.type === "group"
        ? (accessConfig.groupIds || []).map(clean).filter(Boolean)
        : [];

    if (groupIds.length === 1) {
        params.set(SOLVE_CLASS_CODE_PARAM, groupIds[0]);
    }

    return appendSolveParams(path, params);
}

export function buildExamShareUrl(
    origin: string,
    examId: string,
    accessConfig?: Exam["accessConfig"],
): string {
    return new URL(buildExamSharePath(examId, accessConfig), origin).toString();
}
