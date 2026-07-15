import type { ReactNode } from "react";
import { cookies } from "next/headers";
import TeacherAuthGate from "@/components/TeacherAuthGate";
import { bootstrapWorkspaceWithServiceRole } from "@/lib/supabaseServerAdmin";
import { parseSignedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";
import { isMockupTeacherIdentity } from "@/lib/mockupAccount";

export default async function TeacherLayout({ children }: { children: ReactNode }) {
    const cookieStore = await cookies();
    const serverSession = parseSignedTeacherSessionCookie(cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value);
    if (!serverSession) {
        return <TeacherAuthGate initialSession={null} requireServerSession>{null}</TeacherAuthGate>;
    }

    if (!isMockupTeacherIdentity(serverSession)) {
        const bootstrapResult = await bootstrapWorkspaceWithServiceRole(workspaceContextFromTeacherSession(serverSession));
        if (!bootstrapResult.ok && !bootstrapResult.skipped) {
            console.warn("Teacher workspace bootstrap failed", bootstrapResult.error);
        }
    }

    return <TeacherAuthGate initialSession={serverSession}>{children}</TeacherAuthGate>;
}
