import type { Exam } from "@/types/omr";

export const SOLVE_CLASS_CODE_PARAM = "classCode";
export const SOLVE_INVITE_PARAM = "invite";

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
    inviteToken?: string,
): string {
    const path = `/solve/${encodeURIComponent(examId)}`;
    const params = new URLSearchParams();
    const invite = clean(inviteToken);
    const groupIds = accessConfig?.type === "group" && !invite
        ? (accessConfig.groupIds || []).map(clean).filter(Boolean)
        : [];

    if (groupIds.length === 1) {
        params.set(SOLVE_CLASS_CODE_PARAM, groupIds[0]);
    }
    const queryPath = appendSolveParams(path, params);
    return /^[A-Za-z0-9_-]{43}$/.test(invite)
        ? `${queryPath}#${SOLVE_INVITE_PARAM}=${encodeURIComponent(invite)}`
        : queryPath;
}

export function buildExamShareUrl(
    origin: string,
    examId: string,
    accessConfig?: Exam["accessConfig"],
    inviteToken?: string,
): string {
    return new URL(buildExamSharePath(examId, accessConfig, inviteToken), origin).toString();
}

export function buildStudentExamLoginHref(solvePath: string, examId: string): string {
    const params = new URLSearchParams({ role: "student", next: solvePath });
    const exam = clean(examId);
    if (exam) params.set("exam", exam);
    return `/?${params.toString()}`;
}
