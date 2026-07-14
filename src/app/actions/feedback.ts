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
    parseSignedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    type StudentServerSession,
} from "@/lib/studentServerSession";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import { workspaceContextFromTeacherSession, type WorkspaceContext } from "@/lib/workspaceContext";
import type { AttemptFeedback, PdfDrawings } from "@/types/omr";

type ActionFailure = {
    status: "local_only" | "unauthorized" | "not_found" | "invalid_feedback" | "service_unavailable";
    error?: string;
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

async function teacherContext(): Promise<TeacherActionContext> {
    if (!isSameOriginServerActionRequest(await headers())) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return unavailable();
    return {
        client: createSupabaseAdminClient(config) as unknown as FeedbackGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

async function studentContext(): Promise<StudentActionContext> {
    if (!isSameOriginServerActionRequest(await headers())) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = parseSignedStudentSessionCookie(cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return unavailable();
    return {
        client: createSupabaseAdminClient(config) as unknown as FeedbackGatewayClient,
        session,
    };
}

export async function loadTeacherCanonicalFeedback(attemptId: string): Promise<
    { status: "loaded"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await teacherContext();
        if ("status" in gateway) return gateway;
        return loadTeacherFeedbackWithGateway(gateway.client, attemptId, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Feedback load failed" };
    }
}

export async function saveTeacherCanonicalFeedback(
    feedback: AttemptFeedback,
    markupDrawings?: PdfDrawings,
): Promise<{ status: "saved"; item: FeedbackEnvelope } | ActionFailure> {
    try {
        const gateway = await teacherContext();
        if ("status" in gateway) return gateway;
        return saveTeacherFeedbackWithGateway(gateway.client, feedback, gateway.context, markupDrawings);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Feedback save failed" };
    }
}

export async function returnTeacherCanonicalFeedback(feedbackId: string): Promise<
    { status: "returned"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await teacherContext();
        if ("status" in gateway) return gateway;
        return returnTeacherFeedbackWithGateway(gateway.client, feedbackId, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Feedback return failed" };
    }
}

export async function listStudentCanonicalFeedback(): Promise<
    { status: "loaded"; items: FeedbackEnvelope[] } | ActionFailure
> {
    try {
        const gateway = await studentContext();
        if ("status" in gateway) return gateway;
        return listStudentFeedbackWithGateway(
            gateway.client,
            gateway.session.organizationId,
            gateway.session.studentId,
        );
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Feedback list failed" };
    }
}

export async function loadStudentCanonicalFeedback(attemptId: string): Promise<
    { status: "loaded"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await studentContext();
        if ("status" in gateway) return gateway;
        return loadStudentFeedbackWithGateway(
            gateway.client,
            attemptId,
            gateway.session.organizationId,
            gateway.session.studentId,
        );
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Feedback load failed" };
    }
}

export async function markStudentCanonicalFeedbackOpened(feedbackId: string): Promise<
    { status: "opened"; item: FeedbackEnvelope } | ActionFailure
> {
    try {
        const gateway = await studentContext();
        if ("status" in gateway) return gateway;
        return markStudentFeedbackOpenedWithGateway(
            gateway.client,
            feedbackId,
            gateway.session.organizationId,
            gateway.session.studentId,
        );
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Feedback receipt failed" };
    }
}
