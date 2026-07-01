import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdentityType } from "@/types/omr";

export const STUDENT_SERVER_SESSION_COOKIE = "omr_student_server_session";
export const STUDENT_SERVER_SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30d

type Env = Record<string, string | undefined>;

export interface StudentIdentityInput {
    kind: "guest" | "student";
    guestId?: string;
    studentId?: string;
    name: string;
    groupId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    identityType: Extract<IdentityType, "guest" | "temporary">;
}

export interface StudentServerIdentity extends StudentIdentityInput {
    issuedAt: number;
    expiresAt: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveStudentSessionSecret(env: Env = process.env): string | null {
    const explicit = clean(env.STUDENT_SESSION_SECRET) || clean(env.OMR_STUDENT_SESSION_SECRET);
    if (explicit) return explicit;
    return env.NODE_ENV === "production" ? null : "dev-student-session-secret";
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
    const a = Buffer.from(actual, "base64url");
    const b = Buffer.from(expected, "base64url");
    return a.length === b.length && timingSafeEqual(a, b);
}

export function createStudentServerIdentity(
    input: StudentIdentityInput,
    now = Date.now(),
): StudentServerIdentity {
    return { ...input, issuedAt: now, expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000 };
}

export function isStudentIdentityActive(identity: StudentServerIdentity | null, now = Date.now()): boolean {
    return !!identity && Number.isFinite(identity.expiresAt) && identity.expiresAt > now;
}

export function createSignedStudentSessionCookie(
    input: StudentIdentityInput,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveStudentSessionSecret(env);
    if (!secret) return null;
    const identity = createStudentServerIdentity(input, now);
    const payload = base64UrlEncode(JSON.stringify(identity));
    return `${payload}.${signPayload(payload, secret)}`;
}

export function parseSignedStudentSessionCookie(
    rawCookie: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): StudentServerIdentity | null {
    if (!rawCookie) return null;
    const secret = resolveStudentSessionSecret(env);
    if (!secret) return null;

    const [payload, signature, ...rest] = rawCookie.split(".");
    if (!payload || !signature || rest.length > 0) return null;
    if (!signaturesMatch(signature, signPayload(payload, secret))) return null;

    try {
        const parsed = JSON.parse(base64UrlDecode(payload)) as StudentServerIdentity;
        return isStudentIdentityActive(parsed, now) ? parsed : null;
    } catch {
        return null;
    }
}
