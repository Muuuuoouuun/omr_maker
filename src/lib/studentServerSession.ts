import { createHmac, timingSafeEqual } from "node:crypto";
import type { IdentityType } from "@/types/omr";
import type { VerifiedStudentIdentity } from "@/lib/studentExamContract";
import { resolveServerSigningSecret } from "@/lib/serverSigningSecret";

export const STUDENT_SERVER_SESSION_COOKIE = "omr_student_server_session";
export const STUDENT_SERVER_SESSION_MAX_AGE_SECONDS = 12 * 60 * 60;
export const STUDENT_SERVER_SESSION_CLOCK_SKEW_MS = 30 * 1000;

type Env = Record<string, string | undefined>;
const STUDENT_CREDENTIAL_ACCOUNT_ID_PATTERN = /^student_credential_[a-f0-9]{32}$/;
export const STUDENT_SESSION_VALIDATION_TIMEOUT_MS = 2_000;

export interface StudentIdentityInput {
    kind: "guest" | "student";
    guestId?: string;
    accountId?: string;
    studentId?: string;
    organizationId?: string;
    name: string;
    groupId?: string;
    groupName?: string;
    regionId?: string;
    regionName?: string;
    identityType: IdentityType;
    credentialGeneration?: number;
}

export interface StudentServerIdentity extends StudentIdentityInput {
    version?: 2;
    issuedAt: number;
    expiresAt: number;
}

export interface StudentServerSessionV2 extends VerifiedStudentIdentity {
    version: 2;
    accountId: string;
    credentialGeneration: number;
    issuedAt: number;
    expiresAt: number;
}

export interface StudentServerSession {
    audience: "omr-student";
    schemaVersion: 2;
    version: 2;
    kind: "guest" | "student";
    guestId?: string;
    accountId?: string;
    organizationId: string;
    studentId: string;
    name: string;
    studentName: string;
    identityType: IdentityType;
    groupId?: string;
    groupName?: string;
    credentialGeneration?: number;
    issuedAt: number;
    expiresAt: number;
}

type StudentSessionCookieInput = StudentIdentityInput | VerifiedStudentIdentity;
type UnifiedStudentServerSession = StudentServerIdentity & StudentServerSession;

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function resolveStudentSessionSecret(env: Env = process.env): string | null {
    const explicit = clean(env.STUDENT_SESSION_SECRET) || clean(env.OMR_STUDENT_SESSION_SECRET);
    if (explicit) return resolveServerSigningSecret(explicit, env.NODE_ENV);

    if (clean(env.NODE_ENV).toLowerCase() === "production") return null;

    const attemptSecret = clean(env.STUDENT_ATTEMPT_SECRET) || clean(env.OMR_STUDENT_ATTEMPT_SECRET);
    if (attemptSecret) return resolveServerSigningSecret(attemptSecret, env.NODE_ENV);
    return "dev-student-session-secret";
}

function sign(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
}

function signaturesMatch(actual: string, expected: string): boolean {
    const actualBuffer = Buffer.from(actual, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function normalizeCookieInput(input: StudentSessionCookieInput, now: number): Record<string, unknown> | null {
    if ("kind" in input) {
        const name = clean(input.name);
        const guestId = clean(input.guestId);
        const accountId = clean(input.accountId);
        const sourceStudentId = clean(input.studentId);
        if (!name || (input.kind === "guest" ? !guestId : !sourceStudentId)) return null;
        const credentialGeneration = input.credentialGeneration;
        if (
            input.kind === "student"
            && input.identityType === "registered"
            && (
                !accountId
                || !STUDENT_CREDENTIAL_ACCOUNT_ID_PATTERN.test(accountId)
                || typeof credentialGeneration !== "number"
                || !Number.isSafeInteger(credentialGeneration)
                || credentialGeneration <= 0
            )
        ) return null;

        return {
            audience: "omr-student",
            schemaVersion: 2,
            version: 2,
            kind: input.kind,
            ...(guestId ? { guestId } : {}),
            ...(accountId ? { accountId } : {}),
            studentId: input.kind === "guest" ? `guest:${guestId}` : sourceStudentId,
            organizationId: clean(input.organizationId),
            name,
            studentName: name,
            groupId: clean(input.groupId) || undefined,
            groupName: clean(input.groupName) || undefined,
            regionId: clean(input.regionId) || undefined,
            regionName: clean(input.regionName) || undefined,
            identityType: input.identityType,
            ...(input.kind === "student" && input.identityType === "registered"
                ? { credentialGeneration }
                : {}),
            issuedAt: now,
            expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
        };
    }

    const organizationId = clean(input.organizationId);
    const studentId = clean(input.studentId);
    const studentName = clean(input.studentName);
    const accountId = clean((input as VerifiedStudentIdentity & { accountId?: string }).accountId);
    const credentialGeneration = (input as VerifiedStudentIdentity & {
        credentialGeneration?: number;
    }).credentialGeneration;
    if (
        !organizationId
        || !studentId
        || !studentName
        || !accountId
        || !STUDENT_CREDENTIAL_ACCOUNT_ID_PATTERN.test(accountId)
        || typeof credentialGeneration !== "number"
        || !Number.isSafeInteger(credentialGeneration)
        || credentialGeneration <= 0
    ) return null;

    return {
        audience: "omr-student",
        schemaVersion: 2,
        version: 2,
        kind: "student",
        accountId,
        organizationId,
        studentId,
        name: studentName,
        studentName,
        identityType: input.identityType,
        groupId: clean(input.groupId) || undefined,
        groupName: clean(input.groupName) || undefined,
        credentialGeneration,
        issuedAt: now,
        expiresAt: now + STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000,
    };
}

export function createSignedStudentSessionCookie(
    input: StudentSessionCookieInput,
    env: Env = process.env,
    now = Date.now(),
): string | null {
    const secret = resolveStudentSessionSecret(env);
    const session = normalizeCookieInput(input, now);
    if (!secret || !session) return null;

    const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
    return `${payload}.${sign(payload, secret)}`;
}

export function parseSignedStudentSessionCookie(
    rawCookie: string | null | undefined,
    env: Env = process.env,
    now = Date.now(),
): UnifiedStudentServerSession | null {
    const secret = resolveStudentSessionSecret(env);
    if (!secret || !rawCookie) return null;

    const [payload, signature, ...rest] = rawCookie.split(".");
    if (!payload || !signature || rest.length > 0 || !signaturesMatch(signature, sign(payload, secret))) return null;

    try {
        const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
        const issuedAt = Number(parsed.issuedAt);
        const expiresAt = Number(parsed.expiresAt);
        const kind = parsed.kind === "guest" ? "guest" : parsed.kind === "student" ? "student" : null;
        const guestId = clean(parsed.guestId);
        const accountId = clean(parsed.accountId);
        const sourceStudentId = clean(parsed.studentId);
        const studentId = kind === "guest" ? sourceStudentId || (guestId ? `guest:${guestId}` : "") : sourceStudentId;
        const name = clean(parsed.name) || clean(parsed.studentName);
        const organizationId = clean(parsed.organizationId);
        const identityType = clean(parsed.identityType) as IdentityType;
        const credentialGeneration = parsed.credentialGeneration;
        const legacyGuest = parsed.schemaVersion === 1
            && parsed.version === undefined
            && kind === "guest"
            && identityType === "guest";

        if (
            parsed.audience !== "omr-student"
            || (!legacyGuest && (parsed.schemaVersion !== 2 || parsed.version !== 2))
            || !kind
            || !name
            || !studentId
            || (kind === "guest" && !guestId)
            || !["guest", "temporary", "registered"].includes(identityType)
            || !Number.isFinite(issuedAt)
            || !Number.isFinite(expiresAt)
            || issuedAt > now + STUDENT_SERVER_SESSION_CLOCK_SKEW_MS
            || expiresAt <= now
            || expiresAt - issuedAt > STUDENT_SERVER_SESSION_MAX_AGE_SECONDS * 1000
            || (
                kind === "student"
                && identityType === "registered"
                && (
                    !organizationId
                    || !accountId
                    || !STUDENT_CREDENTIAL_ACCOUNT_ID_PATTERN.test(accountId)
                    || typeof credentialGeneration !== "number"
                    || !Number.isSafeInteger(credentialGeneration)
                    || credentialGeneration <= 0
                )
            )
        ) {
            return null;
        }

        return {
            audience: "omr-student",
            schemaVersion: 2,
            version: 2,
            kind,
            ...(guestId ? { guestId } : {}),
            ...(accountId ? { accountId } : {}),
            studentId,
            organizationId,
            name,
            studentName: name,
            groupId: clean(parsed.groupId) || undefined,
            groupName: clean(parsed.groupName) || undefined,
            regionId: clean(parsed.regionId) || undefined,
            regionName: clean(parsed.regionName) || undefined,
            identityType,
            ...(kind === "student" && identityType === "registered"
                ? { credentialGeneration }
                : {}),
            issuedAt,
            expiresAt,
        } as UnifiedStudentServerSession;
    } catch {
        return null;
    }
}

export interface StudentSessionValidationClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export type StudentServerSessionValidationResult =
    | { status: "active"; identity: UnifiedStudentServerSession }
    | { status: "unauthenticated" }
    | { status: "service_unavailable" };

/**
 * Request-start authorization for student server actions. Registered sessions
 * are checked against the exact credential incarnation before canonical data
 * access. A credential rotation committed after this check takes effect on the
 * next request; mutation RPCs keep their existing transaction boundaries.
 */
export async function validateStudentServerSession(
    rawCookie: string | null | undefined,
    client: StudentSessionValidationClient,
    env: Env = process.env,
    now = Date.now(),
): Promise<StudentServerSessionValidationResult> {
    const identity = parseSignedStudentSessionCookie(rawCookie, env, now);
    if (!identity) return { status: "unauthenticated" };
    if (identity.kind === "guest") return { status: "active", identity };
    if (
        identity.identityType !== "registered"
        || !identity.accountId
        || typeof identity.credentialGeneration !== "number"
        || !Number.isSafeInteger(identity.credentialGeneration)
        || (identity.credentialGeneration || 0) <= 0
    ) {
        return env.NODE_ENV === "production"
            ? { status: "unauthenticated" }
            : { status: "active", identity };
    }
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
                timeoutId = setTimeout(
                    () => reject(new Error("student session validation timeout")),
                    STUDENT_SESSION_VALIDATION_TIMEOUT_MS,
                );
            }),
        ]).finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
        if (result.error) return { status: "service_unavailable" };
        return result.data === true
            ? { status: "active", identity }
            : { status: "unauthenticated" };
    } catch {
        return { status: "service_unavailable" };
    }
}

export async function resolveAuthorizedStudentSessionCookie(
    rawCookie: string | null | undefined,
    client: StudentSessionValidationClient,
    env: Env = process.env,
    now = Date.now(),
): Promise<StudentServerSessionValidationResult> {
    return validateStudentServerSession(rawCookie, client, env, now);
}

export function shouldUseSecureStudentSessionCookie(
    hostHeader: string | null | undefined,
    env: Env = process.env,
): boolean {
    if (env.NODE_ENV !== "production") return false;
    const host = clean(hostHeader).toLowerCase().split(",")[0]?.trim() || "";
    if (!host) return true;
    const hostname = host.startsWith("[")
        ? host.slice(1, host.indexOf("]"))
        : host.split(":")[0];
    return hostname !== "localhost"
        && hostname !== "127.0.0.1"
        && hostname !== "::1"
        && !hostname.endsWith(".localhost");
}
