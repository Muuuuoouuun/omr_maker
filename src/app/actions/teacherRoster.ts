"use server";

import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    loadTeacherRosterWithGateway,
    saveTeacherRosterWithGateway,
    type TeacherRosterGatewayClient,
} from "@/lib/teacherRosterGateway";
import { resolveAuthorizedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { isTeacherMutationAuthorized } from "@/lib/teacherMutationAuthorization";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { authorizeRosterStudentSet } from "@/app/actions/premiumAccess";
import type { RosterSnapshot } from "@/lib/rosterPersistence";
import { reportServerError } from "@/lib/reportServerError";

type ActionContext = {
    client: TeacherRosterGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" };

async function actionContext(requireWrite = false): Promise<ActionContext> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = await resolveAuthorizedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    if (requireWrite && !isTeacherMutationAuthorized(session)) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    return {
        client: createSupabaseAdminClient(config) as unknown as TeacherRosterGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

export async function loadTeacherCanonicalRoster(): Promise<
    { status: "loaded"; snapshot: RosterSnapshot; revision: number }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        const result = await loadTeacherRosterWithGateway(gateway.client, gateway.context);
        if (result.status === "service_unavailable") {
            await reportServerError("teacher-roster-read", { status: result.status, code: "service_unavailable" });
            return { status: result.status, error: "학생 명단을 불러올 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-roster-read", error);
        return { status: "service_unavailable", error: "학생 명단을 불러올 수 없습니다." };
    }
}

export async function saveTeacherCanonicalRoster(snapshot: RosterSnapshot, expectedRevision: number | null): Promise<
    { status: "saved"; snapshot: RosterSnapshot; revision: number }
    | { status: "conflict" | "invalid_roster" | "local_only" | "unauthorized" | "service_unavailable" | "plan_denied"; error?: string }
> {
    try {
        const gateway = await actionContext(true);
        if ("status" in gateway) return gateway;
        const previous = await loadTeacherRosterWithGateway(gateway.client, gateway.context);
        if (previous.status !== "loaded") {
            await reportServerError("teacher-roster-save", {
                status: previous.status,
                code: "service_unavailable",
            });
            return { status: "service_unavailable", error: "학생 명단을 저장할 수 없습니다." };
        }

        const authorization = await authorizeRosterStudentSet(snapshot.students.map(student => student.id));
        if (!authorization.ok) {
            return { status: "plan_denied", error: authorization.error || "학생 등록 한도를 확인할 수 없습니다." };
        }

        const result = await saveTeacherRosterWithGateway(
            gateway.client,
            snapshot,
            gateway.context,
            expectedRevision,
        );
        const planDeniedByDatabase = result.status === "service_unavailable"
            && /plan student limit exceeded/i.test(result.error || "");
        if (result.status === "service_unavailable" && !planDeniedByDatabase) {
            await reportServerError("teacher-roster-save", {
                status: result.status,
                code: "service_unavailable",
            });
        }
        if (result.status !== "saved") {
            // Restore the separately synchronized plan ledger when the
            // downstream canonical roster write does not commit.
            await authorizeRosterStudentSet(previous.snapshot.students.map(student => student.id));
            if (
                planDeniedByDatabase
            ) {
                return { status: "plan_denied", error: "현재 플랜에서 학생 명단을 저장할 수 없습니다." };
            }
        }
        if (result.status === "service_unavailable") {
            return { status: result.status, error: "학생 명단을 저장할 수 없습니다." };
        }
        return result;
    } catch (error) {
        await reportServerError("teacher-roster-save", error);
        return { status: "service_unavailable", error: "학생 명단을 저장할 수 없습니다." };
    }
}
