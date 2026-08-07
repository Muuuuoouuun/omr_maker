/**
 * Capacity envelope for the first operational release.
 *
 * Gateways and load checks must use these values instead of defining their own
 * ceilings so that the at-most-100-user launch contract remains auditable.
 */
export const INITIAL_OPERATIONS_LIMITS = Object.freeze({
    activeStudents: 100,
    teacherExams: 250,
    teacherAttempts: 2_000,
    studentAttempts: 250,
    studentFeedback: 250,
    classes: 100,
    students: 100,
    enrollments: 500,
    invites: 250,
    listPageSize: 250,
    backgroundRevalidationMs: 30_000,
    defaultBackendTimeoutMs: 9_000,
    minimumBackendTimeoutMs: 3_000,
    maximumBackendTimeoutMs: 20_000,
} as const);

/** Stable public failure code returned when a bounded first-release read overflows. */
export const INITIAL_CAPACITY_EXCEEDED_ERROR = "initial_capacity_exceeded" as const;

/** Truthful remediation shared by every first-release bounded-list consumer. */
export const INITIAL_CAPACITY_REMEDIATION_KO =
    "시험 목록 또는 응시 기록이 초기 지원 범위를 초과했습니다. 담당 강사나 관리자에게 오래된 시험·기록 정리를 요청한 뒤 다시 시도해주세요.";

export const INITIAL_FEEDBACK_CAPACITY_REMEDIATION_KO =
    "반환된 피드백이 초기 지원 범위를 초과했습니다. 담당 강사나 관리자에게 오래된 피드백 정리를 요청한 뒤 다시 시도해주세요.";

export function normalizeBackendTimeoutMs(value?: unknown): number {
    if (typeof value === "string" && value.trim() === "") {
        return INITIAL_OPERATIONS_LIMITS.defaultBackendTimeoutMs;
    }

    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) {
        return INITIAL_OPERATIONS_LIMITS.defaultBackendTimeoutMs;
    }

    return Math.min(
        INITIAL_OPERATIONS_LIMITS.maximumBackendTimeoutMs,
        Math.max(INITIAL_OPERATIONS_LIMITS.minimumBackendTimeoutMs, Math.trunc(parsed)),
    );
}
