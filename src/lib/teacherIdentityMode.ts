export type TeacherIdentityMode = "provisioned_only" | "self_service";

type TeacherIdentityModeEnv = Readonly<{
    NODE_ENV?: string;
    OMR_TEACHER_IDENTITY_MODE?: string;
}>;

export function resolveTeacherIdentityMode(
    env: TeacherIdentityModeEnv = process.env,
): TeacherIdentityMode {
    if (env.NODE_ENV === "production") return "provisioned_only";

    return env.OMR_TEACHER_IDENTITY_MODE?.trim().toLowerCase() === "self_service"
        ? "self_service"
        : "provisioned_only";
}
