import {
    applyTeacherNotificationStates,
    type TeacherNotificationState,
} from "@/lib/teacherNotificationState";

export interface TeacherNotificationSummary {
    recentCompletedAttemptCount: number;
    queuedStudentQuestionCount: number;
    recentEventVersion: string;
    queuedEventVersion: string;
}

export interface ScopedTeacherNotificationSummary extends TeacherNotificationSummary {
    scopeKey: string;
    notificationStates: TeacherNotificationState[];
}

export interface TeacherSummaryNotification {
    id: string;
    source: "recent-exams" | "student-questions" | "sync-status";
    kind: "info" | "success" | "warning";
    title: string;
    message: string;
    time: string;
    unread: boolean;
    href?: string;
}

function nonNegativeSafeInteger(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isSafeInteger(value) && value >= 0 ? value : null;
    }
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
}

function eventVersion(value: unknown, count: number): string | null {
    if (count === 0) return value === "none" ? "none" : null;
    return typeof value === "string" && /^[a-f0-9]{32}$/.test(value) ? value : null;
}

export function normalizeTeacherNotificationSummary(value: unknown): TeacherNotificationSummary | null {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const recentCompletedAttemptCount = nonNegativeSafeInteger(record.recent_completed_attempt_count);
    const queuedStudentQuestionCount = nonNegativeSafeInteger(record.queued_student_question_count);
    if (recentCompletedAttemptCount === null || queuedStudentQuestionCount === null) return null;
    const recentEventVersion = eventVersion(record.recent_event_version, recentCompletedAttemptCount);
    const queuedEventVersion = eventVersion(record.queued_event_version, queuedStudentQuestionCount);
    if (!recentEventVersion || !queuedEventVersion) return null;
    return {
        recentCompletedAttemptCount,
        queuedStudentQuestionCount,
        recentEventVersion,
        queuedEventVersion,
    };
}

export function notificationsFromTeacherSummary(summary: TeacherNotificationSummary): TeacherSummaryNotification[] {
    const notifications: TeacherSummaryNotification[] = [];
    if (summary.recentCompletedAttemptCount > 0) {
        notifications.push({
            id: `auto-recent-exams:${summary.recentCompletedAttemptCount}:${summary.recentEventVersion}`,
            source: "recent-exams",
            kind: "success",
            title: "최근 시험 제출",
            message: `최근 24시간 내 ${summary.recentCompletedAttemptCount}개 시험 제출 완료`,
            time: "최근 24시간",
            unread: true,
            href: "/teacher/live",
        });
    }
    if (summary.queuedStudentQuestionCount > 0) {
        notifications.push({
            id: `auto-student-questions:${summary.queuedStudentQuestionCount}:${summary.queuedEventVersion}`,
            source: "student-questions",
            kind: "info",
            title: "학생 질문 대기",
            message: `${summary.queuedStudentQuestionCount}건의 학생 질문이 답변을 기다립니다`,
            time: "답변 전",
            unread: true,
            href: "/teacher/dashboard#student-question-inbox",
        });
    }
    return notifications;
}

const CANONICAL_SOURCES = new Set(["recent-exams", "student-questions"]);

export function mergeCanonicalTeacherNotifications<T extends { source?: string }>(
    local: T[],
    canonical: TeacherSummaryNotification[],
): Array<T | TeacherSummaryNotification> {
    return [
        ...local.filter(notification => !notification.source || !CANONICAL_SOURCES.has(notification.source)),
        ...canonical,
    ];
}

export type TeacherNotificationRefreshServerResult =
    | { status: "loaded"; summary: ScopedTeacherNotificationSummary }
    | { status: "local_only" }
    | { status: "unauthorized" }
    | { status: "service_unavailable" };

export interface TeacherNotificationStorageNamespace {
    notificationsKey: string;
    dismissedKey: string;
}

export interface TeacherNotificationRefreshResolution<T> {
    notifications: Array<T | TeacherSummaryNotification>;
    namespace: TeacherNotificationStorageNamespace | null;
    shouldPersist: boolean;
}

const DISMISSED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const SCOPE_KEY_PATTERN = /^scope_[A-Za-z0-9_-]{32,64}$/;

function reconcileNotifications<T extends { id: string; source?: string; unread: boolean }>(
    persisted: T[],
    auto: Array<T | TeacherSummaryNotification>,
    dismissed: Array<{ id: string; at: number }>,
    now: number,
): Array<T | TeacherSummaryNotification> {
    const dismissedIds = new Set(
        dismissed
            .filter(entry => entry && typeof entry.id === "string"
                && Number.isFinite(entry.at) && now - entry.at >= 0 && now - entry.at < DISMISSED_TTL_MS)
            .map(entry => entry.id),
    );
    const persistedById = new Map(persisted.map(notification => [notification.id, notification]));
    const currentAuto = auto
        .filter(notification => !dismissedIds.has(notification.id))
        .map(notification => persistedById.get(notification.id)?.unread === false
            ? { ...notification, unread: false }
            : notification);
    return [
        ...currentAuto,
        ...persisted.filter(notification => !notification.source),
    ];
}

function unavailableNotification(): TeacherSummaryNotification {
    return {
        id: "notification-sync-unavailable",
        source: "sync-status",
        kind: "warning",
        title: "알림 동기화 확인 불가",
        message: "서버 연결을 확인한 뒤 다시 시도해 주세요. 이전 계정의 알림은 표시하지 않습니다.",
        time: "확인 필요",
        unread: false,
    };
}

export function resolveTeacherNotificationRefresh<T extends { id: string; source?: string; unread: boolean }>(
    result: TeacherNotificationRefreshServerResult,
    options: {
        readPersisted(key: string): T[];
        readDismissed(key: string): Array<{ id: string; at: number }>;
        computeLocalFallback(): T[];
        now?: number;
    },
): TeacherNotificationRefreshResolution<T> {
    if (result.status === "unauthorized") {
        return { notifications: [], namespace: null, shouldPersist: false };
    }
    if (result.status === "service_unavailable") {
        return { notifications: [unavailableNotification()], namespace: null, shouldPersist: false };
    }

    const namespace: TeacherNotificationStorageNamespace = result.status === "local_only"
        ? {
            notificationsKey: "omr_notifications",
            dismissedKey: "omr_notifications_dismissed",
        }
        : {
            notificationsKey: `omr_notifications:v2:${result.summary.scopeKey}`,
            dismissedKey: `omr_notifications_dismissed:v2:${result.summary.scopeKey}`,
        };
    if (result.status === "loaded" && !SCOPE_KEY_PATTERN.test(result.summary.scopeKey)) {
        return { notifications: [unavailableNotification()], namespace: null, shouldPersist: false };
    }

    if (result.status === "loaded") {
        const canonical = notificationsFromTeacherSummary(result.summary);
        const canonicalIds = new Set(canonical.map(notification => notification.id));
        if (result.summary.notificationStates.some(state => !canonicalIds.has(state.notificationId))) {
            return { notifications: [unavailableNotification()], namespace: null, shouldPersist: false };
        }
        return {
            notifications: applyTeacherNotificationStates(canonical, result.summary.notificationStates),
            namespace,
            shouldPersist: false,
        };
    }

    const persisted = options.readPersisted(namespace.notificationsKey);
    const dismissed = options.readDismissed(namespace.dismissedKey);
    const auto = options.computeLocalFallback();
    return {
        notifications: reconcileNotifications(
            persisted,
            auto,
            dismissed,
            options.now ?? Date.now(),
        ),
        namespace,
        shouldPersist: true,
    };
}
