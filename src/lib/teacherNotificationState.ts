export const MAX_TEACHER_NOTIFICATION_STATE_IDS = 16;

export type TeacherNotificationStateOperation = "mark_read" | "dismiss";

export interface TeacherNotificationState {
    notificationId: string;
    read: boolean;
    dismissed: boolean;
}

const CANONICAL_NOTIFICATION_ID_PATTERN =
    /^auto-(?:recent-exams|student-questions):\d{1,16}:[a-f0-9]{32}$/;

export function isCanonicalTeacherNotificationId(value: unknown): value is string {
    return typeof value === "string"
        && value.length <= 96
        && CANONICAL_NOTIFICATION_ID_PATTERN.test(value);
}

export function validateTeacherNotificationIds(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.length > MAX_TEACHER_NOTIFICATION_STATE_IDS) return null;
    if (!value.every(isCanonicalTeacherNotificationId)) return null;
    const ids = value as string[];
    return new Set(ids).size === ids.length ? [...ids] : null;
}

function validTimestamp(value: unknown): value is string {
    if (typeof value !== "string" || value.length < 20 || value.length > 64) return false;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed);
}

export function normalizeTeacherNotificationStateRows(
    value: unknown,
    expectedIds: string[],
): TeacherNotificationState[] | null {
    const validExpectedIds = validateTeacherNotificationIds(expectedIds);
    if (!validExpectedIds || !Array.isArray(value) || value.length > validExpectedIds.length) return null;
    const expected = new Set(validExpectedIds);
    const seen = new Set<string>();
    const states: TeacherNotificationState[] = [];
    for (const item of value) {
        if (!item || typeof item !== "object" || Array.isArray(item)) return null;
        const row = item as Record<string, unknown>;
        const notificationId = row.notification_id;
        if (!isCanonicalTeacherNotificationId(notificationId)
            || !expected.has(notificationId)
            || seen.has(notificationId)) return null;
        const read = row.read_at === null ? false : validTimestamp(row.read_at);
        const dismissed = row.dismissed_at === null ? false : validTimestamp(row.dismissed_at);
        if ((!read && !dismissed) || (dismissed && !read)) return null;
        seen.add(notificationId);
        states.push({ notificationId, read, dismissed });
    }
    return states;
}

export function applyTeacherNotificationStates<T extends { id: string; unread: boolean }>(
    notifications: T[],
    states: TeacherNotificationState[],
): T[] {
    const stateById = new Map(states.map(state => [state.notificationId, state]));
    return notifications.flatMap(notification => {
        const state = stateById.get(notification.id);
        if (state?.dismissed) return [];
        return [{ ...notification, unread: state?.read ? false : notification.unread }];
    });
}
