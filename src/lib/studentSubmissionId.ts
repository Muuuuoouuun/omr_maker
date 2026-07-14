import { createHmac } from "node:crypto";

export const STUDENT_SUBMISSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function uuidFromHex(hex: string): string {
    const normalized = hex.slice(0, 32).padEnd(32, "0");
    const versioned = `${normalized.slice(0, 12)}5${normalized.slice(13)}`;
    const variant = ["8", "9", "a", "b"][Number.parseInt(versioned[16], 16) % 4];
    const value = `${versioned.slice(0, 16)}${variant}${versioned.slice(17)}`;
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20, 32)}`;
}

/**
 * Convert a client retry token into an opaque, owner-bound attempt id. The
 * secret binding prevents one student from choosing another student's id.
 */
export function attemptIdForStudentSubmission(params: {
    submissionId: unknown;
    examId: unknown;
    ownerStudentId: unknown;
    secret: unknown;
}): string | null {
    const submissionId = clean(params.submissionId).toLowerCase();
    const examId = clean(params.examId);
    const ownerStudentId = clean(params.ownerStudentId);
    const secret = clean(params.secret);
    if (!STUDENT_SUBMISSION_ID_PATTERN.test(submissionId) || !examId || !ownerStudentId || !secret) return null;
    const digest = createHmac("sha256", secret)
        .update(`${ownerStudentId}\u0000${examId}\u0000${submissionId}`, "utf8")
        .digest("hex");
    return uuidFromHex(digest);
}
