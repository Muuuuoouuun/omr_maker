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

function scalarBoolean(data: unknown): boolean {
    const value = Array.isArray(data) ? data[0] : data;
    return value === true;
}

function record(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
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
    const result = await client.rpc("omr_lookup_teacher_account_v1", {
        p_identifier: normalizeTeacherAccountEmail(identifier),
    });
    if (result.error) return null;
    const row = record(Array.isArray(result.data) ? result.data[0] : result.data);
    const status = clean(row?.status);
    const id = clean(row?.id);
    const email = normalizeTeacherAccountEmail(row?.email);
    const displayName = clean(row?.display_name);
    const passwordHash = clean(row?.password_hash);
    const sessionGeneration = safeSessionGeneration(row?.session_generation);
    if (!row || status !== "active" || !id || !email || !displayName || !passwordHash || !sessionGeneration) return null;
    return { id, email, displayName, passwordHash, status: "active", sessionGeneration };
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
    const result = await client.rpc("omr_validate_teacher_session_v1", {
        p_account_id: accountId,
        p_session_generation: sessionGeneration,
    });
    return !result.error && scalarBoolean(result.data);
}
