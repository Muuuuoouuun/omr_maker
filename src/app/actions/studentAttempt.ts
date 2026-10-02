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
    createSignedStudentSessionCookie,
    resolveAuthorizedStudentSessionCookie,
    STUDENT_SERVER_SESSION_COOKIE,
    shouldUseSecureStudentSessionCookie,
    type StudentServerIdentity,
} from "@/lib/studentServerSession";
import { parseStudentAttemptTicket } from "@/lib/studentAttemptTicket";
import { isRemoteAssetStoredDataRef } from "@/lib/remoteAssetContract.server";
import {
    createStudentProblemPdfSignedUrlWithGateway,
    type RemoteAssetSupabaseGatewayClient,
} from "@/lib/remoteAssetGateway.server";
import { reportServerError } from "@/lib/reportServerError";

function getGatewayClient(): StudentExamGatewayClient | null {
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return null;
    return createSupabaseAdminClient(config) as unknown as StudentExamGatewayClient;
}

function unavailableGatewayStatus(): "local_only" | "service_unavailable" {
    return process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only";
}

async function bindGuestSessionToAttemptTicket(
    headerStore: Headers,
    cookieStore: Awaited<ReturnType<typeof cookies>>,
    session: StudentServerIdentity | null,
    result: Extract<StudentExamAccessResult, { status: "allowed" }>,
): Promise<boolean> {
    if (session?.kind !== "guest") return true;
    if (result.exam.access.type !== "public") return false;
    const claims = parseStudentAttemptTicket(result.ticket);
    const guestId = session.guestId?.trim() || "";
    if (
        !claims
        || claims.identityType !== "guest"
        || !guestId
        || claims.guestId !== guestId
        || claims.studentId !== session.studentId
        || claims.studentName !== session.name
        || claims.examId !== result.exam.id
    ) return false;
    if (session.organizationId) return session.organizationId === claims.organizationId;

    const value = createSignedStudentSessionCookie({
        kind: "guest",
        guestId,
        organizationId: claims.organizationId,
        name: session.name,
        identityType: "guest",
    }, process.env, session.issuedAt);
    if (!value) return false;
    try {
        cookieStore.set(STUDENT_SERVER_SESSION_COOKIE, value, {
            httpOnly: true,
            sameSite: "lax",
            secure: shouldUseSecureStudentSessionCookie(headerStore.get("host")),
            path: "/",
            maxAge: Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)),
        });
        return true;
    } catch {
        return false;
    }
}

export async function previewStudentExam(examId: string): Promise<StudentExamPreviewResult> {
    try {
        const headerStore = await headers();
        if (!isSameOriginServerActionRequest(headerStore)) return { status: "service_unavailable" };
        const client = getGatewayClient();
        if (!client) return { status: unavailableGatewayStatus() };
        return await previewStudentExamWithGateway(client, examId);
    } catch (error) {
        await reportServerError("student-exam-read", error);
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
        const validation = await resolveAuthorizedStudentSessionCookie(
            cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
            client,
        );
        if (validation.status === "service_unavailable") return { status: "service_unavailable" };
        if (validation.status !== "active") return { status: "login_required" };
        const studentSession = validation.identity;
        const verifiedIdentity = studentSession.kind === "guest"
            ? {
                organizationId: studentSession.organizationId || undefined,
                studentId: studentSession.studentId,
                studentName: studentSession.studentName,
                identityType: "guest" as const,
                guestId: studentSession.guestId || "",
                groupId: studentSession.groupId,
                groupName: studentSession.groupName,
            }
            : {
                organizationId: studentSession.organizationId,
                studentId: studentSession.studentId,
                studentName: studentSession.studentName,
                identityType: studentSession.identityType === "registered" ? "registered" as const : "temporary" as const,
                groupId: studentSession.groupId,
                groupName: studentSession.groupName,
            };
        const result = await openStudentExamWithGateway(client, input, process.env, Date.now(), verifiedIdentity);
        if (result.status !== "allowed") {
            if (result.status === "service_unavailable") {
                await reportServerError("student-exam-open", {
                    status: result.status,
                    code: "service_unavailable",
                });
            }
            return result;
        }
        if (!await bindGuestSessionToAttemptTicket(headerStore, cookieStore, studentSession, result)) {
            return { status: "service_unavailable" };
        }

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
    } catch (error) {
        await reportServerError("student-exam-open", error);
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
        const claims = parseStudentAttemptTicket(submission.ticket);
        if (!claims) return { status: "invalid_ticket" };
        const cookieStore = await cookies();
        const validation = await resolveAuthorizedStudentSessionCookie(
            cookieStore.get(STUDENT_SERVER_SESSION_COOKIE)?.value,
            client,
        );
        if (validation.status === "service_unavailable") return { status: "service_unavailable" };
        if (validation.status !== "active") return { status: "invalid_ticket" };
        const session = validation.identity;
        if (
            claims.organizationId !== session.organizationId
            || claims.studentId !== session.studentId
            || claims.identityType !== session.identityType
            || (session.kind === "guest" && claims.guestId !== session.guestId)
        ) return { status: "invalid_ticket" };
        const result = await submitStudentAttemptWithGateway(client, submission);
        if (result.status === "service_unavailable") {
            await reportServerError("student-submit", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        return result;
    } catch (error) {
        await reportServerError("student-submit", error);
        return { status: "service_unavailable" };
    }
}
