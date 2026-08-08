import type { TeacherIdentityMode } from "./teacherIdentityMode";

export type TeacherIdentityModeEnvironment = Readonly<{
    NODE_ENV?: string;
    OMR_TEACHER_IDENTITY_MODE?: string;
}>;

export function resolveTeacherIdentityModeForEnvironment(
    env: TeacherIdentityModeEnvironment,
): TeacherIdentityMode {
    if (env.NODE_ENV === "production") return "provisioned_only";

    return env.OMR_TEACHER_IDENTITY_MODE?.trim().toLowerCase() === "self_service"
        ? "self_service"
        : "provisioned_only";
}
