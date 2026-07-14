import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";

export const STUDENT_START_CODE_HASH_ITERATIONS = 120_000;

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
    const [algorithm, rawIterations, saltHex, hashHex, ...rest] = clean(value).split(":");
    const iterations = Number(rawIterations);
    if (
        rest.length > 0
        || algorithm !== "pbkdf2-sha256"
        || !Number.isSafeInteger(iterations)
        || iterations < 10_000
        || !/^[a-f0-9]+$/i.test(saltHex || "")
        || !/^[a-f0-9]+$/i.test(hashHex || "")
        || saltHex.length % 2 !== 0
        || hashHex.length % 2 !== 0
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
    const normalized = normalizedStartCode(startCode);
    if (!normalized) throw new Error("Student start code is required");
    const hash = pbkdf2Sync(normalized, salt, iterations, 32, "sha256");
    return `pbkdf2-sha256:${iterations}:${salt.toString("hex")}:${hash.toString("hex")}`;
}

export function verifyStudentStartCode(startCode: string, encodedHash: string | null | undefined): boolean {
    const parsed = parseHash(encodedHash);
    const normalized = normalizedStartCode(startCode);
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
    const startCode = normalizedStartCode(input.startCode);
    if (!studentId || !startCode) return { status: "invalid_credentials" };

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
