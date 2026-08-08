// Recovery only needs these post-login destinations. Keeping this list exact
// prevents nested URLs, query strings, fragments, and arbitrary path content
// from crossing the legacy-token cutover boundary.
export const TEACHER_RECOVERY_SAFE_NEXT_PATHS = [
    "/teacher/dashboard",
    "/teacher/settings",
] as const;

export function buildTeacherRecoveryCanonicalUrl(url: URL): string {
    const canonicalSearch = new URLSearchParams();
    canonicalSearch.set("role", "teacher");
    canonicalSearch.set("teacherRecovery", "legacy_link");

    const requestedNextValues = url.searchParams.getAll("next");
    const requestedNext = requestedNextValues.length === 1 ? requestedNextValues[0] : "";
    if ((TEACHER_RECOVERY_SAFE_NEXT_PATHS as readonly string[]).includes(requestedNext)) {
        canonicalSearch.set("next", requestedNext);
    }

    return `/?${canonicalSearch.toString()}`;
}
