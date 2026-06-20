"use server";

import { cookies } from "next/headers";
import { bootstrapWorkspaceWithServiceRole } from "@/lib/supabaseServerAdmin";
import {
    parseSignedTeacherSessionCookie,
    TEACHER_SERVER_SESSION_COOKIE,
} from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

export async function bootstrapCurrentTeacherWorkspace(): Promise<{
    success: boolean;
    skipped?: boolean;
    organizationId?: string;
    error?: string;
}> {
    const cookieStore = await cookies();
    const session = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!session) {
        return {
            success: false,
            error: "교사 세션을 확인할 수 없습니다.",
        };
    }

    const context = workspaceContextFromTeacherSession(session);
    const result = await bootstrapWorkspaceWithServiceRole(context);
    return {
        success: result.ok,
        skipped: result.skipped,
        organizationId: context.organizationId,
        error: result.error,
    };
}
