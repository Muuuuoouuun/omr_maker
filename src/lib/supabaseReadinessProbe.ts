import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "./supabaseServerAdmin";

type Env = Record<string, string | undefined>;

export const SUPABASE_READINESS_VERSION = "202607280003";

export const SUPABASE_READINESS_CHECK_KEYS = [
    "browserSchemaPrivilegesDenied",
    "anonTablePrivilegesDenied",
    "authenticatedCanonicalPrivilegesDenied",
    "browserSequencePrivilegesDenied",
    "browserFunctionPrivilegesDenied",
    "alphaPoliciesAbsent",
    "canonicalTablesForceRls",
    "canonicalPoliciesAbsent",
    "organizationBackfillReady",
    "serviceRolePrivilegesReady",
    "scopedRpcPrivilegesReady",
    "hostedStorageBoundaryReady",
    "serverGatewayCapabilitiesReady",
    "queryPathIndexesReady",
    "legacyBroadRpcsRemoved",
] as const;

export type SupabaseReadinessCheckKey = typeof SUPABASE_READINESS_CHECK_KEYS[number];
export type SupabaseReadinessFailureKey =
    | SupabaseReadinessCheckKey
    | "probeVersion"
    | "databaseDeclaredReady"
    | "probeExecution"
    | "probePayload";

export type SupabaseDeploymentProbe = {
    ready: boolean;
    version?: string;
    failedChecks?: SupabaseReadinessFailureKey[];
    error?: string;
} & Partial<Record<SupabaseReadinessCheckKey, boolean>>;

export interface SupabaseProbeClient {
    rpc(name: string): Promise<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

function invalidProbePayload(): SupabaseDeploymentProbe {
    return {
        ready: false,
        error: "DB readiness probe returned an invalid payload",
        failedChecks: ["probePayload"],
    };
}

export function parseSupabaseDeploymentProbe(value: unknown): SupabaseDeploymentProbe {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return invalidProbePayload();
    }

    const row = candidate as Record<string, unknown>;
    const version = clean(row.version);
    const checks = Object.fromEntries(
        SUPABASE_READINESS_CHECK_KEYS.map(key => [key, row[key] === true]),
    ) as Record<SupabaseReadinessCheckKey, boolean>;
    const failedChecks: SupabaseReadinessFailureKey[] = SUPABASE_READINESS_CHECK_KEYS
        .filter(key => !checks[key]);

    if (version !== SUPABASE_READINESS_VERSION) {
        failedChecks.push("probeVersion");
    }
    if (row.ready !== true) {
        failedChecks.push("databaseDeclaredReady");
    }

    return {
        ready: failedChecks.length === 0,
        ...(version ? { version } : {}),
        ...checks,
        failedChecks,
    };
}

export async function probeSupabaseDeployment(
    client: SupabaseProbeClient,
): Promise<SupabaseDeploymentProbe> {
    try {
        const result = await client.rpc("omr_service_readiness_v1");
        if (result.error) {
            return {
                ready: false,
                error: "DB readiness probe execution failed",
                failedChecks: ["probeExecution"],
            };
        }
        return parseSupabaseDeploymentProbe(result.data);
    } catch {
        return {
            ready: false,
            error: "DB readiness probe execution failed",
            failedChecks: ["probeExecution"],
        };
    }
}

export async function probeSupabaseDeploymentWithServiceRole(
    env: Env = process.env,
): Promise<SupabaseDeploymentProbe | null> {
    const config = getSupabaseServerConfigFromEnv(env);
    if (!config) return null;
    const client = createSupabaseAdminClient(config) as unknown as SupabaseProbeClient;
    return probeSupabaseDeployment(client);
}
