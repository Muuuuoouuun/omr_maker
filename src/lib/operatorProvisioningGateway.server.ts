import "next/dist/compiled/server-only";

import {
    hashTeacherAccountPasswordAsync,
    normalizeTeacherAccountEmail,
    TEACHER_ACCOUNT_PASSWORD_MAX_LENGTH,
    TEACHER_ACCOUNT_PASSWORD_MIN_LENGTH,
} from "./teacherAccountLifecycle";

export interface OperatorProvisioningGatewayClient {
    rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export type PilotPlan = "pro" | "academy";

export type ProvisionPilotTeacherResult =
    | {
        status: "provisioned";
        organizationId: string;
        accountId: string;
        grantId: string;
        plan: PilotPlan;
        expiresAt: string;
        replayed: boolean;
    }
    | { status: "rejected"; error: "invalid_input" | "conflict" | "capacity_exceeded" }
    | { status: "unavailable"; error: "dependency_unavailable" };

export interface ProvisionPilotTeacherInput {
    organizationName: unknown;
    email: unknown;
    displayName: unknown;
    initialPassword: unknown;
    plan: unknown;
    expiresAt: unknown;
    actor: unknown;
    reason: unknown;
    idempotencyKey: unknown;
}

export interface ProvisionPilotTeacherWithVerifierInput extends Omit<ProvisionPilotTeacherInput, "initialPassword"> {
    encodedVerifier: unknown;
    initialPassword?: undefined;
}

type ValidatedProvisioningInput = {
    organizationName: string;
    email: string;
    displayName: string;
    plan: PilotPlan;
    expiresAt: string;
    actor: string;
    reason: string;
    idempotencyKey: string;
};

const ENCODED_VERIFIER_PATTERN = /^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/;
const ORGANIZATION_ID_PATTERN = /^pilot_org_[a-f0-9]{24}$/;
const ACCOUNT_ID_PATTERN = /^teacher_[a-f0-9]{16}$/;
const GRANT_ID_PATTERN = /^pilot_grant_[a-f0-9]{24}$/;
const RESULT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/;
const MAX_EXPIRY_MS = 366 * 24 * 60 * 60 * 1_000;

function text(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function boundedText(value: unknown, maximumCharacters: number, maximumBytes: number): string | null {
    const normalized = text(value);
    if (
        !normalized
        || normalized.length > maximumCharacters
        || Buffer.byteLength(normalized, "utf8") > maximumBytes
        || /[\u0000-\u001f\u007f]/.test(normalized)
    ) return null;
    return normalized;
}

function validateInput(
    input: Omit<ProvisionPilotTeacherInput, "initialPassword">,
    now: Date,
): ValidatedProvisioningInput | null {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) return null;
    const organizationName = boundedText(input.organizationName, 120, 360);
    const displayName = boundedText(input.displayName, 80, 240);
    const email = normalizeTeacherAccountEmail(input.email);
    const plan = text(input.plan).toLowerCase();
    const expiresAt = text(input.expiresAt);
    const actor = text(input.actor);
    const reason = text(input.reason);
    const idempotencyKey = text(input.idempotencyKey);
    const expiresAtMs = Date.parse(expiresAt);
    if (
        !organizationName
        || !displayName
        || email.length < 3
        || email.length > 254
        || Buffer.byteLength(email, "utf8") > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || (plan !== "pro" && plan !== "academy")
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(expiresAt)
        || !Number.isFinite(expiresAtMs)
        || new Date(expiresAtMs).toISOString() !== expiresAt
        || expiresAtMs <= now.getTime()
        || expiresAtMs > now.getTime() + MAX_EXPIRY_MS
        || actor.length < 10
        || actor.length > 73
        || Buffer.byteLength(actor, "utf8") > 73
        || !/^operator:[a-z0-9][a-z0-9._-]{0,63}$/.test(actor)
        || reason.length > 64
        || Buffer.byteLength(reason, "utf8") > 64
        || !/^[a-z][a-z0-9_]{0,63}$/.test(reason)
        || Buffer.byteLength(idempotencyKey, "utf8") < 37
        || Buffer.byteLength(idempotencyKey, "utf8") > 128
        || !/^prov_[A-Za-z0-9_-]{32,123}$/.test(idempotencyKey)
    ) return null;
    return {
        organizationName,
        email,
        displayName,
        plan,
        expiresAt,
        actor,
        reason,
        idempotencyKey,
    };
}

function row(value: unknown): Record<string, unknown> | null {
    const candidate = Array.isArray(value) ? value[0] : value;
    return candidate && typeof candidate === "object" && !Array.isArray(candidate)
        ? candidate as Record<string, unknown>
        : null;
}

function provisionedResult(
    data: unknown,
    expected: Pick<ValidatedProvisioningInput, "plan" | "expiresAt">,
): ProvisionPilotTeacherResult | null {
    const value = row(data);
    if (!value) return null;
    const organizationId = text(value.organizationId);
    const accountId = text(value.accountId);
    const grantId = text(value.grantId);
    const plan = text(value.plan);
    const expiresAt = text(value.expiresAt);
    if (
        !ORGANIZATION_ID_PATTERN.test(organizationId)
        || !ACCOUNT_ID_PATTERN.test(accountId)
        || !GRANT_ID_PATTERN.test(grantId)
        || (plan !== "pro" && plan !== "academy")
        || !RESULT_TIMESTAMP_PATTERN.test(expiresAt)
        || !Number.isFinite(Date.parse(expiresAt))
        || plan !== expected.plan
        || Date.parse(expiresAt) !== Date.parse(expected.expiresAt)
        || typeof value.replayed !== "boolean"
    ) return null;
    return {
        status: "provisioned",
        organizationId,
        accountId,
        grantId,
        plan,
        expiresAt,
        replayed: value.replayed,
    };
}

function mappedDatabaseError(error: { message?: string }): ProvisionPilotTeacherResult {
    const message = typeof error.message === "string" ? error.message.trim() : "";
    if (message === "invalid_provisioning_request") {
        return { status: "rejected", error: "invalid_input" };
    }
    if (message === "idempotency_conflict" || message === "provisioning_conflict") {
        return { status: "rejected", error: "conflict" };
    }
    if (message === "capacity_exceeded") {
        return { status: "rejected", error: "capacity_exceeded" };
    }
    return { status: "unavailable", error: "dependency_unavailable" };
}

/**
 * Server-only retry seam. A durable operator process can persist the verifier
 * before the RPC and pass the exact same value after an uncertain response.
 */
export async function provisionPilotTeacherWithEncodedVerifier(
    input: ProvisionPilotTeacherWithVerifierInput,
    client: OperatorProvisioningGatewayClient,
    now = new Date(),
): Promise<ProvisionPilotTeacherResult> {
    const validated = validateInput(input, now);
    const encodedVerifier = text(input.encodedVerifier);
    if (!validated || !ENCODED_VERIFIER_PATTERN.test(encodedVerifier)) {
        return { status: "rejected", error: "invalid_input" };
    }
    try {
        const result = await client.rpc("omr_provision_pilot_teacher_v1", {
            p_organization_name: validated.organizationName,
            p_email: validated.email,
            p_display_name: validated.displayName,
            p_password_hash: encodedVerifier,
            p_plan: validated.plan,
            p_expires_at: validated.expiresAt,
            p_actor: validated.actor,
            p_reason: validated.reason,
            p_idempotency_key: validated.idempotencyKey,
        });
        if (result.error) return mappedDatabaseError(result.error);
        return provisionedResult(result.data, validated)
            ?? { status: "unavailable", error: "dependency_unavailable" };
    } catch {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
}

export async function provisionPilotTeacher(
    input: ProvisionPilotTeacherInput,
    client: OperatorProvisioningGatewayClient,
    now = new Date(),
): Promise<ProvisionPilotTeacherResult> {
    const validated = validateInput(input, now);
    const initialPassword = typeof input.initialPassword === "string" ? input.initialPassword : "";
    if (
        !validated
        || initialPassword.length < TEACHER_ACCOUNT_PASSWORD_MIN_LENGTH
        || initialPassword.length > TEACHER_ACCOUNT_PASSWORD_MAX_LENGTH
    ) return { status: "rejected", error: "invalid_input" };
    let encodedVerifier: string;
    try {
        encodedVerifier = await hashTeacherAccountPasswordAsync(initialPassword);
    } catch {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
    return provisionPilotTeacherWithEncodedVerifier({
        ...validated,
        encodedVerifier,
    }, client, now);
}
