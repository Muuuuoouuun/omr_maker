import {
    createSupabaseAdminClient,
    getSupabaseServerConfigFromEnv,
} from "./supabaseServerAdmin";

type Env = Record<string, string | undefined>;

export const SUPABASE_READINESS_VERSION = "202607140018";

export interface SupabaseDeploymentProbe {
    ready: boolean;
    version?: string;
    attemptRpc?: boolean;
    sessionAttemptRpc?: boolean;
    teacherExamRpc?: boolean;
    teacherExamDeleteRpc?: boolean;
    teacherAttemptRpc?: boolean;
    teacherRosterRpc?: boolean;
    handwritingRpc?: boolean;
    feedbackSaveRpc?: boolean;
    feedbackReturnRpc?: boolean;
    feedbackOpenRpc?: boolean;
    remoteAssetMetadataRpc?: boolean;
    queryPathIndexes?: boolean;
    legacyFeedbackRpcRemoved?: boolean;
    examsForceRls?: boolean;
    attemptsForceRls?: boolean;
    questionResultsForceRls?: boolean;
    studentCredentialsForceRls?: boolean;
    remoteAssetsForceRls?: boolean;
    rosterInvitesForceRls?: boolean;
    attemptFeedbackForceRls?: boolean;
    error?: string;
}

export interface SupabaseProbeClient {
    rpc(name: string): Promise<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

function clean(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

export function parseSupabaseDeploymentProbe(value: unknown): SupabaseDeploymentProbe {
    const candidate = Array.isArray(value) ? value[0] : value;
    if (!candidate || typeof candidate !== "object") {
        return { ready: false, error: "DB readiness probe returned an invalid payload" };
    }
    const row = candidate as Record<string, unknown>;
    const version = clean(row.version);
    const checks = {
        attemptRpc: row.attemptRpc === true,
        sessionAttemptRpc: row.sessionAttemptRpc === true,
        teacherExamRpc: row.teacherExamRpc === true,
        teacherExamDeleteRpc: row.teacherExamDeleteRpc === true,
        teacherAttemptRpc: row.teacherAttemptRpc === true,
        teacherRosterRpc: row.teacherRosterRpc === true,
        handwritingRpc: row.handwritingRpc === true,
        feedbackSaveRpc: row.feedbackSaveRpc === true,
        feedbackReturnRpc: row.feedbackReturnRpc === true,
        feedbackOpenRpc: row.feedbackOpenRpc === true,
        remoteAssetMetadataRpc: row.remoteAssetMetadataRpc === true,
        queryPathIndexes: row.queryPathIndexes === true,
        legacyFeedbackRpcRemoved: row.legacyFeedbackRpcRemoved === true,
        examsForceRls: row.examsForceRls === true,
        attemptsForceRls: row.attemptsForceRls === true,
        questionResultsForceRls: row.questionResultsForceRls === true,
        studentCredentialsForceRls: row.studentCredentialsForceRls === true,
        remoteAssetsForceRls: row.remoteAssetsForceRls === true,
        rosterInvitesForceRls: row.rosterInvitesForceRls === true,
        attemptFeedbackForceRls: row.attemptFeedbackForceRls === true,
    };
    return {
        ready: row.ready === true
            && version === SUPABASE_READINESS_VERSION
            && Object.values(checks).every(Boolean),
        ...(version ? { version } : {}),
        ...checks,
    };
}

export async function probeSupabaseDeployment(
    client: SupabaseProbeClient,
): Promise<SupabaseDeploymentProbe> {
    try {
        const result = await client.rpc("omr_service_readiness_v1");
        if (result.error) {
            return { ready: false, error: result.error.message || "DB readiness probe failed" };
        }
        return parseSupabaseDeploymentProbe(result.data);
    } catch (error) {
        return {
            ready: false,
            error: error instanceof Error ? error.message : "DB readiness probe failed",
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
