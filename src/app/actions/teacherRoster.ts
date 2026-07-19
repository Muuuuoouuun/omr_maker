"use server";

import { cookies, headers } from "next/headers";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "@/lib/supabaseServerAdmin";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import {
    loadTeacherRosterWithGateway,
    saveTeacherRosterWithGateway,
    type TeacherRosterGatewayClient,
} from "@/lib/teacherRosterGateway";
import { parseSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { authorizeRosterStudentSet } from "@/app/actions/premiumAccess";
import type { RosterSnapshot } from "@/lib/rosterPersistence";

type ActionContext = {
    client: TeacherRosterGatewayClient;
    context: ReturnType<typeof workspaceContextFromTeacherSession>;
} | { status: "local_only" | "unauthorized" | "service_unavailable" };

async function actionContext(): Promise<ActionContext> {
    const headerStore = await headers();
    if (!isSameOriginServerActionRequest(headerStore)) return { status: "unauthorized" };
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) return { status: "unauthorized" };
    const config = getSupabaseServerConfigFromEnv();
    if (!config) return { status: process.env.NODE_ENV === "production" ? "service_unavailable" : "local_only" };
    return {
        client: createSupabaseAdminClient(config) as unknown as TeacherRosterGatewayClient,
        context: workspaceContextFromTeacherSession(session),
    };
}

export async function loadTeacherCanonicalRoster(): Promise<
    { status: "loaded"; snapshot: RosterSnapshot }
    | { status: "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return loadTeacherRosterWithGateway(gateway.client, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Roster load failed" };
    }
}

export async function saveTeacherCanonicalRoster(snapshot: RosterSnapshot): Promise<
    { status: "saved"; snapshot: RosterSnapshot }
    | { status: "invalid_roster" | "local_only" | "unauthorized" | "service_unavailable" | "plan_denied"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        const previous = await loadTeacherRosterWithGateway(gateway.client, gateway.context);
        if (previous.status !== "loaded") return previous;

        const authorization = await authorizeRosterStudentSet(snapshot.students.map(student => student.id));
        if (!authorization.ok) {
            return { status: "plan_denied", error: authorization.error || "학생 등록 한도를 확인할 수 없습니다." };
        }

        const result = await saveTeacherRosterWithGateway(gateway.client, snapshot, gateway.context);
        if (result.status !== "saved") {
            // Restore the separately synchronized plan ledger when the
            // downstream canonical roster write does not commit.
            await authorizeRosterStudentSet(previous.snapshot.students.map(student => student.id));
            if (
                result.status === "service_unavailable"
                && /plan student limit exceeded/i.test(result.error || "")
            ) {
                return { status: "plan_denied", error: result.error };
            }
        }
        return result;
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Roster save failed" };
    }
}
