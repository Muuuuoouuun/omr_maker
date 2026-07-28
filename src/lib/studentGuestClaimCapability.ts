import { createHmac, timingSafeEqual } from "node:crypto";
import type { StudentServerIdentity } from "./studentServerSession";

export const GUEST_CLAIM_CAPABILITY_COOKIE = "omr_guest_claim_capability";
export const GUEST_CLAIM_CAPABILITY_MAX_AGE_SECONDS = 24 * 60 * 60;
export const GUEST_CLAIM_CAPABILITY_MAX_ATTEMPTS = 100;

type Env = Record<string, string | undefined>;

export interface GuestClaimCapabilityInput {
    guestId: string;
    studentId: string;
    organizationId: string;
    classId: string;
    attemptIds: string[];
}

export interface GuestClaimCapability extends GuestClaimCapabilityInput {
    audience: "omr-guest-claim";
    schemaVersion: 1;
    issuedAt: number;
    expiresAt: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function secret(env: Env): string {
    return clean(env.STUDENT_SESSION_SECRET)
        || clean(env.OMR_STUDENT_SESSION_SECRET)
        || clean(env.STUDENT_ATTEMPT_SECRET)
        || clean(env.OMR_STUDENT_ATTEMPT_SECRET)
        || (env.NODE_ENV === "production" ? "" : "dev-student-session-secret");
}

function signature(payload: string, value: string): string {
    return createHmac("sha256", value).update(payload, "utf8").digest("base64url");
}

function matches(actual: string, expected: string): boolean {
    const left = Buffer.from(actual, "base64url");
    const right = Buffer.from(expected, "base64url");
    return left.length === right.length && timingSafeEqual(left, right);
}

function attemptIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) return null;
    const raw = value.map(clean);
    if (raw.some(id => !id || id.length > 200)) return null;
    const ids = [...new Set(raw)];
    return ids.length > 0 && ids.length <= GUEST_CLAIM_CAPABILITY_MAX_ATTEMPTS ? ids : null;
}

export function createSignedGuestClaimCapability(
    input: GuestClaimCapabilityInput,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const signingSecret = secret(env);
    const ids = attemptIds(input.attemptIds);
    const guestId = clean(input.guestId);
    const studentId = clean(input.studentId);
    const organizationId = clean(input.organizationId);
    const classId = clean(input.classId);
    if (!signingSecret || !guestId || !studentId || !organizationId || !classId || !ids) return null;
    const capability: GuestClaimCapability = {
        audience: "omr-guest-claim",
        schemaVersion: 1,
        guestId,
        studentId,
        organizationId,
        classId,
        attemptIds: ids,
        issuedAt: now,
        expiresAt: now + GUEST_CLAIM_CAPABILITY_MAX_AGE_SECONDS * 1000,
    };
    const payload = Buffer.from(JSON.stringify(capability), "utf8").toString("base64url");
    return `${payload}.${signature(payload, signingSecret)}`;
}

export function parseSignedGuestClaimCapability(
    raw: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): GuestClaimCapability | null {
    const signingSecret = secret(env);
    if (!raw || !signingSecret) return null;
    const [payload, signed, ...rest] = raw.split(".");
    if (!payload || !signed || rest.length || !matches(signed, signature(payload, signingSecret))) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
        const ids = attemptIds(parsed.attemptIds);
        const issuedAt = Number(parsed.issuedAt);
        const expiresAt = Number(parsed.expiresAt);
        const capability: GuestClaimCapability = {
            audience: "omr-guest-claim",
            schemaVersion: 1,
            guestId: clean(parsed.guestId),
            studentId: clean(parsed.studentId),
            organizationId: clean(parsed.organizationId),
            classId: clean(parsed.classId),
            attemptIds: ids || [],
            issuedAt,
            expiresAt,
        };
        if (
            parsed.audience !== capability.audience
            || parsed.schemaVersion !== 1
            || !capability.guestId
            || !capability.studentId
            || !capability.organizationId
            || !capability.classId
            || !ids
            || !Number.isFinite(issuedAt)
            || !Number.isFinite(expiresAt)
            || issuedAt > now + 30_000
            || expiresAt <= now
            || expiresAt - issuedAt > GUEST_CLAIM_CAPABILITY_MAX_AGE_SECONDS * 1000
        ) return null;
        return capability;
    } catch {
        return null;
    }
}

export function guestClaimCapabilityMatchesStudent(
    capability: GuestClaimCapability,
    student: StudentServerIdentity,
): boolean {
    return student.kind === "student"
        && capability.studentId === clean(student.studentId)
        && capability.organizationId === clean(student.organizationId)
        && capability.classId === clean(student.groupId);
}
