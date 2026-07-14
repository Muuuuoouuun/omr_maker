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
    | { status: "invalid_roster" | "local_only" | "unauthorized" | "service_unavailable"; error?: string }
> {
    try {
        const gateway = await actionContext();
        if ("status" in gateway) return gateway;
        return saveTeacherRosterWithGateway(gateway.client, snapshot, gateway.context);
    } catch (error) {
        return { status: "service_unavailable", error: error instanceof Error ? error.message : "Roster save failed" };
    }
}
