import { describe, expect, it } from "vitest";
import {
    parseSupabaseDeploymentProbe,
    probeSupabaseDeployment,
    type SupabaseProbeClient,
} from "./supabaseReadinessProbe";

describe("Supabase deployment readiness probe", () => {
    it("accepts only explicit live DB readiness evidence", () => {
        expect(parseSupabaseDeploymentProbe({
            ready: true,
            version: "202607140018",
            attemptRpc: true,
            sessionAttemptRpc: true,
            teacherExamRpc: true,
            teacherExamDeleteRpc: true,
            teacherAttemptRpc: true,
            teacherRosterRpc: true,
            handwritingRpc: true,
            feedbackSaveRpc: true,
            feedbackReturnRpc: true,
            feedbackOpenRpc: true,
            remoteAssetMetadataRpc: true,
            queryPathIndexes: true,
            legacyFeedbackRpcRemoved: true,
            examsForceRls: true,
            attemptsForceRls: true,
            questionResultsForceRls: true,
            studentCredentialsForceRls: true,
            remoteAssetsForceRls: true,
            rosterInvitesForceRls: true,
            attemptFeedbackForceRls: true,
        })).toEqual({
            ready: true,
            version: "202607140018",
            attemptRpc: true,
            sessionAttemptRpc: true,
            teacherExamRpc: true,
            teacherExamDeleteRpc: true,
            teacherAttemptRpc: true,
            teacherRosterRpc: true,
            handwritingRpc: true,
            feedbackSaveRpc: true,
            feedbackReturnRpc: true,
            feedbackOpenRpc: true,
            remoteAssetMetadataRpc: true,
            queryPathIndexes: true,
            legacyFeedbackRpcRemoved: true,
            examsForceRls: true,
            attemptsForceRls: true,
            questionResultsForceRls: true,
            studentCredentialsForceRls: true,
            remoteAssetsForceRls: true,
            rosterInvitesForceRls: true,
            attemptFeedbackForceRls: true,
        });
        expect(parseSupabaseDeploymentProbe({ ready: "true" })).toMatchObject({ ready: false });
        expect(parseSupabaseDeploymentProbe({ ready: true })).toMatchObject({ ready: false });
        expect(parseSupabaseDeploymentProbe({
            ready: true,
            version: "202607140013",
            attemptRpc: true,
            sessionAttemptRpc: true,
            teacherExamRpc: true,
            teacherExamDeleteRpc: true,
            teacherAttemptRpc: true,
            teacherRosterRpc: true,
            handwritingRpc: true,
            feedbackSaveRpc: true,
            feedbackReturnRpc: true,
            feedbackOpenRpc: true,
            remoteAssetMetadataRpc: true,
            queryPathIndexes: true,
            legacyFeedbackRpcRemoved: true,
            examsForceRls: true,
            attemptsForceRls: true,
            questionResultsForceRls: true,
            studentCredentialsForceRls: true,
            remoteAssetsForceRls: true,
            rosterInvitesForceRls: true,
            attemptFeedbackForceRls: true,
        })).toMatchObject({ ready: false, version: "202607140013" });
        expect(parseSupabaseDeploymentProbe(null)).toMatchObject({ ready: false });
    });

    it("fails closed on RPC errors and malformed payloads", async () => {
        const failingClient: SupabaseProbeClient = {
            async rpc() {
                return { data: null, error: { message: "function missing" } };
            },
        };
        await expect(probeSupabaseDeployment(failingClient)).resolves.toEqual({
            ready: false,
            error: "function missing",
        });

        const malformedClient: SupabaseProbeClient = {
            async rpc() {
                return { data: "ready", error: null };
            },
        };
        await expect(probeSupabaseDeployment(malformedClient)).resolves.toMatchObject({ ready: false });
    });
});
