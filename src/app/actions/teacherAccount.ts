"use server";

import { randomBytes } from "node:crypto";
import { headers } from "next/headers";
import { applyDurableRateLimit } from "@/lib/durableRateLimit";
import {
    deliverTeacherAccountToken,
    resolveTeacherAccountDeliveryAdapter,
} from "@/lib/teacherAccountDelivery";
import {
    beginTeacherPasswordReset,
    beginTeacherSignup,
    completeTeacherPasswordReset,
    verifyTeacherEmail,
    type TeacherAccountGatewayClient,
} from "@/lib/teacherAccountGateway";
import {
    createTeacherAccountToken,
    hashTeacherAccountPasswordAsync,
    hashTeacherAccountToken,
    isValidTeacherAccountEmail,
    normalizeTeacherAccountEmail,
    validateTeacherSignupInput,
} from "@/lib/teacherAccountLifecycle";
import { isSameOriginServerActionRequest } from "@/lib/serverActionSecurity";
import { resolveTeacherIdentityMode } from "@/lib/teacherIdentityMode";
import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "@/lib/supabaseServerAdmin";

export type TeacherAccountPublicStatus =
    | "accepted"
    | "completed"
    | "verified"
    | "invalid_input"
    | "invalid_or_expired"
    | "dependency_unavailable"
    | "delivery_unavailable"
    | "rate_limited"
    | "service_unavailable"
    | "unauthenticated";

const REQUEST_POLICY = { limit: 5, windowMs: 60 * 60 * 1_000 };
const COMPLETE_POLICY = { limit: 10, windowMs: 60 * 60 * 1_000 };

function teacherSelfServiceUnavailable(): boolean {
    return resolveTeacherIdentityMode() !== "self_service";
}

function gatewayClient(): TeacherAccountGatewayClient | null {
    const config = getSupabaseServerConfigFromEnv();
    return config
        ? createSupabaseAdminClient(config) as unknown as TeacherAccountGatewayClient
        : null;
}

function opaqueId(prefix: "teacher" | "teacher_token"): string {
    return `${prefix}_${randomBytes(prefix === "teacher" ? 8 : 12).toString("hex")}`;
}

function fingerprint(headerStore: Headers): string {
    return headerStore.get("x-forwarded-for")?.split(",")[0]?.trim()
        || headerStore.get("x-real-ip")?.trim()
        || "unknown-client";
}

async function actionHeaders(): Promise<Headers | null> {
    const headerStore = await headers();
    if (!headerStore.get("origin") || !isSameOriginServerActionRequest(headerStore)) return null;
    return headerStore;
}

async function allowed(namespace: string, subject: string, policy = REQUEST_POLICY): Promise<boolean> {
    const result = await applyDurableRateLimit({ namespace, subject, operation: "consume", policy });
    return result.allowed;
}

export async function requestTeacherSignup(input: {
    email: string;
    displayName: string;
    password: string;
}): Promise<{ status: TeacherAccountPublicStatus }> {
    if (teacherSelfServiceUnavailable()) return { status: "dependency_unavailable" };
    const headerStore = await actionHeaders();
    if (!headerStore) return { status: "unauthenticated" };
    const validated = validateTeacherSignupInput(input);
    if (!validated.ok) return { status: "invalid_input" };
    const delivery = resolveTeacherAccountDeliveryAdapter();
    if (!delivery) return { status: "delivery_unavailable" };
    if (!await allowed("teacher-signup", `${fingerprint(headerStore)}\u0000${validated.value.email}`)) {
        return { status: "rate_limited" };
    }
    const client = gatewayClient();
    if (!client) return { status: "service_unavailable" };

    const now = Date.now();
    const token = createTeacherAccountToken("email_verify", now);
    const persisted = await beginTeacherSignup(client, {
        accountId: opaqueId("teacher"),
        tokenId: opaqueId("teacher_token"),
        email: validated.value.email,
        displayName: validated.value.displayName,
        passwordHash: await hashTeacherAccountPasswordAsync(validated.value.password),
        tokenHash: token.tokenHash,
        expiresAt: new Date(token.expiresAt),
    });
    if (persisted.status === "service_unavailable") return { status: "service_unavailable" };
    if (persisted.status === "duplicate") return { status: "accepted" };
    const delivered = await deliverTeacherAccountToken({
        purpose: token.purpose,
        email: validated.value.email,
        token: token.token,
        expiresAt: token.expiresAt,
    }, delivery);
    return { status: delivered.status === "delivered" ? "accepted" : "service_unavailable" };
}

export async function requestTeacherPasswordReset(
    emailInput: string,
): Promise<{ status: TeacherAccountPublicStatus }> {
    if (teacherSelfServiceUnavailable()) return { status: "dependency_unavailable" };
    const headerStore = await actionHeaders();
    if (!headerStore) return { status: "unauthenticated" };
    const email = normalizeTeacherAccountEmail(emailInput);
    if (!isValidTeacherAccountEmail(email)) return { status: "invalid_input" };
    const delivery = resolveTeacherAccountDeliveryAdapter();
    if (!delivery) return { status: "delivery_unavailable" };
    if (!await allowed("teacher-password-reset-request", `${fingerprint(headerStore)}\u0000${email}`)) {
        return { status: "rate_limited" };
    }
    const client = gatewayClient();
    if (!client) return { status: "service_unavailable" };

    const token = createTeacherAccountToken("password_reset");
    const persisted = await beginTeacherPasswordReset(client, {
        tokenId: opaqueId("teacher_token"),
        email,
        tokenHash: token.tokenHash,
        expiresAt: new Date(token.expiresAt),
    });
    if (persisted.status === "service_unavailable") return { status: "service_unavailable" };
    if (persisted.deliveryRequired) {
        const delivered = await deliverTeacherAccountToken({
            purpose: token.purpose,
            email,
            token: token.token,
            expiresAt: token.expiresAt,
        }, delivery);
        if (delivered.status !== "delivered") return { status: "service_unavailable" };
    }
    // Account existence is deliberately not exposed.
    return { status: "accepted" };
}

export async function finishTeacherPasswordReset(input: {
    token: string;
    password: string;
}): Promise<{ status: TeacherAccountPublicStatus }> {
    if (teacherSelfServiceUnavailable()) return { status: "dependency_unavailable" };
    const headerStore = await actionHeaders();
    if (!headerStore) return { status: "unauthenticated" };
    const token = typeof input.token === "string" ? input.token.trim() : "";
    const passwordCheck = validateTeacherSignupInput({
        email: "validation@example.com",
        displayName: "validation",
        password: input.password,
    });
    if (!token || token.length > 512 || !passwordCheck.ok) return { status: "invalid_input" };
    if (!await allowed("teacher-password-reset-complete", fingerprint(headerStore), COMPLETE_POLICY)) {
        return { status: "rate_limited" };
    }
    const client = gatewayClient();
    if (!client) return { status: "service_unavailable" };
    const result = await completeTeacherPasswordReset(client, {
        tokenHash: hashTeacherAccountToken(token),
        passwordHash: await hashTeacherAccountPasswordAsync(input.password),
    });
    return { status: result.status };
}

export async function confirmTeacherSignupEmail(
    tokenInput: string,
): Promise<{ status: TeacherAccountPublicStatus }> {
    if (teacherSelfServiceUnavailable()) return { status: "dependency_unavailable" };
    const headerStore = await actionHeaders();
    if (!headerStore) return { status: "unauthenticated" };
    const token = typeof tokenInput === "string" ? tokenInput.trim() : "";
    if (!token || token.length > 512) return { status: "invalid_input" };
    if (!await allowed("teacher-email-verify", fingerprint(headerStore), COMPLETE_POLICY)) {
        return { status: "rate_limited" };
    }
    const client = gatewayClient();
    if (!client) return { status: "service_unavailable" };
    const result = await verifyTeacherEmail(client, hashTeacherAccountToken(token));
    return { status: result.status };
}
