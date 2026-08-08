import { describe, expect, it } from "vitest";
import {
    parseSupabaseDeploymentProbe,
    probeSupabaseDeployment,
    type SupabaseProbeClient,
} from "./supabaseReadinessProbe";

const readyV22Payload = {
    ready: true,
    version: "202608080005",
    browserSchemaPrivilegesDenied: true,
    anonTablePrivilegesDenied: true,
    authenticatedCanonicalPrivilegesDenied: true,
    browserSequencePrivilegesDenied: true,
    browserFunctionPrivilegesDenied: true,
    alphaPoliciesAbsent: true,
    canonicalTablesForceRls: true,
    canonicalPoliciesAbsent: true,
    organizationBackfillReady: true,
    serviceRolePrivilegesReady: true,
    scopedRpcPrivilegesReady: true,
    hostedStorageBoundaryReady: true,
    serverGatewayCapabilitiesReady: true,
    queryPathIndexesReady: true,
    legacyBroadRpcsRemoved: true,
    directUploadIntentLifecycleReady: true,
    teacherUploadCleanupQueueReady: true,
    teacherAssetFinalizePreauthorizationReady: true,
    examReservationLeaseReady: true,
    teacherAssetCleanupBacklogHealthy: true,
    studentAttemptSessionsReady: true,
    durableRateLimitsReady: true,
    examRevisionReady: true,
    teacherExamCasReady: true,
    teacherNotificationSummaryReady: true,
    teacherNotificationStateReady: true,
    feedbackRevisionReady: true,
    feedbackCasReady: true,
    workspaceBootstrapPlanSafe: true,
    sessionCleanupOptimizationReady: true,
    feedbackReplayHardeningReady: true,
    feedbackCoreFreeReady: true,
    examEntryInvitesReady: true,
    sessionCleanupFencingReady: true,
    attemptCheckpointNullCasReady: true,
    rosterSnapshotCasReady: true,
    attemptMutationCasReady: true,
    examDeleteSessionSafe: true,
    studentQuestionAtomicReady: true,
    teacherLiveSessionsReady: true,
    teacherAccountLifecycleReady: true,
    initialOperationsLoadControlReady: true,
    individualStudentAssignmentsReady: true,
    teacherAttemptReportingReady: true,
    operationalJobStatusReady: true,
};

describe("Supabase deployment readiness probe", () => {
    it("accepts only the complete v22 effective-boundary and gateway evidence", () => {
        expect(parseSupabaseDeploymentProbe(readyV22Payload)).toEqual({
            ready: true,
            version: "202608080005",
            browserSchemaPrivilegesDenied: true,
            anonTablePrivilegesDenied: true,
            authenticatedCanonicalPrivilegesDenied: true,
            browserSequencePrivilegesDenied: true,
            browserFunctionPrivilegesDenied: true,
            alphaPoliciesAbsent: true,
            canonicalTablesForceRls: true,
            canonicalPoliciesAbsent: true,
            organizationBackfillReady: true,
            serviceRolePrivilegesReady: true,
            scopedRpcPrivilegesReady: true,
            hostedStorageBoundaryReady: true,
            serverGatewayCapabilitiesReady: true,
            queryPathIndexesReady: true,
            legacyBroadRpcsRemoved: true,
            directUploadIntentLifecycleReady: true,
            teacherUploadCleanupQueueReady: true,
            teacherAssetFinalizePreauthorizationReady: true,
            examReservationLeaseReady: true,
            teacherAssetCleanupBacklogHealthy: true,
            studentAttemptSessionsReady: true,
            durableRateLimitsReady: true,
            examRevisionReady: true,
            teacherExamCasReady: true,
            teacherNotificationSummaryReady: true,
            teacherNotificationStateReady: true,
            feedbackRevisionReady: true,
            feedbackCasReady: true,
            workspaceBootstrapPlanSafe: true,
            sessionCleanupOptimizationReady: true,
            feedbackReplayHardeningReady: true,
            feedbackCoreFreeReady: true,
            examEntryInvitesReady: true,
            sessionCleanupFencingReady: true,
            attemptCheckpointNullCasReady: true,
            rosterSnapshotCasReady: true,
            attemptMutationCasReady: true,
            examDeleteSessionSafe: true,
            studentQuestionAtomicReady: true,
            teacherLiveSessionsReady: true,
            teacherAccountLifecycleReady: true,
            initialOperationsLoadControlReady: true,
            individualStudentAssignmentsReady: true,
            teacherAttemptReportingReady: true,
            operationalJobStatusReady: true,
            failedChecks: [],
        });
    });

    it("fails closed when any v22 evidence key is false or missing", () => {
        for (const key of [
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
        ] as const) {
            expect(parseSupabaseDeploymentProbe({
                ...readyV22Payload,
                [key]: false,
            })).toMatchObject({
                ready: false,
                [key]: false,
                failedChecks: [key],
            });

            const missing = { ...readyV22Payload } as Record<string, unknown>;
            delete missing[key];
            expect(parseSupabaseDeploymentProbe(missing)).toMatchObject({
                ready: false,
                [key]: false,
                failedChecks: [key],
            });
        }
    });

    it("rejects an old probe version or a non-boolean ready declaration", () => {
        expect(parseSupabaseDeploymentProbe({ ready: "true" })).toMatchObject({ ready: false });
        expect(parseSupabaseDeploymentProbe({ ready: true })).toMatchObject({ ready: false });
        expect(parseSupabaseDeploymentProbe({
            ...readyV22Payload,
            version: "202608060029",
        })).toMatchObject({
            ready: false,
            version: "202608060029",
            failedChecks: ["probeVersion"],
        });
        expect(parseSupabaseDeploymentProbe({
            ...readyV22Payload,
            ready: false,
        })).toMatchObject({
            ready: false,
            failedChecks: ["databaseDeclaredReady"],
        });
        expect(parseSupabaseDeploymentProbe(null)).toMatchObject({ ready: false });
    });

    it("rejects a new-version payload missing durable operational job status evidence", () => {
        const oldShape = { ...readyV22Payload } as Record<string, unknown>;
        delete oldShape.operationalJobStatusReady;
        expect(parseSupabaseDeploymentProbe(oldShape)).toMatchObject({
            ready: false,
            version: "202608080005",
            operationalJobStatusReady: false,
            failedChecks: ["operationalJobStatusReady"],
        });
    });

    it("rejects every array shape because the RPC contract is one JSON object", () => {
        for (const payload of [
            [],
            [readyV22Payload],
            [readyV22Payload, readyV22Payload],
        ]) {
            expect(parseSupabaseDeploymentProbe(payload)).toEqual({
                ready: false,
                error: "DB readiness probe returned an invalid payload",
                failedChecks: ["probePayload"],
            });
        }
    });

    it("requires the exact version string without whitespace normalization", () => {
        expect(parseSupabaseDeploymentProbe({
            ...readyV22Payload,
            version: ` ${readyV22Payload.version} `,
        })).toMatchObject({
            ready: false,
            version: ` ${readyV22Payload.version} `,
            failedChecks: ["probeVersion"],
        });
    });

    it("fails closed on RPC errors without echoing database details", async () => {
        const failingClient: SupabaseProbeClient = {
            async rpc() {
                return {
                    data: null,
                    error: { message: "student 김학생 row raw-private-id violated a policy" },
                };
            },
        };
        await expect(probeSupabaseDeployment(failingClient)).resolves.toEqual({
            ready: false,
            error: "DB readiness probe execution failed",
            failedChecks: ["probeExecution"],
        });

        const malformedClient: SupabaseProbeClient = {
            async rpc() {
                return { data: "ready", error: null };
            },
        };
        await expect(probeSupabaseDeployment(malformedClient)).resolves.toMatchObject({ ready: false });
    });

    it("calls only the service-role readiness RPC surface", async () => {
        const calls: string[] = [];
        const client: SupabaseProbeClient = {
            async rpc(name) {
                calls.push(name);
                return { data: readyV22Payload, error: null };
            },
        };

        await expect(probeSupabaseDeployment(client)).resolves.toMatchObject({ ready: true });
        expect(calls).toEqual(["omr_service_readiness_v1"]);
    });

    it("forwards an AbortSignal to abortable PostgREST requests", async () => {
        let receivedSignal: AbortSignal | undefined;
        const request = Promise.resolve({ data: readyV22Payload, error: null }) as Promise<{
            data: unknown;
            error: null;
        }> & { abortSignal(signal: AbortSignal): Promise<{ data: unknown; error: null }> };
        request.abortSignal = (signal) => {
            receivedSignal = signal;
            return request;
        };
        const client: SupabaseProbeClient = { rpc: () => request };
        const controller = new AbortController();
        await expect(probeSupabaseDeployment(client, controller.signal)).resolves.toMatchObject({ ready: true });
        expect(receivedSignal).toBe(controller.signal);
    });
});
