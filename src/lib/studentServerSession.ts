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
    /**
     * Organization that owns the roster/exam this identity was verified against.
     * Present for roster-verified students; absent for public-link guests (who are
     * inherently cross-org). All service-role reads for a student scope on this.
     */
    organizationId?: string;
    /**
     * Real omr_student_profiles.id when the login matched a provisioned roster
     * profile. Left undefined for guests and unmatched quick-entry students so the
     * attempt's student_profile_id FK column stays null instead of a synthetic id.
     */
    studentProfileId?: string;
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

function cleanOptional(value: unknown): string | undefined {
    const trimmed = clean(value);
    return trimmed ? trimmed : undefined;
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

/**
 * Build a signed-session identity by copying ONLY the allowlisted fields. A
 * caller-supplied object is never spread wholesale, so a crafted login payload
 * cannot smuggle extra claims (e.g. a forged organizationId or a role flag) into
 * the signed cookie.
 */
export function createStudentServerIdentity(
    input: StudentIdentityInput,
    now = Date.now(),
): StudentServerIdentity {
    const identity: StudentServerIdentity = {
        kind: input.kind === "guest" ? "guest" : "student",
        name: clean(input.name),
        identityType: input.identityType === "guest" ? "guest" : "temporary",
        issuedAt: now,
        expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
    };
    const guestId = cleanOptional(input.guestId);
    const studentId = cleanOptional(input.studentId);
    const organizationId = cleanOptional(input.organizationId);
    const studentProfileId = cleanOptional(input.studentProfileId);
    const groupId = cleanOptional(input.groupId);
    const groupName = cleanOptional(input.groupName);
    const regionId = cleanOptional(input.regionId);
    const regionName = cleanOptional(input.regionName);
    if (guestId) identity.guestId = guestId;
    if (studentId) identity.studentId = studentId;
    if (organizationId) identity.organizationId = organizationId;
    if (studentProfileId) identity.studentProfileId = studentProfileId;
    if (groupId) identity.groupId = groupId;
    if (groupName) identity.groupName = groupName;
    if (regionId) identity.regionId = regionId;
    if (regionName) identity.regionName = regionName;
    return identity;
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
        if (parsed.kind === "guest" ? !parsed.guestId : !parsed.studentId) return null;
        return isStudentIdentityActive(parsed, now) ? parsed : null;
    } catch {
        return null;
    }
}
