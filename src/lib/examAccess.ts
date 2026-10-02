import type { Exam } from "@/types/omr";
import { resolveAssignmentLifecycle } from "@/lib/assignmentLifecycle";

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

function numericNowIso(value: number): string | null {
    if (!Number.isFinite(value)) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
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

    const now = numericNowIso(context.now ?? Date.now());
    const lifecycle = resolveAssignmentLifecycle({
        state: "open",
        startsAt: exam.startAt,
        endsAt: exam.endAt,
        now,
    });
    if (lifecycle === "scheduled") return { status: "not_started", at: exam.startAt };
    if (lifecycle === "closed") return { status: "ended", at: exam.endAt };
    if (lifecycle === "invalid") return { status: "ended" };

    const config = exam.accessConfig;
    if (config?.type === "targeted") {
        const session = context.session;
        return !session || session.isGuest || session.identityType === "guest"
            ? { status: "login_required" }
            : { status: "allowed" };
    }
    if (config?.type === "group") {
        const session = context.session;
        if (!session) {
            return { status: "login_required" };
        }
        const allowedGroups = config.groupIds || [];
        if (allowedGroups.length === 0) return { status: "group_denied" };
        if (session.groupId && allowedGroups.includes(session.groupId)) return { status: "allowed" };
        if (session.groupName && allowedGroups.includes(session.groupName)) return { status: "allowed" };
        if (session.isGuest || session.identityType === "guest") {
            return session.groupId || session.groupName ? { status: "group_denied" } : { status: "login_required" };
        }
        return { status: "group_denied" };
    }

    if (config?.type === "public" && config.pin && !context.pinVerified) {
        return { status: "pin_required" };
    }

    return { status: "allowed" };
}
