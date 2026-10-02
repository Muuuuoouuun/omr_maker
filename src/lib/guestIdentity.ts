/**
 * Default display name for a guest who did not type one. Korean, because the
 * teacher sees it in rosters and the student sees it on their own dashboard.
 */
export const DEFAULT_GUEST_NAME = "게스트";

/** Name stored by builds before DEFAULT_GUEST_NAME existed. Never written anymore. */
const LEGACY_DEFAULT_GUEST_NAME = "Guest Student";

/**
 * Display-time mapping only: stored sessions, cookies and attempts keep
 * whatever name they were created with, so identity matching is unaffected.
 */
export function displayStudentName(name: string | null | undefined): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed || trimmed === LEGACY_DEFAULT_GUEST_NAME) return DEFAULT_GUEST_NAME;
    return trimmed;
}
