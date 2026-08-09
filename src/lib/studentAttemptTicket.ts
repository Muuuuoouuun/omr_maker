import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { IdentityType, RetakeMetadata } from "@/types/omr";
import { resolveServerSigningSecret } from "@/lib/serverSigningSecret";

export const STUDENT_ATTEMPT_TICKET_TTL_MS = 12 * 60 * 60 * 1000;
export const STUDENT_ATTEMPT_TICKET_CLOCK_SKEW_MS = 30 * 1000;

type Env = Record<string, string | undefined>;

export interface StudentAttemptTicketClaims {
    schemaVersion: 2;
    audience: "omr-attempt";
    ticketId: string;
    examId: string;
    organizationId: string;
    assignmentId?: string;
    assignmentRevision?: number;
    studentId: string;
    studentName: string;
    identityType: IdentityType;
    groupId?: string;
    groupName?: string;
    guestId?: string;
    allowedQuestionIds: number[];
    retakeSourceAttemptId?: string;
    retakeMode?: RetakeMetadata["mode"];
    issuedAt: number;
    expiresAt: number;
}

export interface StudentAttemptTicketInput {
    examId: string;
    organizationId: string;
    assignmentId?: string;
    assignmentRevision?: number;
    studentId: string;
    studentName: string;
    identityType: IdentityType;
    groupId?: string;
    groupName?: string;
    guestId?: string;
    allowedQuestionIds: number[];
    retakeSourceAttemptId?: string;
    retakeMode?: RetakeMetadata["mode"];
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveStudentAttemptSecret(env: Env = process.env): string | null {
    const explicit = clean(env.STUDENT_ATTEMPT_SECRET) || clean(env.OMR_STUDENT_ATTEMPT_SECRET);
    if (explicit) return resolveServerSigningSecret(explicit, env.NODE_ENV);
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
    const retakeSourceAttemptId = clean(input.retakeSourceAttemptId);
    const assignmentId = clean(input.assignmentId);
    const assignmentRevision = Number.isSafeInteger(input.assignmentRevision) && Number(input.assignmentRevision) > 0
        ? Number(input.assignmentRevision)
        : null;
    const validRetakeMode = input.retakeMode === "wrong" || input.retakeMode === "similar" || input.retakeMode === "custom";
    if (
        !secret || !examId || !organizationId || !studentId || !studentName
        || allowedQuestionIds.length === 0 || allowedQuestionIds.length > 500
        || Boolean(retakeSourceAttemptId) !== Boolean(input.retakeMode)
        || Boolean(assignmentId) !== Boolean(assignmentRevision)
        || (input.retakeMode !== undefined && !validRetakeMode)
    ) return null;

    const claims: StudentAttemptTicketClaims = {
        schemaVersion: 2,
        audience: "omr-attempt",
        ticketId,
        examId,
        organizationId,
        ...(assignmentId && assignmentRevision ? { assignmentId, assignmentRevision } : {}),
        studentId,
        studentName,
        identityType: input.identityType,
        ...(clean(input.groupId) ? { groupId: clean(input.groupId) } : {}),
        ...(clean(input.groupName) ? { groupName: clean(input.groupName) } : {}),
        ...(clean(input.guestId) ? { guestId: clean(input.guestId) } : {}),
        allowedQuestionIds,
        ...(retakeSourceAttemptId && validRetakeMode
            ? {
                retakeSourceAttemptId,
                retakeMode: input.retakeMode as RetakeMetadata["mode"],
            }
            : {}),
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
    if (!secret || !rawTicket || rawTicket.length > 32_768) return null;
    const [payload, signature, ...rest] = rawTicket.split(".");
    if (!payload || !signature || rest.length > 0) return null;
    if (!signatureMatches(signature, sign(payload, secret))) return null;

    try {
        const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<StudentAttemptTicketClaims>;
        const allowedQuestionIds = normalizeQuestionIds(Array.isArray(claims.allowedQuestionIds) ? claims.allowedQuestionIds : []);
        const retakeSourceAttemptId = clean(claims.retakeSourceAttemptId);
        const assignmentId = clean(claims.assignmentId);
        const assignmentRevision = Number.isSafeInteger(claims.assignmentRevision) && Number(claims.assignmentRevision) > 0
            ? Number(claims.assignmentRevision)
            : null;
        const hasRetakeMode = claims.retakeMode !== undefined && claims.retakeMode !== null;
        const validRetakeMode = claims.retakeMode === "wrong" || claims.retakeMode === "similar" || claims.retakeMode === "custom";
        if (
            claims.schemaVersion !== 2
            || claims.audience !== "omr-attempt"
            || !clean(claims.ticketId)
            || !clean(claims.examId)
            || !clean(claims.organizationId)
            || !clean(claims.studentId)
            || !clean(claims.studentName)
            || !(["guest", "temporary", "registered"] as const).includes(claims.identityType as IdentityType)
            || allowedQuestionIds.length === 0
            || allowedQuestionIds.length > 500
            || !Number.isFinite(claims.issuedAt)
            || !Number.isFinite(claims.expiresAt)
            || (claims.issuedAt as number) > now + STUDENT_ATTEMPT_TICKET_CLOCK_SKEW_MS
            || (claims.expiresAt as number) - (claims.issuedAt as number) > STUDENT_ATTEMPT_TICKET_TTL_MS
            || (claims.expiresAt as number) <= now
            || Boolean(retakeSourceAttemptId) !== hasRetakeMode
            || Boolean(assignmentId) !== Boolean(assignmentRevision)
            || (hasRetakeMode && !validRetakeMode)
        ) {
            return null;
        }
        return {
            schemaVersion: 2,
            audience: "omr-attempt",
            ticketId: clean(claims.ticketId),
            examId: clean(claims.examId),
            organizationId: clean(claims.organizationId),
            ...(assignmentId && assignmentRevision ? { assignmentId, assignmentRevision } : {}),
            studentId: clean(claims.studentId),
            studentName: clean(claims.studentName),
            identityType: claims.identityType as IdentityType,
            ...(clean(claims.groupId) ? { groupId: clean(claims.groupId) } : {}),
            ...(clean(claims.groupName) ? { groupName: clean(claims.groupName) } : {}),
            ...(clean(claims.guestId) ? { guestId: clean(claims.guestId) } : {}),
            allowedQuestionIds,
            ...(retakeSourceAttemptId && validRetakeMode
                ? {
                    retakeSourceAttemptId,
                    retakeMode: claims.retakeMode as RetakeMetadata["mode"],
                }
                : {}),
            issuedAt: claims.issuedAt as number,
            expiresAt: claims.expiresAt as number,
        };
    } catch {
        return null;
    }
}
