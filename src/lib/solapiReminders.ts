export type ReminderChannel = "kakao" | "sms";
export type ReminderKind = "before_deadline" | "overdue";
export type ReminderDeliveryStatus = "preview" | "sending" | "accepted" | "failed" | "unknown";

export interface ReminderSettings {
    examId: string;
    enabled: boolean;
    channel: ReminderChannel;
    beforeMinutes: number;
    overdueMinutes: number | null;
    quietStart: number;
    quietEnd: number;
}

export interface ReminderCandidate {
    organizationId: string;
    examId: string;
    studentId: string;
    studentName: string;
    examTitle: string;
    phone: string;
    channel: ReminderChannel;
    kind: ReminderKind;
    deadline: string;
    dueAt: string;
    assignmentId: string;
    assignmentRevision: number;
    beforeMinutes: number;
}

export interface ReminderReadiness {
    mode: "disabled" | "dry_run" | "live";
    kakaoReady: boolean;
    smsReady: boolean;
    missing: string[];
}

export interface ReminderDashboard {
    exams: { id: string; title: string; accessType: string; endAt: string | null }[];
    settings: ReminderSettings[];
    contacts: { studentId: string; name: string; group: string; phone: string; enabled: boolean }[];
    deliveries: {
        id: string; examTitle: string; studentName: string; phoneLast4: string;
        kind: ReminderKind; status: ReminderDeliveryStatus; createdAt: string;
        providerGroupId: string | null;
    }[];
}

export function normalizeReminderPhone(value: string): string | null {
    const compact = value.trim().replace(/[\s()-]/g, "").replace(/^\+82/, "0");
    return /^010\d{8}$/.test(compact) ? compact : null;
}

export function defaultReminderSettings(examId: string): ReminderSettings {
    return { examId, enabled: false, channel: "kakao", beforeMinutes: 60, overdueMinutes: 60, quietStart: 21, quietEnd: 8 };
}

export function validReminderSettings(value: ReminderSettings): boolean {
    return !!value && typeof value.examId === "string" && value.examId.length > 0 && value.examId.length <= 256
        && typeof value.enabled === "boolean" && ["kakao", "sms"].includes(value.channel)
        && Number.isInteger(value.beforeMinutes) && value.beforeMinutes >= 5 && value.beforeMinutes <= 10080
        && (value.overdueMinutes === null || (Number.isInteger(value.overdueMinutes) && value.overdueMinutes >= 0 && value.overdueMinutes <= 10080))
        && [value.quietStart, value.quietEnd].every(hour => Number.isInteger(hour) && hour >= 0 && hour <= 23);
}

export function reminderContent(candidate: ReminderCandidate, origin: string) {
    const url = new URL(`/solve/${encodeURIComponent(candidate.examId)}`, origin);
    if (candidate.assignmentId) url.searchParams.set("assignment", candidate.assignmentId);
    const deadline = new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Seoul", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(new Date(candidate.deadline));
    // Use the absolute deadline: queue delays must not turn “60 minutes left” into a false claim.
    const name = candidate.studentName.slice(0, 60);
    const title = candidate.examTitle.slice(0, 120);
    const text = candidate.kind === "before_deadline"
        ? `${name}님, ${title} 제출 마감은 ${deadline}입니다. 아직 제출하지 않았다면 문제를 풀고 제출해주세요.\n${url.href}`
        : `${name}님, ${title} 제출 마감(${deadline})이 지났지만 제출 내역이 확인되지 않습니다. 선생님께 확인해주세요.\n${url.href}`;
    return {
        text, url: url.href,
        variables: { "#{학생명}": name, "#{시험명}": title, "#{마감시간}": deadline, "#{링크}": url.href },
    };
}
