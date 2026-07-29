import { describe, expect, it } from "vitest";
import {
    parseSupabaseDeploymentProbe,
    probeSupabaseDeployment,
    type SupabaseProbeClient,
} from "./supabaseReadinessProbe";

const readyV4Payload = {
    ready: true,
    version: "202607280003",
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
};

describe("Supabase deployment readiness probe", () => {
    it("accepts only the complete v4 effective-boundary evidence", () => {
        expect(parseSupabaseDeploymentProbe(readyV4Payload)).toEqual({
            ready: true,
            version: "202607280003",
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
            failedChecks: [],
        });
    });

    it("fails closed when any v4 evidence key is false or missing", () => {
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
        ] as const) {
            expect(parseSupabaseDeploymentProbe({
                ...readyV4Payload,
                [key]: false,
            })).toMatchObject({
                ready: false,
                [key]: false,
                failedChecks: [key],
            });

            const missing = { ...readyV4Payload } as Record<string, unknown>;
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
            ...readyV4Payload,
            version: "202607140018",
        })).toMatchObject({
            ready: false,
            version: "202607140018",
            failedChecks: ["probeVersion"],
        });
        expect(parseSupabaseDeploymentProbe({
            ...readyV4Payload,
            ready: false,
        })).toMatchObject({
            ready: false,
            failedChecks: ["databaseDeclaredReady"],
        });
        expect(parseSupabaseDeploymentProbe(null)).toMatchObject({ ready: false });
    });

    it("rejects every array shape because the RPC contract is one JSON object", () => {
        for (const payload of [
            [],
            [readyV4Payload],
            [readyV4Payload, readyV4Payload],
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
            ...readyV4Payload,
            version: ` ${readyV4Payload.version} `,
        })).toMatchObject({
            ready: false,
            version: ` ${readyV4Payload.version} `,
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
                return { data: readyV4Payload, error: null };
            },
        };

        await expect(probeSupabaseDeployment(client)).resolves.toMatchObject({ ready: true });
        expect(calls).toEqual(["omr_service_readiness_v1"]);
    });
});
