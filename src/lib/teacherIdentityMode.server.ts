import "next/dist/compiled/server-only";

import type { TeacherIdentityMode } from "./teacherIdentityMode";
import {
    resolveTeacherIdentityModeForEnvironment,
    type TeacherIdentityModeEnvironment,
} from "./teacherIdentityModePolicy";

export function resolveTeacherIdentityMode(
    env: TeacherIdentityModeEnvironment = process.env,
): TeacherIdentityMode {
    return resolveTeacherIdentityModeForEnvironment(env);
}
