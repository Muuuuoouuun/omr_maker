import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";

export const STUDENT_START_CODE_HASH_ITERATIONS = 120_000;
export const STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH = 254;
export const STUDENT_START_CODE_MAX_LENGTH = 64;
export const STUDENT_GROUP_ID_MAX_LENGTH = 128;

const STUDENT_START_CODE_HASH_MAX_ITERATIONS = 1_000_000;
const STUDENT_START_CODE_HASH_MAX_ENCODED_LENGTH = 512;
const STUDENT_START_CODE_HASH_BYTES = 32;

interface CredentialQueryResult<T> {
    data: T | null;
    error: { message?: string } | null;
}

interface CredentialSelectQuery {
    eq(column: string, value: string): CredentialSelectQuery;
    maybeSingle(): Promise<CredentialQueryResult<unknown>>;
}

export interface StudentCredentialClient {
    from(table: string): {
        select(columns?: string): CredentialSelectQuery;
    };
}

interface StudentCredentialProfileRow {
    id: string;
    organization_id: string;
    display_name: string;
    status: string;
}

interface StudentStartCredentialRow {
    start_code_hash?: string | null;
}

export type StudentCredentialVerificationResult =
    | { status: "verified"; identity: VerifiedStudentIdentity }
    | { status: "invalid_credentials" | "credential_not_configured" | "service_unavailable"; error?: string };

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function normalizedStartCode(value: unknown): string {
    return clean(value).replace(/\s/g, "").toUpperCase();
}

function parseHash(value: unknown): { iterations: number; salt: Buffer; hash: Buffer } | null {
    const encoded = clean(value);
    if (!encoded || encoded.length > STUDENT_START_CODE_HASH_MAX_ENCODED_LENGTH) return null;
    const [algorithm, rawIterations, saltHex, hashHex, ...rest] = encoded.split(":");
    const iterations = Number(rawIterations);
    if (
        rest.length > 0
        || algorithm !== "pbkdf2-sha256"
        || !Number.isSafeInteger(iterations)
        || iterations < 10_000
        || iterations > STUDENT_START_CODE_HASH_MAX_ITERATIONS
        || !/^[a-f0-9]+$/i.test(saltHex || "")
        || !/^[a-f0-9]+$/i.test(hashHex || "")
        || saltHex.length % 2 !== 0
        || hashHex.length % 2 !== 0
        || saltHex.length < 32
        || saltHex.length > 128
        || hashHex.length !== STUDENT_START_CODE_HASH_BYTES * 2
    ) {
        return null;
    }
    return { iterations, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

export function hashStudentStartCode(
    startCode: string,
    iterations = STUDENT_START_CODE_HASH_ITERATIONS,
    salt = randomBytes(16),
): string {
    if (clean(startCode).length > STUDENT_START_CODE_MAX_LENGTH) {
        throw new Error("Student start code is too long");
    }
    const normalized = normalizedStartCode(startCode);
    if (!normalized) throw new Error("Student start code is required");
    const hash = pbkdf2Sync(normalized, salt, iterations, 32, "sha256");
    return `pbkdf2-sha256:${iterations}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyStudentStartCode(startCode: string, encodedHash: string | null | undefined): boolean {
    if (clean(startCode).length > STUDENT_START_CODE_MAX_LENGTH) return false;
    const normalized = normalizedStartCode(startCode);
    const parsed = parseHash(encodedHash);
    if (!parsed || !normalized) return false;
    const actual = pbkdf2Sync(normalized, parsed.salt, parsed.iterations, parsed.hash.length, "sha256");
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
}

export async function verifyStudentCredentials(
    client: StudentCredentialClient,
    input: { studentId: string; startCode: string; groupId?: string },
): Promise<StudentCredentialVerificationResult> {
    const studentId = clean(input.studentId);
    const groupId = clean(input.groupId);
    const rawStartCode = clean(input.startCode);
    if (
        !studentId
        || studentId.length > STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH
        || rawStartCode.length > STUDENT_START_CODE_MAX_LENGTH
        || groupId.length > STUDENT_GROUP_ID_MAX_LENGTH
    ) {
        return { status: "invalid_credentials" };
    }
    const startCode = normalizedStartCode(input.startCode);
    if (!startCode) return { status: "invalid_credentials" };

    let profile: StudentCredentialProfileRow | null = null;
    for (const loginColumn of ["id", "external_id", "email"] as const) {
        const profileResult = await client
            .from("omr_student_profiles")
            .select("id, organization_id, display_name, status")
            .eq(loginColumn, studentId)
            .maybeSingle();
        if (profileResult.error) {
            return { status: "service_unavailable", error: profileResult.error.message };
        }
        profile = profileResult.data as StudentCredentialProfileRow | null;
        if (profile) break;
    }
    if (!profile || !["invited", "active"].includes(profile.status)) return { status: "invalid_credentials" };

    const credentialResult = await client
        .from("omr_student_start_credentials")
        .select("start_code_hash")
        .eq("organization_id", clean(profile.organization_id))
        .eq("student_profile_id", clean(profile.id))
        .maybeSingle();
    if (credentialResult.error) {
        return { status: "service_unavailable", error: credentialResult.error.message };
    }
    const credential = credentialResult.data as StudentStartCredentialRow | null;
    if (!clean(credential?.start_code_hash)) return { status: "credential_not_configured" };
    if (!verifyStudentStartCode(startCode, credential?.start_code_hash)) return { status: "invalid_credentials" };

    if (groupId) {
        const enrollmentResult = await client
            .from("omr_class_students")
            .select("class_id")
            .eq("organization_id", clean(profile.organization_id))
            .eq("student_profile_id", clean(profile.id))
            .eq("class_id", groupId)
            .eq("enrollment_status", "active")
            .maybeSingle();
        if (enrollmentResult.error) {
            return { status: "service_unavailable", error: enrollmentResult.error.message };
        }
        if (!enrollmentResult.data) return { status: "invalid_credentials" };
    }

    return {
        status: "verified",
        identity: {
            organizationId: clean(profile.organization_id),
            studentId: clean(profile.id),
            studentName: clean(profile.display_name),
            identityType: "registered",
            ...(groupId ? { groupId } : {}),
        },
    };
}
