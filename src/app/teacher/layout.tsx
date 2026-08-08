import type { ReactNode } from "react";
import { cookies } from "next/headers";
import TeacherAuthGate from "@/components/TeacherAuthGate";
import { bootstrapWorkspaceWithServiceRole } from "@/lib/supabaseServerAdmin";
import { resolveAuthorizedTeacherSessionCookie, TEACHER_SERVER_SESSION_COOKIE } from "@/lib/teacherServerSession";
import { workspaceContextFromTeacherSession } from "@/lib/workspaceContext";

export default async function TeacherLayout({ children }: { children: ReactNode }) {
    const cookieStore = await cookies();
    const serverSession = await resolveAuthorizedTeacherSessionCookie(
        cookieStore.get(TEACHER_SERVER_SESSION_COOKIE)?.value,
        { allowMockup: true },
    );
    if (!serverSession) {
        return <TeacherAuthGate initialSession={null} requireServerSession>{null}</TeacherAuthGate>;
    }

    if (serverSession.sessionAuthority !== "mockup" && serverSession.sessionAuthority !== "account") {
        const bootstrapResult = await bootstrapWorkspaceWithServiceRole(workspaceContextFromTeacherSession(serverSession));
        if (!bootstrapResult.ok && !bootstrapResult.skipped) {
            console.warn("Teacher workspace bootstrap failed", bootstrapResult.error);
        }
    }

    return <TeacherAuthGate initialSession={serverSession}>{children}</TeacherAuthGate>;
}
