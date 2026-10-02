const DEFAULT_STUDENT_REDIRECT = "/student/dashboard";

export function normalizeStudentRedirectPath(value: string | null | undefined): string {
    if (!value) return DEFAULT_STUDENT_REDIRECT;
    const trimmed = value.trim();
    if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return DEFAULT_STUDENT_REDIRECT;
    if (trimmed.startsWith("/solve/") || trimmed.startsWith("/student/")) return trimmed;
    return DEFAULT_STUDENT_REDIRECT;
}

export type StudentLoginReason = "expired";

/**
 * Student login link that returns to `next` after login. `next` goes through
 * normalizeStudentRedirectPath, so only /solve/ and /student/ paths survive.
 */
export function buildStudentLoginHref(next?: string | null, options: { reason?: StudentLoginReason } = {}): string {
    const params = new URLSearchParams({ role: "student" });
    if (options.reason) params.set("reason", options.reason);
    if (next) params.set("next", normalizeStudentRedirectPath(next));
    return `/?${params.toString()}`;
}
