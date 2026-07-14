import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IdentityType } from "@/types/omr";

export const STUDENT_ATTEMPT_TICKET_TTL_MS = 12 * 60 * 60 * 1000;
export const STUDENT_ATTEMPT_TICKET_CLOCK_SKEW_MS = 30 * 1000;

type Env = Record<string, string | undefined>;

export interface StudentAttemptTicketClaims {
    schemaVersion: 1;
    audience: "omr-attempt";
    ticketId: string;
    examId: string;
    organizationId: string;
    assignmentId?: string;
    studentId: string;
    studentName: string;
    identityType: IdentityType;
    groupId?: string;
    groupName?: string;
    guestId?: string;
    allowedQuestionIds: number[];
    issuedAt: number;
    expiresAt: number;
}

export interface StudentAttemptTicketInput {
    examId: string;
    organizationId: string;
    assignmentId?: string;
    studentId: string;
    studentName: string;
    identityType: IdentityType;
    groupId?: string;
    groupName?: string;
    guestId?: string;
    allowedQuestionIds: number[];
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveStudentAttemptSecret(env: Env = process.env): string | null {
    const explicit = clean(env.STUDENT_ATTEMPT_SECRET) || clean(env.OMR_STUDENT_ATTEMPT_SECRET);
    if (explicit) return explicit;
    return env.NODE_ENV === "production" ? null : "dev-student-attempt-secret";
}

function sign(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function signatureMatches(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeQuestionIds(values: number[]): number[] {
    return [...new Set(values.filter(value => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
}

export function createStudentAttemptTicket(
    input: StudentAttemptTicketInput,
    env: Env = process.env,
    now = Date.now(),
    ticketId = randomUUID(),
): string | null {
    const secret = resolveStudentAttemptSecret(env);
    const examId = clean(input.examId);
    const organizationId = clean(input.organizationId);
    const studentId = clean(input.studentId);
    const studentName = clean(input.studentName);
    const allowedQuestionIds = normalizeQuestionIds(input.allowedQuestionIds);
    if (!secret || !examId || !organizationId || !studentId || !studentName || allowedQuestionIds.length === 0) return null;

    const claims: StudentAttemptTicketClaims = {
        schemaVersion: 1,
        audience: "omr-attempt",
        ticketId,
        examId,
        organizationId,
        ...(clean(input.assignmentId) ? { assignmentId: clean(input.assignmentId) } : {}),
        studentId,
        studentName,
        identityType: input.identityType,
        ...(clean(input.groupId) ? { groupId: clean(input.groupId) } : {}),
        ...(clean(input.groupName) ? { groupName: clean(input.groupName) } : {}),
        ...(clean(input.guestId) ? { guestId: clean(input.guestId) } : {}),
        allowedQuestionIds,
        issuedAt: now,
        expiresAt: now + STUDENT_ATTEMPT_TICKET_TTL_MS,
    };
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return `${payload}.${sign(payload, secret)}`;
}

export function parseStudentAttemptTicket(
    rawTicket: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): StudentAttemptTicketClaims | null {
    const secret = resolveStudentAttemptSecret(env);
    if (!secret || !rawTicket) return null;
    const [payload, signature, ...rest] = rawTicket.split(".");
    if (!payload || !signature || rest.length > 0) return null;
    if (!signatureMatches(signature, sign(payload, secret))) return null;

    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<StudentAttemptTicketClaims>;
        const allowedQuestionIds = normalizeQuestionIds(Array.isArray(claims.allowedQuestionIds) ? claims.allowedQuestionIds : []);
        if (
            claims.schemaVersion !== 1
            || claims.audience !== "omr-attempt"
            || !clean(claims.ticketId)
            || !clean(claims.examId)
            || !clean(claims.organizationId)
            || !clean(claims.studentId)
            || !clean(claims.studentName)
            || !(["guest", "temporary", "registered"] as const).includes(claims.identityType as IdentityType)
            || allowedQuestionIds.length === 0
            || !Number.isFinite(claims.issuedAt)
            || !Number.isFinite(claims.expiresAt)
            || (claims.issuedAt as number) > now + STUDENT_ATTEMPT_TICKET_CLOCK_SKEW_MS
            || (claims.expiresAt as number) - (claims.issuedAt as number) > STUDENT_ATTEMPT_TICKET_TTL_MS
            || (claims.expiresAt as number) <= now
        ) {
            return null;
        }
        return {
            schemaVersion: 1,
            audience: "omr-attempt",
            ticketId: clean(claims.ticketId),
            examId: clean(claims.examId),
            organizationId: clean(claims.organizationId),
            ...(clean(claims.assignmentId) ? { assignmentId: clean(claims.assignmentId) } : {}),
            studentId: clean(claims.studentId),
            studentName: clean(claims.studentName),
            identityType: claims.identityType as IdentityType,
            ...(clean(claims.groupId) ? { groupId: clean(claims.groupId) } : {}),
            ...(clean(claims.groupName) ? { groupName: clean(claims.groupName) } : {}),
            ...(clean(claims.guestId) ? { guestId: clean(claims.guestId) } : {}),
            allowedQuestionIds,
            issuedAt: claims.issuedAt as number,
            expiresAt: claims.expiresAt as number,
        };
    } catch {
        return null;
    }
}
