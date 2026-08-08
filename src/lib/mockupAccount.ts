import type { TeacherLoginIdentity } from "@/lib/teacherAuth";
import type { TeacherSession, TeacherSessionIdentity } from "@/lib/teacherSession";

export const MOCKUP_TEACHER_ID = "omr-showcase";

export const MOCKUP_TEACHER_IDENTITY: TeacherLoginIdentity = {
    teacherId: MOCKUP_TEACHER_ID,
    email: "demo@omrmaker.kr",
    displayName: "김하늘 선생님",
    plan: "academy",
};

type TeacherIdentityLike = Partial<TeacherSessionIdentity> | Partial<TeacherSession> | null | undefined;

export function isMockupTeacherIdentity(identity: TeacherIdentityLike): boolean {
    return identity?.teacherId?.trim().toLowerCase() === MOCKUP_TEACHER_ID;
}

export function isExactMockupTeacherIdentity(identity: TeacherIdentityLike): boolean {
    return identity?.teacherId === MOCKUP_TEACHER_IDENTITY.teacherId
        && identity.email === MOCKUP_TEACHER_IDENTITY.email
        && identity.displayName === MOCKUP_TEACHER_IDENTITY.displayName
        && identity.plan === MOCKUP_TEACHER_IDENTITY.plan
        && identity.organizationId === undefined
        && identity.organizationName === undefined
        && identity.memberRole === undefined
        && identity.accountSessionGeneration === undefined;
}
