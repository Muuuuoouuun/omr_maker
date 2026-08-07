"use server";

import { cookies, headers } from "next/headers";
import {
    clearTeacherIndividualAssignmentWithGateway,
    loadTeacherIndividualAssignmentTargetCountsWithGateway,
    loadTeacherIndividualAssignmentWithGateway,
    saveTeacherIndividualAssignmentWithGateway,
    type ClearTeacherIndividualAssignmentInput,
    type ClearTeacherIndividualAssignmentResult,
    type IndividualAssignmentGatewayClient,
    type LoadTeacherIndividualAssignmentResult,
    type LoadTeacherIndividualAssignmentTargetCountsResult,
    type SaveTeacherIndividualAssignmentInput,
    type SaveTeacherIndividualAssignmentResult,
} from "@/lib/individualAssignmentGateway";
import { authorizePlanEntitlement } from "@/app/actions/premiumAccess";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import {
    resolveAuthorizedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { reportServerError } from "@/lib/reportServerError";

async function assignmentContext(requireWrite: boolean): Promise<
    | {
        client: IndividualAssignmentGatewayClient;
        context: ReturnType<typeof workspaceContextFromTeacherSession>;
    }
    | { status: "local_only" | "unauthorized" | "service_unavailable" }
> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = await resolveAuthorizedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
    );
    if (!session || (requireWrite && !isTeacherMutationAuthorized(session))) {
        return { status: "unauthorized" };
    }
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    return {
        client: createSupabaseAdminClient(config) as unknown as IndividualAssignmentGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

export async function loadTeacherIndividualAssignment(
    examId: string,
): Promise<LoadTeacherIndividualAssignmentResult | { status: "local_only" }> {
    try {
        const gateway = await assignmentContext(false);
        if ("status" in gateway) return gateway.status === "local_only" ? gateway : { status: gateway.status };
        return await loadTeacherIndividualAssignmentWithGateway(gateway.client, gateway.context, examId);
    } catch (error) {
        await reportServerError("teacher-individual-assignment-read", error);
        return { status: "service_unavailable" };
    }
}

export async function loadTeacherIndividualAssignmentTargetCounts(
    examIds: string[],
): Promise<LoadTeacherIndividualAssignmentTargetCountsResult | { status: "local_only" }> {
    try {
        const gateway = await assignmentContext(false);
        if ("status" in gateway) return gateway.status === "local_only" ? gateway : { status: gateway.status };
        return await loadTeacherIndividualAssignmentTargetCountsWithGateway(
            gateway.client,
            gateway.context,
            examIds,
        );
    } catch (error) {
        await reportServerError("teacher-individual-assignment-counts-read", error);
        return { status: "service_unavailable" };
    }
}

export async function saveTeacherIndividualAssignment(
    input: SaveTeacherIndividualAssignmentInput,
): Promise<SaveTeacherIndividualAssignmentResult | { status: "local_only" }> {
    try {
        const gateway = await assignmentContext(true);
        if ("status" in gateway) return gateway.status === "local_only" ? gateway : { status: gateway.status };
        if (input.mode === "retake") {
            const entitlement = await authorizePlanEntitlement("retakeAssignments");
            if (!entitlement.ok) return { status: "plan_denied" };
        }
        const result = await saveTeacherIndividualAssignmentWithGateway(gateway.client, gateway.context, input);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-individual-assignment-save", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-individual-assignment-save", error);
        return { status: "service_unavailable" };
    }
}

export async function clearTeacherIndividualAssignment(
    input: ClearTeacherIndividualAssignmentInput,
): Promise<ClearTeacherIndividualAssignmentResult | { status: "local_only" }> {
    try {
        const gateway = await assignmentContext(true);
        if ("status" in gateway) return gateway.status === "local_only" ? gateway : { status: gateway.status };
        const result = await clearTeacherIndividualAssignmentWithGateway(gateway.client, gateway.context, input);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-individual-assignment-clear", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-individual-assignment-clear", error);
        return { status: "service_unavailable" };
    }
}
