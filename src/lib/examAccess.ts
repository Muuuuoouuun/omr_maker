import type { Exam } from "@/types/omr";

export interface ExamAccessSession {
    groupId?: string;
    groupName?: string;
    isGuest?: boolean;
    identityType?: string;
}

export type ExamAccessStatus =
    | "allowed"
    | "pin_required"
    | "login_required"
    | "group_denied"
    | "not_started"
    | "ended"
    | "archived";

export interface ExamAccessDecision {
    status: ExamAccessStatus;
    at?: string;
}

export function normalizeExamPin(value: string): string {
    return value.replace(/\D/g, "").slice(0, 6);
}

export function isValidExamPin(value: string): boolean {
    return /^\d{4,6}$/.test(value);
}

export function examRequiresPin(exam: Pick<Exam, "accessConfig"> | null | undefined): boolean {
    return !!(exam?.accessConfig?.type === "public" && exam.accessConfig.pin);
}

export function verifyExamPin(exam: Pick<Exam, "accessConfig"> | null | undefined, input: string): boolean {
    if (!examRequiresPin(exam)) return true;
    return normalizeExamPin(input) === exam?.accessConfig?.pin;
}

function timestamp(value: string | undefined): number | null {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
}

export function evaluateExamAccess(
    exam: Pick<Exam, "accessConfig" | "archived" | "startAt" | "endAt"> | null | undefined,
    context: {
        session?: ExamAccessSession | null;
        pinVerified?: boolean;
        now?: number;
    } = {},
): ExamAccessDecision {
    if (!exam) return { status: "ended" };
    if (exam.archived) return { status: "archived" };

    const now = context.now ?? Date.now();
    const startAt = timestamp(exam.startAt);
    const endAt = timestamp(exam.endAt);
    if (startAt !== null && startAt > now) return { status: "not_started", at: exam.startAt };
    if (endAt !== null && endAt < now) return { status: "ended", at: exam.endAt };

    const config = exam.accessConfig;
    if (config?.type === "group") {
        const session = context.session;
        if (!session || session.isGuest || session.identityType === "guest") {
            return { status: "login_required" };
        }
        const allowedGroups = config.groupIds || [];
        if (allowedGroups.length === 0) return { status: "group_denied" };
        if (session.groupId && allowedGroups.includes(session.groupId)) return { status: "allowed" };
        if (session.groupName && allowedGroups.includes(session.groupName)) return { status: "allowed" };
        return { status: "group_denied" };
    }

    if (config?.type === "public" && config.pin && !context.pinVerified) {
        return { status: "pin_required" };
    }

    return { status: "allowed" };
}
