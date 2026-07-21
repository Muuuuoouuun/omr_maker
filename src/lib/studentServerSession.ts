import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdentityType } from "@/types/omr";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";

export const STUDENT_SERVER_SESSION_COOKIE = "omr_student_server_session";
export const STUDENT_SERVER_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const STUDENT_SERVER_SESSION_CLOCK_SKEW_MS = 30 * 1000;

type Env = Record<string, string | undefined>;

export interface StudentIdentityInput {
    kind: "guest" | "student";
    guestId?: string;
    studentId?: string;
    organizationId?: string;
    name: string;
    groupId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    identityType: IdentityType;
}

export interface StudentServerIdentity extends StudentIdentityInput {
    issuedAt: number;
    expiresAt: number;
}

export interface StudentServerSession extends VerifiedStudentIdentity {
    audience: "omr-student";
    schemaVersion: 1;
    issuedAt: number;
    expiresAt: number;
}

type StudentSessionCookieInput = StudentIdentityInput | VerifiedStudentIdentity;
type UnifiedStudentServerSession = StudentServerIdentity & StudentServerSession;

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

function normalizeCookieInput(input: StudentSessionCookieInput, now: number): Record<string, unknown> | null {
    if ("kind" in input) {
        const name = clean(input.name);
        const guestId = clean(input.guestId);
        const sourceStudentId = clean(input.studentId);
        if (!name || (input.kind === "guest" ? !guestId : !sourceStudentId)) return null;

        return {
            audience: "omr-student",
            schemaVersion: 1,
            kind: input.kind,
            ...(guestId ? { guestId } : {}),
            studentId: input.kind === "guest" ? `guest:${guestId}` : sourceStudentId,
            organizationId: clean(input.organizationId),
            name,
            studentName: name,
            groupId: clean(input.groupId) || undefined,
            groupName: clean(input.groupName) || undefined,
            regionId: clean(input.regionId) || undefined,
            regionName: clean(input.regionName) || undefined,
            identityType: input.identityType,
            issuedAt: now,
            expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
        };
    }

    const organizationId = clean(input.organizationId);
    const studentId = clean(input.studentId);
    const studentName = clean(input.studentName);
    if (!organizationId || !studentId || !studentName) return null;

    return {
        audience: "omr-student",
        schemaVersion: 1,
        kind: "student",
        organizationId,
        studentId,
        name: studentName,
        studentName,
        identityType: input.identityType,
        groupId: clean(input.groupId) || undefined,
        groupName: clean(input.groupName) || undefined,
        issuedAt: now,
        expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
    };
}

export function createSignedStudentSessionCookie(
    input: StudentSessionCookieInput,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveStudentSessionSecret(env);
    const session = normalizeCookieInput(input, now);
    if (!secret || !session) return null;

    const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
    return `${payload}.${sign(payload, secret)}`;
}

export function parseSignedStudentSessionCookie(
    rawCookie: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): UnifiedStudentServerSession | null {
    const secret = resolveStudentSessionSecret(env);
    if (!secret || !rawCookie) return null;

    const [payload, signature, ...rest] = rawCookie.split(".");
    if (!payload || !signature || rest.length > 0 || !signaturesMatch(signature, sign(payload, secret))) return null;

    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
        const issuedAt = Number(parsed.issuedAt);
        const expiresAt = Number(parsed.expiresAt);
        const kind = parsed.kind === "guest" ? "guest" : parsed.kind === "student" ? "student" : null;
        const guestId = clean(parsed.guestId);
        const sourceStudentId = clean(parsed.studentId);
        const studentId = kind === "guest" ? sourceStudentId || (guestId ? `guest:${guestId}` : "") : sourceStudentId;
        const name = clean(parsed.name) || clean(parsed.studentName);
        const organizationId = clean(parsed.organizationId);
        const identityType = clean(parsed.identityType) as IdentityType;

        if (
            parsed.audience !== "omr-student"
            || parsed.schemaVersion !== 1
            || !kind
            || !name
            || !studentId
            || (kind === "guest" && !guestId)
            || !["guest", "temporary", "registered"].includes(identityType)
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
            kind,
            ...(guestId ? { guestId } : {}),
            studentId,
            organizationId,
            name,
            studentName: name,
            groupId: clean(parsed.groupId) || undefined,
            groupName: clean(parsed.groupName) || undefined,
            regionId: clean(parsed.regionId) || undefined,
            regionName: clean(parsed.regionName) || undefined,
            identityType,
            issuedAt,
            expiresAt,
        } as UnifiedStudentServerSession;
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
