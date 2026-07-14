import { createHmac, timingSafeEqual } from "node:crypto";

export const STUDENT_ACCESS_CODE_METADATA_KEY = "studentAccessCode";
export const STUDENT_ACCESS_CODE_VERSION = 1;
export const STUDENT_ACCESS_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;

export interface StudentAccessCodeRecord {
    version: 1;
    hash: string;
    updatedAt: string;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function asMetadata(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

export function normalizeStudentAccessCode(value: unknown): string {
    return clean(value).replace(/\s/g, "").toUpperCase().slice(0, 6);
}

export function isValidStudentAccessCode(value: unknown): boolean {
    return STUDENT_ACCESS_CODE_PATTERN.test(normalizeStudentAccessCode(value));
}

export function hashStudentAccessCode(params: {
    code: unknown;
    studentId: unknown;
    organizationId: unknown;
    secret: unknown;
}): string | null {
    const code = normalizeStudentAccessCode(params.code);
    const studentId = clean(params.studentId);
    const organizationId = clean(params.organizationId);
    const secret = clean(params.secret);
    if (!STUDENT_ACCESS_CODE_PATTERN.test(code) || !studentId || !organizationId || !secret) return null;
    return createHmac("sha256", secret)
        .update(`${organizationId}\u0000${studentId}\u0000${code}`, "utf8")
        .digest("hex");
}

export function readStudentAccessCodeRecord(metadata: unknown): StudentAccessCodeRecord | null {
    const raw = asMetadata(metadata)[STUDENT_ACCESS_CODE_METADATA_KEY];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Partial<StudentAccessCodeRecord>;
    if (record.version !== STUDENT_ACCESS_CODE_VERSION) return null;
    if (typeof record.hash !== "string" || !/^[a-f0-9]{64}$/i.test(record.hash)) return null;
    if (typeof record.updatedAt !== "string" || !record.updatedAt.trim()) return null;
    return {
        version: STUDENT_ACCESS_CODE_VERSION,
        hash: record.hash.toLowerCase(),
        updatedAt: record.updatedAt,
    };
}

export function metadataWithStudentAccessCode(
    metadata: unknown,
    params: { code: unknown; studentId: unknown; organizationId: unknown; secret: unknown; updatedAt?: string },
): Record<string, unknown> | null {
    const hash = hashStudentAccessCode(params);
    if (!hash) return null;
    return {
        ...asMetadata(metadata),
        [STUDENT_ACCESS_CODE_METADATA_KEY]: {
            version: STUDENT_ACCESS_CODE_VERSION,
            hash,
            updatedAt: params.updatedAt || new Date().toISOString(),
        } satisfies StudentAccessCodeRecord,
    };
}

export function verifyStudentAccessCode(
    metadata: unknown,
    params: { code: unknown; studentId: unknown; organizationId: unknown; secret: unknown },
): boolean {
    const record = readStudentAccessCodeRecord(metadata);
    const actual = hashStudentAccessCode(params);
    if (!record || !actual) return false;
    const actualBuffer = Buffer.from(actual, "hex");
    const expectedBuffer = Buffer.from(record.hash, "hex");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}
