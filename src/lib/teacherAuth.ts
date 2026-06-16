import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const TEACHER_AUTH_ERROR = "비밀번호가 올바르지 않습니다.";

type TeacherAuthEnv = {
    NODE_ENV?: string;
    TEACHER_PASSWORD?: string;
};

export function resolveTeacherPassword(env: TeacherAuthEnv = process.env): string | null {
    const configuredPassword = env.TEACHER_PASSWORD?.trim();
    if (configuredPassword) return configuredPassword;
    return env.NODE_ENV === "production" ? null : "admin123";
}

function digest(value: string): Buffer {
    return createHash("sha256").update(value, "utf8").digest();
}

export function verifyTeacherPasswordValue(
    password: unknown,
    env: TeacherAuthEnv = process.env,
): boolean {
    if (typeof password !== "string") return false;
    const expectedPassword = resolveTeacherPassword(env);
    if (!expectedPassword) return false;

    return timingSafeEqual(digest(password), digest(expectedPassword));
}

export function mintTeacherToken(now = Date.now()): string {
    const timestamp = now.toString(36);
    const randomHex = randomBytes(16).toString("hex");
    return `tkn_${timestamp}_${randomHex}`;
}
