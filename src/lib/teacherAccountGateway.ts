import { normalizeTeacherAccountEmail } from "./teacherAccountLifecycle";

export interface TeacherAccountGatewayClient {
    rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export interface ActiveTeacherAccount {
    id: string;
    email: string;
    displayName: string;
    passwordHash: string;
    status: "active";
    sessionGeneration: number;
}

export interface ProvisionedTeacherLogin {
    accountId: string;
    email: string;
    displayName: string;
    passwordHash: string;
    sessionGeneration: number;
    organizationId: string;
    organizationName: string;
    memberRole: "owner";
    plan: "free" | "pro" | "academy";
    grantExpiresAt: string | null;
}

export interface ProvisionedTeacherSessionValidation {
    accountId: string;
    sessionGeneration: number;
    organizationId: string;
    organizationName: string;
    memberRole: "owner";
    plan: "free" | "pro" | "academy";
    grantExpiresAt: string | null;
}

function scalarBoolean(data: unknown): boolean {
    const value = Array.isArray(data) ? data[0] : data;
    return value === true;
}

function exactOwnDataRecord(
    value: unknown,
    keys: readonly string[],
    allowSingletonArray = false,
): Record<string, unknown> | null {
    const candidate = Array.isArray(value)
        ? (allowSingletonArray && value.length === 1 ? value[0] : null)
        : value;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
    try {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null) return null;
        if (Object.getOwnPropertySymbols(candidate).length > 0) return null;
        const descriptors = Object.getOwnPropertyDescriptors(candidate);
        const actualKeys = Object.keys(descriptors).sort();
        const expectedKeys = [...keys].sort();
        if (actualKeys.length !== expectedKeys.length
            || actualKeys.some((key, index) => key !== expectedKeys[index])) return null;
        for (const key of expectedKeys) {
            const descriptor = descriptors[key];
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
        }
        return Object.fromEntries(expectedKeys.map(key => [key, descriptors[key]!.value]));
    } catch {
        return null;
    }
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function safeSessionGeneration(value: unknown): number | null {
    const generation = typeof value === "number" ? value : Number(value);
    return Number.isSafeInteger(generation) && generation >= 1 ? generation : null;
}

export async function beginTeacherSignup(
    client: TeacherAccountGatewayClient,
    input: {
        accountId: string;
        tokenId: string;
        email: string;
        displayName: string;
        passwordHash: string;
        tokenHash: string;
        expiresAt: Date;
    },
): Promise<{ status: "created" | "duplicate" | "service_unavailable" }> {
    const result = await client.rpc("omr_begin_teacher_signup_v1", {
        p_account_id: input.accountId,
        p_token_id: input.tokenId,
        p_email: input.email,
        p_display_name: input.displayName,
        p_password_hash: input.passwordHash,
        p_token_hash: input.tokenHash,
        p_expires_at: input.expiresAt.toISOString(),
    });
    if (result.error) return { status: "service_unavailable" };
    return { status: scalarBoolean(result.data) ? "created" : "duplicate" };
}

export async function beginTeacherPasswordReset(
    client: TeacherAccountGatewayClient,
    input: { tokenId: string; email: string; tokenHash: string; expiresAt: Date },
): Promise<
    | { status: "accepted"; deliveryRequired: boolean }
    | { status: "service_unavailable"; deliveryRequired: false }
> {
    const result = await client.rpc("omr_begin_teacher_password_reset_v1", {
        p_token_id: input.tokenId,
        p_email: input.email,
        p_token_hash: input.tokenHash,
        p_expires_at: input.expiresAt.toISOString(),
    });
    if (result.error) return { status: "service_unavailable", deliveryRequired: false };
    return { status: "accepted", deliveryRequired: scalarBoolean(result.data) };
}

export async function completeTeacherPasswordReset(
    client: TeacherAccountGatewayClient,
    input: { tokenHash: string; passwordHash: string },
): Promise<{ status: "completed" | "invalid_or_expired" | "service_unavailable" }> {
    const result = await client.rpc("omr_complete_teacher_password_reset_v1", {
        p_token_hash: input.tokenHash,
        p_password_hash: input.passwordHash,
    });
    if (result.error) return { status: "service_unavailable" };
    return { status: scalarBoolean(result.data) ? "completed" : "invalid_or_expired" };
}

export async function verifyTeacherEmail(
    client: TeacherAccountGatewayClient,
    tokenHash: string,
): Promise<{ status: "verified" | "invalid_or_expired" | "service_unavailable" }> {
    const result = await client.rpc("omr_verify_teacher_email_v1", { p_token_hash: tokenHash });
    if (result.error) return { status: "service_unavailable" };
    return { status: scalarBoolean(result.data) ? "verified" : "invalid_or_expired" };
}

export async function findActiveTeacherAccount(
    client: TeacherAccountGatewayClient,
    identifier: string,
): Promise<ActiveTeacherAccount | null> {
    let result: Awaited<ReturnType<TeacherAccountGatewayClient["rpc"]>>;
    try {
        result = await client.rpc("omr_lookup_teacher_account_v1", {
            p_identifier: normalizeTeacherAccountEmail(identifier),
        });
    } catch {
        return null;
    }
    if (result.error) return null;
    const row = exactOwnDataRecord(result.data, [
        "id", "email", "display_name", "password_hash", "status", "session_generation",
    ]);
    const status = clean(row?.status);
    const id = clean(row?.id);
    const email = normalizeTeacherAccountEmail(row?.email);
    const displayName = clean(row?.display_name);
    const passwordHash = clean(row?.password_hash);
    const sessionGeneration = safeSessionGeneration(row?.session_generation);
    if (!row || status !== "active" || !id || !email || !displayName || !passwordHash || !sessionGeneration) return null;
    return { id, email, displayName, passwordHash, status: "active", sessionGeneration };
}

const ACCOUNT_ID_PATTERN = /^teacher_[a-f0-9]{16}$/;
const PILOT_ORGANIZATION_ID_PATTERN = /^pilot_org_[a-f0-9]{24}$/;
const PASSWORD_HASH_PATTERN = /^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/;
const UTC_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

function validPlanFields(plan: string, expiresAt: unknown, now: number): expiresAt is string | null {
    if (plan === "free") return expiresAt === null;
    return (plan === "pro" || plan === "academy")
        && typeof expiresAt === "string"
        && UTC_INSTANT_PATTERN.test(expiresAt)
        && Number.isFinite(Date.parse(expiresAt))
        && Date.parse(expiresAt) > now;
}

export async function lookupProvisionedTeacherLogin(
    client: TeacherAccountGatewayClient,
    identifier: string,
    now = Date.now(),
): Promise<ProvisionedTeacherLogin | null> {
    let result: Awaited<ReturnType<TeacherAccountGatewayClient["rpc"]>>;
    try {
        result = await client.rpc("omr_lookup_provisioned_teacher_login_v1", {
            p_identifier: normalizeTeacherAccountEmail(identifier),
        });
    } catch {
        return null;
    }
    if (result.error) return null;
    const row = exactOwnDataRecord(result.data, [
        "accountId", "email", "displayName", "passwordHash", "sessionGeneration",
        "organizationId", "organizationName", "memberRole", "plan", "grantExpiresAt",
    ]);
    if (!row) return null;
    const accountId = clean(row.accountId);
    const email = normalizeTeacherAccountEmail(row.email);
    const displayName = clean(row.displayName);
    const passwordHash = clean(row.passwordHash);
    const sessionGeneration = safeSessionGeneration(row.sessionGeneration);
    const organizationId = clean(row.organizationId).toLowerCase();
    const organizationName = clean(row.organizationName);
    const memberRole = clean(row.memberRole);
    const plan = clean(row.plan);
    if (!ACCOUNT_ID_PATTERN.test(accountId) || !email || !displayName
        || !PASSWORD_HASH_PATTERN.test(passwordHash) || !sessionGeneration
        || !PILOT_ORGANIZATION_ID_PATTERN.test(organizationId) || !organizationName
        || memberRole !== "owner" || !validPlanFields(plan, row.grantExpiresAt, now)) return null;
    return {
        accountId, email, displayName, passwordHash, sessionGeneration,
        organizationId, organizationName, memberRole: "owner",
        plan: plan as ProvisionedTeacherLogin["plan"],
        grantExpiresAt: row.grantExpiresAt,
    };
}

export async function validateProvisionedTeacherSession(
    client: TeacherAccountGatewayClient,
    accountId: string,
    sessionGeneration: number,
    organizationId: string,
    now = Date.now(),
): Promise<ProvisionedTeacherSessionValidation | null> {
    if (!ACCOUNT_ID_PATTERN.test(accountId) || !Number.isSafeInteger(sessionGeneration)
        || sessionGeneration < 1 || !PILOT_ORGANIZATION_ID_PATTERN.test(organizationId)) return null;
    let result: Awaited<ReturnType<TeacherAccountGatewayClient["rpc"]>>;
    try {
        result = await client.rpc("omr_validate_provisioned_teacher_session_v1", {
            p_account_id: accountId,
            p_session_generation: sessionGeneration,
            p_organization_id: organizationId,
        });
    } catch {
        return null;
    }
    if (result.error) return null;
    const row = exactOwnDataRecord(result.data, [
        "accountId", "sessionGeneration", "organizationId", "organizationName",
        "memberRole", "plan", "grantExpiresAt",
    ]);
    if (!row) return null;
    const returnedAccountId = clean(row.accountId);
    const returnedGeneration = safeSessionGeneration(row.sessionGeneration);
    const returnedOrganizationId = clean(row.organizationId).toLowerCase();
    const organizationName = clean(row.organizationName);
    const memberRole = clean(row.memberRole);
    const plan = clean(row.plan);
    if (returnedAccountId !== accountId || returnedGeneration !== sessionGeneration
        || returnedOrganizationId !== organizationId || !organizationName
        || memberRole !== "owner" || !validPlanFields(plan, row.grantExpiresAt, now)) return null;
    return {
        accountId, sessionGeneration, organizationId, organizationName,
        memberRole: "owner", plan: plan as ProvisionedTeacherSessionValidation["plan"],
        grantExpiresAt: row.grantExpiresAt,
    };
}

/** Lightweight request-time check; it never returns password/account data. */
export async function validateActiveTeacherAccountSession(
    client: TeacherAccountGatewayClient,
    accountId: string,
    sessionGeneration: number,
): Promise<boolean> {
    if (!/^teacher_[a-z0-9]{16}$/.test(accountId) || !Number.isSafeInteger(sessionGeneration) || sessionGeneration < 1) {
        return false;
    }
    let result: Awaited<ReturnType<TeacherAccountGatewayClient["rpc"]>>;
    try {
        result = await client.rpc("omr_validate_teacher_session_v1", {
            p_account_id: accountId,
            p_session_generation: sessionGeneration,
        });
    } catch {
        return false;
    }
    return !result.error && scalarBoolean(result.data);
}
