"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
    type SupabaseAdminReadClientLike,
} from "@/lib/supabaseServerAdmin";
import {
    isRemoteAssetStoredDataRef,
    remoteAssetStoredDataRef,
    type RemoteAssetStoredDataRef,
    type TeacherRemoteAssetUploadDeclaration,
} from "@/lib/remoteAssetContract.server";
import {
    createStaffRemoteAssetSignedUrlWithGateway,
    finalizeTeacherRemoteAssetUploadWithGateway,
    prepareTeacherRemoteAssetUploadWithGateway,
    type RemoteAssetSupabaseGatewayClient,
    type TeacherRemoteAssetFinalizeInput,
    type TeacherRemoteAssetPreparedUpload,
    type TeacherUploadPublicErrorCode,
} from "@/lib/remoteAssetGateway.server";
import type { StoredDataRef } from "@/types/omr";
import type { PdfDrawings } from "@/types/omr";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import {
    resolveAuthorizedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
} from "@/lib/studentServerSession";
import { ownerStudentId } from "@/lib/studentExamCore";
import { archiveStudentAttemptHandwritingWithGateway } from "@/lib/studentAttemptHandwritingGateway.server";

export type TeacherRemoteAssetPrepareActionResult =
    | TeacherRemoteAssetPreparedUpload
    | { status: "local_only" }
    | {
        status: "unauthorized" | "invalid_asset" | "service_unavailable";
        error?: string;
        errorCode?: TeacherUploadPublicErrorCode;
    };

export type TeacherRemoteAssetFinalizeActionResult =
    | { status: "uploaded"; ref: RemoteAssetStoredDataRef }
    | {
        status: "unauthorized" | "invalid_asset" | "service_unavailable";
        error?: string;
        errorCode?: TeacherUploadPublicErrorCode;
    };

type TeacherPrepareInput = Omit<TeacherRemoteAssetUploadDeclaration, "organizationId" | "createdByUserId">;
type TeacherFinalizeInput = Omit<TeacherRemoteAssetFinalizeInput, "organizationId" | "createdByUserId">;

async function authorizedTeacherAssetGateway(): Promise<
    | {
        client: RemoteAssetSupabaseGatewayClient;
        context: ReturnType<typeof workspaceContextFromTeacherSession>;
    }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const teacherSession = await resolveAuthorizedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!teacherSession) return { status: "unauthorized" };
    if (!isTeacherMutationAuthorized(teacherSession)) return { status: "unauthorized" };

    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return process.env.NODE_ENV === "production"
            ? { status: "service_unavailable", error: "Remote asset storage is not configured" }
            : { status: "local_only" };
    }
    return {
        client: createSupabaseAdminClient(config) as unknown as RemoteAssetSupabaseGatewayClient,
        context: workspaceContextFromTeacherSession(teacherSession),
    };
}

export async function prepareTeacherExamAssetUpload(
    input: TeacherPrepareInput,
): Promise<TeacherRemoteAssetPrepareActionResult> {
    try {
        const gateway = await authorizedTeacherAssetGateway();
        if ("status" in gateway) return gateway;
        const result = await prepareTeacherRemoteAssetUploadWithGateway(
            gateway.client,
            {
                ...input,
                organizationId: gateway.context.organizationId,
                createdByUserId: gateway.context.actorUserId,
            },
            { identity: gateway.context },
        );
        return result.status === "prepared"
            ? result
            : {
                status: result.status === "invalid_asset" ? "invalid_asset" : "service_unavailable",
                error: result.error,
                errorCode: result.errorCode,
            };
    } catch {
        return {
            status: "service_unavailable",
            error: "Teacher upload service unavailable",
            errorCode: "upload_unavailable",
        };
    }
}

export async function finalizeTeacherExamAssetUpload(
    input: TeacherFinalizeInput,
): Promise<TeacherRemoteAssetFinalizeActionResult> {
    try {
        const gateway = await authorizedTeacherAssetGateway();
        if ("status" in gateway) {
            return {
                status: gateway.status === "local_only" ? "service_unavailable" : gateway.status,
                error: gateway.error,
            };
        }
        const result = await finalizeTeacherRemoteAssetUploadWithGateway(
            gateway.client,
            {
                ...input,
                organizationId: gateway.context.organizationId,
                createdByUserId: gateway.context.actorUserId,
            },
            { identity: gateway.context },
        );
        return result.status === "finalized"
            ? { status: "uploaded", ref: remoteAssetStoredDataRef(result.asset) }
            : {
                status: result.status === "invalid_object" ? "invalid_asset" : "service_unavailable",
                error: result.error,
                errorCode: result.errorCode,
            };
    } catch {
        return {
            status: "service_unavailable",
            error: "Teacher upload service unavailable",
            errorCode: "upload_unavailable",
        };
    }
}

export async function getTeacherRemoteAssetUrl(
    ref: StoredDataRef,
): Promise<{ status: "signed"; signedUrl: string } | { status: "not_found" | "unauthorized" | "service_unavailable" }> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore) || !isRemoteAssetStoredDataRef(ref)) {
        return { status: "unauthorized" };
    }
    const cookieStore = await cookies();
    const teacherSession = await resolveAuthorizedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!teacherSession) return { status: "unauthorized" };
    const context = workspaceContextFromTeacherSession(teacherSession);
    if (ref.organizationId !== context.organizationId) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "service_unavailable" };

    const signed = await createStaffRemoteAssetSignedUrlWithGateway(
        createSupabaseAdminClient(config) as unknown as RemoteAssetSupabaseGatewayClient,
        {
            assetId: ref.key,
            organizationId: ref.organizationId,
            kind: ref.kind,
            examId: ref.examId,
            attemptId: ref.attemptId,
        },
    );
    return signed.status === "signed"
        ? { status: "signed", signedUrl: signed.signedUrl }
        : { status: signed.status === "not_found" ? "not_found" : "service_unavailable" };
}

export async function uploadStudentAttemptHandwriting(input: {
    sessionId?: string;
    attemptId: string;
    drawings: PdfDrawings;
}): Promise<
    { status: "uploaded"; ref: RemoteAssetStoredDataRef }
    | { status: "invalid_ticket" | "invalid_asset" | "service_unavailable" }
> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "invalid_ticket" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "service_unavailable" };

    try {
        const client = createSupabaseAdminClient(config) as unknown as RemoteAssetSupabaseGatewayClient
            & SupabaseAdminReadClientLike
            & {
                rpc(name: string, params: Record<string, unknown>): Promise<{
                    data: unknown;
                    error: { message?: string } | null;
                }>;
            };
        let organizationId = "";
        let exactOwnerStudentId = "";
        let attachmentTicketId = "";
        if (input.sessionId) {
            const cookieStore = await cookies();
            const validation = await resolveAuthorizedStudentSessionCookie(
                cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
                client,
            );
            if (validation.status === "service_unavailable") return { status: "service_unavailable" };
            if (validation.status !== "active" || !validation.identity.organizationId) {
                return { status: "invalid_ticket" };
            }
            const identity = validation.identity;
            const sessionRead = await client.from("omr_attempt_sessions")
                .select("organization_id,owner_student_id,status,submission_id,submitted_attempt_id")
                .eq("id", input.sessionId.trim())
                .eq("organization_id", identity.organizationId)
                .eq("owner_student_id", ownerStudentId(identity))
                .maybeSingle();
            const session = sessionRead.data as {
                organization_id?: unknown;
                status?: unknown;
                submission_id?: unknown;
                submitted_attempt_id?: unknown;
            } | null;
            if (
                sessionRead.error || !session
                || session.status !== "submitted"
                || session.submitted_attempt_id !== input.attemptId
                || typeof session.organization_id !== "string"
                || typeof session.submission_id !== "string"
            ) return { status: "invalid_ticket" };
            organizationId = session.organization_id;
            exactOwnerStudentId = ownerStudentId(identity);
            attachmentTicketId = session.submission_id;
        } else return { status: "invalid_ticket" };
        const body = new TextEncoder().encode(JSON.stringify(input.drawings));
        const archived = await archiveStudentAttemptHandwritingWithGateway(client, {
            sessionId: input.sessionId,
            organizationId,
            ownerStudentId: exactOwnerStudentId,
            attemptId: input.attemptId,
            attachmentTicketId,
            body,
            originalName: `${input.attemptId}-handwriting.json`,
        });
        return archived;
    } catch {
        return { status: "service_unavailable" };
    }
}
