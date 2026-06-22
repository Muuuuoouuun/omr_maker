import { createHmac, timingSafeEqual } from "node:crypto";
import { createTeacherSession, isTeacherSessionActive, type TeacherSession, type TeacherSessionIdentity } from "@/lib/teacherSession";

export const TEACHER_SERVER_SESSION_COOKIE = "omr_teacher_server_session";
export const TEACHER_SERVER_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;

type Env = Record<string, string | undefined>;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveTeacherSessionSecret(env: Env = process.env): string | null {
    const explicitSecret = clean(env.TEACHER_SESSION_SECRET) || clean(env.OMR_TEACHER_SESSION_SECRET);
    if (explicitSecret) return explicitSecret;

    const credentialSecret = clean(env.TEACHER_PASSWORD)
        || clean(env.TEACHER_ACCOUNTS)
        || clean(env.OMR_TEACHER_ACCOUNTS);
    if (credentialSecret) return credentialSecret;

    return env.NODE_ENV === "production" ? null : "dev-teacher-session-secret";
}

export function shouldUseSecureTeacherSessionCookie(
    hostHeader: string | null | undefined,
    env: Env = process.env,
): boolean {
    const localE2eOverride = clean(env.OMR_ALLOW_INSECURE_TEACHER_COOKIE_FOR_LOCAL_E2E).toLowerCase();
    if (localE2eOverride === "1" || localE2eOverride === "true") return false;
    if (env.NODE_ENV !== "production") return false;

    const host = clean(hostHeader).toLowerCase().split(",")[0]?.trim() || "";
    if (!host) return true;

    const hostname = host.startsWith("[")
        ? host.slice(1, host.indexOf("]"))
        : host.split(":")[0];

    return hostname !== "localhost"
        && hostname !== "127.0.0.1"
        && hostname !== "::1"
        && !hostname.endsWith(".localhost");
}

function base64UrlEncode(value: string): string {
    return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
    return Buffer.from(value, "base64url").toString("utf8");
}

function signPayload(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createSignedTeacherSessionCookie(
    token: string,
    identity: TeacherSessionIdentity | undefined,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveTeacherSessionSecret(env);
    if (!secret) return null;

    const session = createTeacherSession(token, now, identity);
    const payload = base64UrlEncode(JSON.stringify(session));
    return `${payload}.${signPayload(payload, secret)}`;
}

export function parseSignedTeacherSessionCookie(
    rawCookie: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): TeacherSession | null {
    if (!rawCookie) return null;
    const secret = resolveTeacherSessionSecret(env);
    if (!secret) return null;

    const [payload, signature, ...rest] = rawCookie.split(".");
    if (!payload || !signature || rest.length > 0) return null;
    const expectedSignature = signPayload(payload, secret);
    if (!signaturesMatch(signature, expectedSignature)) return null;

    try {
        const parsed = JSON.parse(base64UrlDecode(payload)) as TeacherSession;
        return isTeacherSessionActive(parsed, now) ? parsed : null;
    } catch {
        return null;
    }
}
