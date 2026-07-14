const DEFAULT_STUDENT_REDIRECT = "/student/dashboard";

export function normalizeStudentRedirectPath(value: string | null | undefined): string {
    if (!value) return DEFAULT_STUDENT_REDIRECT;
    const trimmed = value.trim();
    if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return DEFAULT_STUDENT_REDIRECT;
    if (trimmed.startsWith("/solve/") || trimmed.startsWith("/student/")) return trimmed;
    return DEFAULT_STUDENT_REDIRECT;
}
