import { createHmac, timingSafeEqual } from "node:crypto";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";

export const STUDENT_SERVER_SESSION_COOKIE = "omr_student_server_session";
export const STUDENT_SERVER_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const STUDENT_SERVER_SESSION_CLOCK_SKEW_MS = 30 * 1000;

type Env = Record<string, string | undefined>;

export interface StudentServerSession extends VerifiedStudentIdentity {
    audience: "omr-student";
    schemaVersion: 1;
    issuedAt: number;
    expiresAt: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveStudentSessionSecret(env: Env = process.env): string | null {
    const explicit = clean(env.STUDENT_SESSION_SECRET) || clean(env.OMR_STUDENT_SESSION_SECRET);
    if (explicit) return explicit;

    const attemptSecret = clean(env.STUDENT_ATTEMPT_SECRET) || clean(env.OMR_STUDENT_ATTEMPT_SECRET);
    if (attemptSecret) return attemptSecret;
    return env.NODE_ENV === "production" ? null : "dev-student-session-secret";
}

function sign(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createSignedStudentSessionCookie(
    identity: VerifiedStudentIdentity,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveStudentSessionSecret(env);
    const organizationId = clean(identity.organizationId);
    const studentId = clean(identity.studentId);
    const studentName = clean(identity.studentName);
    if (!secret || !organizationId || !studentId || !studentName) return null;

    const session: StudentServerSession = {
        audience: "omr-student",
        schemaVersion: 1,
        organizationId,
        studentId,
        studentName,
        identityType: identity.identityType,
        ...(clean(identity.groupId) ? { groupId: clean(identity.groupId) } : {}),
        ...(clean(identity.groupName) ? { groupName: clean(identity.groupName) } : {}),
        issuedAt: now,
        expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
    };
    const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
    return `${payload}.${sign(payload, secret)}`;
}

export function parseSignedStudentSessionCookie(
    rawCookie: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): StudentServerSession | null {
    const secret = resolveStudentSessionSecret(env);
    if (!secret || !rawCookie) return null;
    const [payload, signature, ...rest] = rawCookie.split(".");
    if (!payload || !signature || rest.length > 0 || !signaturesMatch(signature, sign(payload, secret))) return null;

    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<StudentServerSession>;
        const issuedAt = Number(parsed.issuedAt);
        const expiresAt = Number(parsed.expiresAt);
        if (
            parsed.audience !== "omr-student"
            || parsed.schemaVersion !== 1
            || !clean(parsed.organizationId)
            || !clean(parsed.studentId)
            || !clean(parsed.studentName)
            || (parsed.identityType !== "temporary" && parsed.identityType !== "registered")
            || !Number.isFinite(issuedAt)
            || !Number.isFinite(expiresAt)
            || issuedAt > now + STUDENT_SERVER_SESSION_CLOCK_SKEW_MS
            || expiresAt <= now
            || expiresAt - issuedAt > STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000
        ) {
            return null;
        }

        return {
            audience: "omr-student",
            schemaVersion: 1,
            organizationId: clean(parsed.organizationId),
            studentId: clean(parsed.studentId),
            studentName: clean(parsed.studentName),
            identityType: parsed.identityType,
            ...(clean(parsed.groupId) ? { groupId: clean(parsed.groupId) } : {}),
            ...(clean(parsed.groupName) ? { groupName: clean(parsed.groupName) } : {}),
            issuedAt,
            expiresAt,
        };
    } catch {
        return null;
    }
}

export function shouldUseSecureStudentSessionCookie(
    hostHeader: string | null | undefined,
    env: Env = process.env,
): boolean {
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
