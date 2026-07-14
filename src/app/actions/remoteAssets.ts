"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    isRemoteAssetStoredDataRef,
    isRemoteAssetUploadByteSizeAllowed,
    remoteAssetStoredDataRef,
    type RemoteAssetKind,
    type RemoteAssetStoredDataRef,
} from "@/lib/remoteAssetContract.server";
import {
    createStaffRemoteAssetSignedUrlWithGateway,
    uploadRemoteAssetWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "@/lib/remoteAssetGateway.server";
import type { StoredDataRef } from "@/types/omr";
import { parseStudentAttemptTicket } from "@/lib/studentAttemptTicket";
import type { PdfDrawings } from "@/types/omr";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

export type TeacherRemoteAssetUploadResult =
    | { status: "uploaded"; ref: RemoteAssetStoredDataRef }
    | { status: "local_only" }
    | { status: "unauthorized" | "invalid_asset" | "service_unavailable"; error?: string };

function uploadKind(value: FormDataEntryValue | null): RemoteAssetKind | null {
    return value === "problem_pdf" || value === "answer_key_pdf" ? value : null;
}

export async function uploadTeacherExamAsset(
    formData: FormData,
): Promise<TeacherRemoteAssetUploadResult> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };

    const cookieStore = await cookies();
    const teacherSession = parseSignedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!teacherSession) return { status: "unauthorized" };

    const config = getSupabaseServerConfigFromEnv();
    if (!config) {
        return process.env.NODE_ENV === "production"
            ? { status: "service_unavailable", error: "Remote asset storage is not configured" }
            : { status: "local_only" };
    }

    const file = formData.get("file");
    const kind = uploadKind(formData.get("kind"));
    const examId = String(formData.get("examId") || "").trim();
    if (
        !(file instanceof File)
        || !kind
        || !examId
        || !isRemoteAssetUploadByteSizeAllowed(kind, file.size)
    ) return { status: "invalid_asset" };

    try {
        const context = workspaceContextFromTeacherSession(teacherSession);
        const result = await uploadRemoteAssetWithGateway(
            createSupabaseAdminClient(config) as unknown as RemoteAssetSupabaseGatewayClient,
            {
                organizationId: context.organizationId,
                kind,
                examId,
                body: new Uint8Array(await file.arrayBuffer()),
                originalName: file.name,
                createdByUserId: context.actorUserId,
            },
        );
        if (result.status !== "uploaded") {
            return {
                status: result.status === "invalid_asset" ? "invalid_asset" : "service_unavailable",
                error: result.error,
            };
        }
        return { status: "uploaded", ref: remoteAssetStoredDataRef(result.asset) };
    } catch (error) {
        return {
            status: "service_unavailable",
            error: error instanceof Error ? error.message : "Remote asset upload failed",
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
    const teacherSession = parseSignedTeacherSessionCookie(
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
    ticket: string;
    attemptId: string;
    drawings: PdfDrawings;
}): Promise<
    { status: "uploaded"; ref: RemoteAssetStoredDataRef }
    | { status: "invalid_ticket" | "invalid_asset" | "service_unavailable" }
> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "invalid_ticket" };
    const ticket = parseStudentAttemptTicket(input.ticket);
    if (!ticket || input.attemptId !== `attempt_${ticket.ticketId}`) return { status: "invalid_ticket" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: "service_unavailable" };

    try {
        const body = new TextEncoder().encode(JSON.stringify(input.drawings));
        const client = createSupabaseAdminClient(config) as unknown as RemoteAssetSupabaseGatewayClient & {
            rpc(name: string, params: Record<string, unknown>): Promise<{
                data: unknown;
                error: { message?: string } | null;
            }>;
        };
        const uploaded = await uploadRemoteAssetWithGateway(client, {
            organizationId: ticket.organizationId,
            kind: "attempt_handwriting",
            attemptId: input.attemptId,
            body,
            originalName: `${input.attemptId}-handwriting.json`,
        });
        if (uploaded.status !== "uploaded") {
            return { status: uploaded.status === "invalid_asset" ? "invalid_asset" : "service_unavailable" };
        }
        const ref = remoteAssetStoredDataRef(uploaded.asset);
        const attached = await client.rpc("omr_attach_attempt_handwriting_v1", {
            p_ticket_id: ticket.ticketId,
            p_asset_id: uploaded.asset.id,
            p_ref: ref,
        });
        if (attached.error) return { status: "service_unavailable" };
        return { status: "uploaded", ref };
    } catch {
        return { status: "service_unavailable" };
    }
}
