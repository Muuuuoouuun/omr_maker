import { createHmac, timingSafeEqual } from "node:crypto";
import {
    resolveStudentSessionSecret,
    STUDENT_SERVER_SESSION_CLOCK_SKEW_MS,
    STUDENT_SERVER_SESSION_MAX_AGE_SECONDS,
    type StudentServerIdentity,
} from "@/lib/studentServerSession";

export const GUEST_CLAIM_OWNER_COOKIE = "omr_guest_db_claim_owner";

type Env = Record<string, string | undefined>;

export interface GuestClaimOwnerProof {
    audience: "omr-guest-db-claim";
    schemaVersion: 1;
    guestId: string;
    studentId: string;
    organizationId: string;
    classId: string;
    issuedAt: number;
    expiresAt: number;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function sign(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createSignedGuestClaimOwnerProof(
    input: { guest: StudentServerIdentity; student: StudentServerIdentity },
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveStudentSessionSecret(env);
    const guestId = input.guest.kind === "guest" ? clean(input.guest.guestId) : "";
    const studentId = input.student.kind === "student" ? clean(input.student.studentId) : "";
    const organizationId = clean(input.student.organizationId);
    const classId = clean(input.student.groupId);
    const expiresAt = Math.min(input.guest.expiresAt, input.student.expiresAt);
    if (
        !secret
        || !guestId
        || !studentId
        || !organizationId
        || !classId
        || !Number.isFinite(expiresAt)
        || expiresAt <= now
    ) return null;
    const proof: GuestClaimOwnerProof = {
        audience: "omr-guest-db-claim",
        schemaVersion: 1,
        guestId,
        studentId,
        organizationId,
        classId,
        issuedAt: now,
        expiresAt,
    };
    const payload = Buffer.from(JSON.stringify(proof), "utf8").toString("base64url");
    return `${payload}.${sign(payload, secret)}`;
}

export function parseSignedGuestClaimOwnerProof(
    raw: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): GuestClaimOwnerProof | null {
    const secret = resolveStudentSessionSecret(env);
    if (!secret || !raw) return null;
    const [payload, signature, ...rest] = raw.split(".");
    if (!payload || !signature || rest.length > 0 || !signaturesMatch(signature, sign(payload, secret))) return null;
    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
        const issuedAt = Number(parsed.issuedAt);
        const expiresAt = Number(parsed.expiresAt);
        const proof: GuestClaimOwnerProof = {
            audience: "omr-guest-db-claim",
            schemaVersion: 1,
            guestId: clean(parsed.guestId),
            studentId: clean(parsed.studentId),
            organizationId: clean(parsed.organizationId),
            classId: clean(parsed.classId),
            issuedAt,
            expiresAt,
        };
        if (
            parsed.audience !== proof.audience
            || parsed.schemaVersion !== proof.schemaVersion
            || !proof.guestId
            || !proof.studentId
            || !proof.organizationId
            || !proof.classId
            || !Number.isFinite(issuedAt)
            || !Number.isFinite(expiresAt)
            || issuedAt > now + STUDENT_SERVER_SESSION_CLOCK_SKEW_MS
            || expiresAt <= now
            || expiresAt - issuedAt > STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000
        ) return null;
        return proof;
    } catch {
        return null;
    }
}

export function guestClaimOwnerMatchesStudent(
    proof: GuestClaimOwnerProof,
    student: StudentServerIdentity,
): boolean {
    return student.kind === "student"
        && proof.studentId === clean(student.studentId)
        && proof.organizationId === clean(student.organizationId)
        && proof.classId === clean(student.groupId);
}
