"use server";

import { cookies, headers } from "next/headers";
import {
    listStudentFeedbackWithGateway,
    loadStudentFeedbackWithGateway,
    loadTeacherFeedbackWithGateway,
    markStudentFeedbackOpenedWithGateway,
    returnTeacherFeedbackWithGateway,
    saveTeacherFeedbackWithGateway,
    type FeedbackEnvelope,
    type FeedbackGatewayClient,
} from "@/lib/feedbackServerGateway";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    type StudentServerSession,
} from "@/lib/studentServerSession";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import { workspaceContextFromTeacherSession, type WorkspaceContext } from "@/lib/workspaceContext";
import type { AttemptFeedback, PdfDrawings } from "@/types/omr";
import { reportServerError } from "@/lib/reportServerError";

type ActionFailure = {
    status: "local_only" | "unauthorized" | "plan_denied" | "not_found" | "invalid_feedback" | "service_unavailable" | "conflict";
    error?: string;
    currentRevision?: number;
    currentStatus?: string;
    serverUpdatedAt?: string;
};

type TeacherActionContext = {
    client: FeedbackGatewayClient;
    context: WorkspaceContext;
} | ActionFailure;

type StudentActionContext = {
    client: FeedbackGatewayClient;
    session: StudentServerSession;
} | ActionFailure;

function unavailable(): ActionFailure {
    return process.env.NODE_ENV === "production"
        ? { status: "service_unavailable", error: "Feedback gateway is not configured" }
        : { status: "local_only" };
}

function planDenied(): ActionFailure {
    return {
        status: "plan_denied",
        error: "현재 서버 플랜에서 사용할 수 없는 기능입니다.",
    };
}

function isPlanEntitlementError(result: { status: string; error?: string }): boolean {
    return result.status === "service_unavailable"
        && /plan entitlement required/i.test(result.error || "");
}

async function teacherContext(
    requireWrite = false,
): Promise<TeacherActionContext> {
    if (!isSameOriginServerActionRequest(await headers())) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = await resolveAuthorizedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    if (requireWrite && !isTeacherMutationAuthorized(session)) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return unavailable();
    return {
        client: createSupabaseAdminClient(config) as unknown as FeedbackGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

async function studentContext(): Promise<StudentActionContext> {
    if (!isSameOriginServerActionRequest(await headers())) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return unavailable();
    const client = createSupabaseAdminClient(config) as unknown as FeedbackGatewayClient;
    const cookieStore = await cookies();
    const validation = await resolveAuthorizedStudentSessionCookie(
        cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        client,
    );
    if (validation.status === "service_unavailable") return { status: "service_unavailable" };
    if (validation.status !== "active") return { status: "unauthorized" };
    const session = validation.identity;
    return {
        client,
        session,
    };
}

export async function loadTeacherCanonicalFeedback(attemptId: string): Promise<
    { status: "loaded"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await teacherContext();
        if ("status" in gateway) return gateway;
        const result = await loadTeacherFeedbackWithGateway(gateway.client, attemptId, gateway.context);
        if (result.status === "service_unavailable") {
            await reportServerError("feedback-read", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "피드백을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("feedback-read", error);
        return { status: "service_unavailable", error: "피드백을 불러올 수 없습니다." };
    }
}

export async function saveTeacherCanonicalFeedback(
    feedback: AttemptFeedback,
    markupDrawings?: PdfDrawings,
): Promise<{ status: "saved"; item: FeedbackEnvelope } | ActionFailure> {
    try {
        const gateway = await teacherContext(true);
        if ("status" in gateway) return gateway;
        const result = await saveTeacherFeedbackWithGateway(gateway.client, feedback, gateway.context, markupDrawings);
        if (result.status === "service_unavailable" && !isPlanEntitlementError(result)) {
            await reportServerError("feedback-save", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        if (result.status === "service_unavailable" && !isPlanEntitlementError(result)) {
            return { status: result.status, error: "피드백을 저장할 수 없습니다." };
        }
        return isPlanEntitlementError(result) ? planDenied() : result;
    } catch (error) {
        await reportServerError("feedback-save", error);
        return { status: "service_unavailable", error: "피드백을 저장할 수 없습니다." };
    }
}

export async function returnTeacherCanonicalFeedback(feedback: AttemptFeedback): Promise<
    { status: "returned"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await teacherContext(true);
        if ("status" in gateway) return gateway;
        const result = await returnTeacherFeedbackWithGateway(gateway.client, feedback, gateway.context);
        if (result.status === "service_unavailable" && !isPlanEntitlementError(result)) {
            await reportServerError("feedback-return", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        if (result.status === "service_unavailable" && !isPlanEntitlementError(result)) {
            return { status: result.status, error: "피드백을 반환할 수 없습니다." };
        }
        return isPlanEntitlementError(result) ? planDenied() : result;
    } catch (error) {
        await reportServerError("feedback-return", error);
        return { status: "service_unavailable", error: "피드백을 반환할 수 없습니다." };
    }
}

export async function listStudentCanonicalFeedback(): Promise<
    { status: "loaded"; items: FeedbackEnvelope[] } | ActionFailure
> {
    try {
        const gateway = await studentContext();
        if ("status" in gateway) return gateway;
        const result = await listStudentFeedbackWithGateway(
            gateway.client,
            gateway.session.organizationId,
            gateway.session.studentId,
        );
        if (result.status === "service_unavailable") {
            await reportServerError("feedback-read", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "피드백 목록을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("feedback-read", error);
        return { status: "service_unavailable", error: "피드백 목록을 불러올 수 없습니다." };
    }
}

export async function loadStudentCanonicalFeedback(attemptId: string): Promise<
    { status: "loaded"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await studentContext();
        if ("status" in gateway) return gateway;
        const result = await loadStudentFeedbackWithGateway(
            gateway.client,
            attemptId,
            gateway.session.organizationId,
            gateway.session.studentId,
        );
        if (result.status === "service_unavailable") {
            await reportServerError("feedback-read", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "피드백을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("feedback-read", error);
        return { status: "service_unavailable", error: "피드백을 불러올 수 없습니다." };
    }
}

export async function markStudentCanonicalFeedbackOpened(feedbackId: string): Promise<
    { status: "opened"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await studentContext();
        if ("status" in gateway) return gateway;
        const result = await markStudentFeedbackOpenedWithGateway(
            gateway.client,
            feedbackId,
            gateway.session.organizationId,
            gateway.session.studentId,
        );
        if (result.status === "service_unavailable") {
            await reportServerError("feedback-read", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "피드백 확인 상태를 저장할 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("feedback-read", error);
        return { status: "service_unavailable", error: "피드백 확인 상태를 저장할 수 없습니다." };
    }
}
