import "next/dist/compiled/server-only";

import { probeProvisionedTeacherCanary, type TeacherAccountGatewayClient } from "./teacherAccountGateway";
import { createSupabaseAdminClient, getSupabaseServerConfigFromEnv } from "./supabaseServerAdmin";

type Env = Record<string, string | undefined>;
export type ProvisionedTeacherCanaryReadiness = "ready" | "not_configured" | "not_ready";

const CANARY_ACCOUNT_ID_PATTERN = /^teacher_[a-f0-9]{16}$/;

export function resolveProvisionedTeacherCanaryAccountId(env: Env = process.env): string | null {
    const value = env.OMR_PROVISIONED_TEACHER_CANARY_ACCOUNT_ID;
    return typeof value === "string" && CANARY_ACCOUNT_ID_PATTERN.test(value) ? value : null;
}

export async function probeConfiguredProvisionedTeacherCanary(
    env: Env = process.env,
    signal?: AbortSignal,
    injectedClient?: TeacherAccountGatewayClient,
): Promise<ProvisionedTeacherCanaryReadiness> {
    const accountId = resolveProvisionedTeacherCanaryAccountId(env);
    if (!accountId) return "not_configured";
    const config = injectedClient ? null : getSupabaseServerConfigFromEnv(env);
    const client = injectedClient || (config
        ? createSupabaseAdminClient(config) as unknown as TeacherAccountGatewayClient
        : null);
    if (!client) return "not_configured";
    return await probeProvisionedTeacherCanary(client, accountId, signal) ? "ready" : "not_ready";
}
