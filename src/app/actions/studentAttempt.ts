"use server";

import { cookies, headers } from "next/headers";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";
import {
    openStudentExamWithGateway,
    previewStudentExamWithGateway,
    submitStudentAttemptWithGateway,
    type StudentAttemptSubmitResult,
    type StudentExamGatewayClient,
} from "@/lib/studentExamServerGateway";
import type {
    StudentAttemptSubmission,
    StudentExamAccessInput,
    StudentExamAccessResult,
    StudentExamPreviewResult,
} from "@/lib/studentExamContract";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    parseSignedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
} from "@/lib/studentServerSession";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import {
    createStudentProblemPdfSignedUrlWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "@/lib/remoteAssetGateway.server";

function getGatewayClient(): StudentExamGatewayClient | null {
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return null;
    return createSupabaseAdminClient(config) as unknown as StudentExamGatewayClient;
}

function unavailableGatewayStatus(): "local_only" | "service_unavailable" {
    return process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only";
}

export async function previewStudentExam(examId: string): Promise<StudentExamPreviewResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "service_unavailable" };
        const client = getGatewayClient();
        if (!client) return { status: unavailableGatewayStatus() };
        return await previewStudentExamWithGateway(client, examId);
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function openStudentExam(
    input: StudentExamAccessInput,
): Promise<StudentExamAccessResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "service_unavailable" };
        const client = getGatewayClient();
        if (!client) return { status: unavailableGatewayStatus() };
        const cookieStore = await cookies();
        const studentSession = parseSignedStudentSessionCookie(
            cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
        );
        const result = await openStudentExamWithGateway(client, input, process.env, Date.now(), studentSession);
        if (result.status !== "allowed") return result;

        const problemRef = result.exam.pdfDataRef;
        if (!isRemoteAssetStoredDataRef(problemRef)) return result;
        if (problemRef.kind !== "problem_pdf" || problemRef.examId !== result.exam.id) {
            return { status: "service_unavailable" };
        }
        const signed = await createStudentProblemPdfSignedUrlWithGateway(
            client as unknown as RemoteAssetSupabaseGatewayClient,
            {
                assetId: problemRef.key,
                organizationId: problemRef.organizationId,
                examId: result.exam.id,
            },
        );
        if (signed.status !== "signed") return { status: "service_unavailable" };
        return {
            ...result,
            exam: {
                ...result.exam,
                pdfData: signed.signedUrl,
                pdfDataRef: undefined,
            },
        };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function submitStudentAttempt(
    submission: StudentAttemptSubmission,
): Promise<StudentAttemptSubmitResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "service_unavailable" };
        const client = getGatewayClient();
        if (!client) return { status: "service_unavailable" };
        return await submitStudentAttemptWithGateway(client, submission);
    } catch {
        return { status: "service_unavailable" };
    }
}
