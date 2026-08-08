import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "./supabaseServerAdmin";

type Env = Record<string, string | undefined>;

export const SUPABASE_READINESS_VERSION = "202608080010";

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
    "directUploadIntentLifecycleReady",
    "teacherUploadCleanupQueueReady",
    "teacherAssetFinalizePreauthorizationReady",
    "examReservationLeaseReady",
    "teacherAssetCleanupBacklogHealthy",
    "studentAttemptSessionsReady",
    "durableRateLimitsReady",
    "examRevisionReady",
    "teacherExamCasReady",
    "teacherNotificationSummaryReady",
    "teacherNotificationStateReady",
    "feedbackRevisionReady",
    "feedbackCasReady",
    "workspaceBootstrapPlanSafe",
    "sessionCleanupOptimizationReady",
    "feedbackReplayHardeningReady",
    "feedbackCoreFreeReady",
    "examEntryInvitesReady",
    "sessionCleanupFencingReady",
    "attemptCheckpointNullCasReady",
    "rosterSnapshotCasReady",
    "attemptMutationCasReady",
    "examDeleteSessionSafe",
    "studentQuestionAtomicReady",
    "teacherLiveSessionsReady",
    "teacherAccountLifecycleReady",
    "initialOperationsLoadControlReady",
    "individualStudentAssignmentsReady",
    "teacherAttemptReportingReady",
    "operationalJobStatusReady",
    "operatorPilotProvisioningReady",
    "provisionedTeacherLoginReady",
    "effectiveWorkspacePlanEnforcementReady",
    "studentSessionGenerationReady",
    "studentCredentialBatchReady",
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
    rpc(name: string): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }> & {
        abortSignal?(signal: AbortSignal): PromiseLike<{
            data: unknown;
            error: { message?: string } | null;
        }>;
    };
}

function invalidProbePayload(): SupabaseDeploymentProbe {
    return {
        ready: false,
        error: "DB readiness probe returned an invalid payload",
        failedChecks: ["probePayload"],
    };
}

export function parseSupabaseDeploymentProbe(value: unknown): SupabaseDeploymentProbe {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return invalidProbePayload();
    }

    const row = value as Record<string, unknown>;
    const version = typeof row.version === "string" ? row.version : "";
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
    signal?: AbortSignal,
): Promise<SupabaseDeploymentProbe> {
    try {
        const request = client.rpc("omr_service_readiness_v1");
        const result = await (signal && request.abortSignal ? request.abortSignal(signal) : request);
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
    signal?: AbortSignal,
): Promise<SupabaseDeploymentProbe | null> {
    const config = getSupabaseServerConfigFromEnv(env);
    if (!config) return null;
    const client = createSupabaseAdminClient(config) as unknown as SupabaseProbeClient;
    return probeSupabaseDeployment(client, signal);
}
