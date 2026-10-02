import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";

export const STUDENT_START_CODE_HASH_ITERATIONS = 120_000;
export const STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH = 254;
export const STUDENT_START_CODE_MAX_LENGTH = 64;

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

export interface StudentCredentialSessionValidationClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

interface StudentCredentialProfileRow {
    id: string;
    organization_id: string;
    display_name: string;
    status: string;
    credential_generation?: number | null;
}

interface StudentStartCredentialRow {
    start_code_hash?: string | null;
    account_id?: string | null;
    credential_generation?: number | null;
}

export type VerifiedStudentCredentialIdentity = VerifiedStudentIdentity & {
    accountId: string;
    credentialGeneration: number;
};

export interface StudentCredentialLookup {
    organizationId: string;
    studentProfileId: string;
    code: string;
}

export type StudentCredentialVerificationResult =
    | { status: "verified"; identity: VerifiedStudentCredentialIdentity }
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
    input: StudentCredentialLookup,
): Promise<StudentCredentialVerificationResult> {
    const organizationId = clean(input.organizationId);
    const studentProfileId = clean(input.studentProfileId);
    const rawStartCode = clean(input.code);
    if (
        !organizationId
        || !studentProfileId
        || studentProfileId.length > STUDENT_LOGIN_IDENTIFIER_MAX_LENGTH
        || rawStartCode.length > STUDENT_START_CODE_MAX_LENGTH
    ) {
        return { status: "invalid_credentials" };
    }
    const startCode = normalizedStartCode(input.code);
    if (!startCode) return { status: "invalid_credentials" };

    const credentialResult = await client
        .from("omr_student_start_credentials")
        .select("start_code_hash,account_id,credential_generation")
        .eq("organization_id", organizationId)
        .eq("student_profile_id", studentProfileId)
        .maybeSingle();
    if (credentialResult.error) {
        return { status: "service_unavailable", error: credentialResult.error.message };
    }
    const credential = credentialResult.data as StudentStartCredentialRow | null;
    if (!clean(credential?.start_code_hash)) return { status: "credential_not_configured" };
    if (!verifyStudentStartCode(startCode, credential?.start_code_hash)) return { status: "invalid_credentials" };
    const accountId = clean(credential?.account_id);
    const credentialGeneration = credential?.credential_generation;
    if (
        !/^student_credential_[a-f0-9]{32}$/.test(accountId)
        || typeof credentialGeneration !== "number"
        || !Number.isSafeInteger(credentialGeneration)
        || credentialGeneration <= 0
    ) return { status: "invalid_credentials" };

    const profileResult = await client
        .from("omr_student_profiles")
        .select("id, organization_id, display_name, status, credential_generation")
        .eq("organization_id", organizationId)
        .eq("id", studentProfileId)
        .maybeSingle();
    if (profileResult.error) {
        return { status: "service_unavailable", error: profileResult.error.message };
    }
    const profile = profileResult.data as StudentCredentialProfileRow | null;
    if (
        !profile
        || clean(profile.organization_id) !== organizationId
        || clean(profile.id) !== studentProfileId
        || !["invited", "active"].includes(profile.status)
        || profile.credential_generation !== credentialGeneration
    ) {
        return { status: "invalid_credentials" };
    }

    return {
        status: "verified",
        identity: {
            organizationId,
            studentId: studentProfileId,
            studentName: clean(profile.display_name),
            identityType: "registered",
            accountId,
            credentialGeneration,
        },
    };
}

export async function validateVerifiedStudentCredentialSession(
    client: StudentCredentialSessionValidationClient,
    identity: VerifiedStudentCredentialIdentity,
    timeoutMs = 2_000,
): Promise<"active" | "stale" | "service_unavailable"> {
    try {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const result = await Promise.race([
            Promise.resolve(client.rpc("omr_validate_student_session_v1", {
                p_account_id: identity.accountId,
                p_organization_id: identity.organizationId,
                p_student_id: identity.studentId,
                p_credential_generation: identity.credentialGeneration,
            })),
            new Promise<never>((_, reject) => {
                timeoutId = setTimeout(() => reject(new Error("student credential validation timeout")), timeoutMs);
            }),
        ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
        if (result.error) return "service_unavailable";
        return result.data === true ? "active" : "stale";
    } catch {
        return "service_unavailable";
    }
}
