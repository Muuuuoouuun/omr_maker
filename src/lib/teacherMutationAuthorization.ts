import { canTeacherRoleWrite, type TeacherMemberRole } from "@/lib/teacherSession";

type TeacherMutationSession = {
    memberRole?: TeacherMemberRole;
} | null | undefined;

/**
 * Service-role mutations must fail closed when a signed session has no
 * workspace role. This also keeps legacy/mockup sessions read-only.
 */
export function isTeacherMutationAuthorized(session: TeacherMutationSession): boolean {
    return canTeacherRoleWrite(session?.memberRole);
}
