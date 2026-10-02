import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    authorizeInitialOperationsRequest,
    initialOperationsResponseHeaders,
    parseInitialOperationsRequestContext,
    resolveInitialOperationsServerConfig,
} from "./initialOperationsControlPlane.server";

const BUILD = "a".repeat(40);
const LOAD_SECRET = "load-secret-that-is-at-least-thirty-two-bytes";
const STAGING_DB = "https://stagingprojectref.supabase.co";
const PRODUCTION_DB = "https://productionproject.supabase.co";

function environment() {
    return {
        NODE_ENV: "production",
        OMR_DEPLOYMENT_TIER: "staging",
        OMR_INITIAL_OPS_LOAD_ENABLED: "1",
        OMR_INITIAL_OPS_TOKEN: LOAD_SECRET,
        OMR_READINESS_TOKEN: "readiness-secret-that-is-distinct-and-long",
        OMR_INITIAL_OPS_STAGING_HOST: "staging.omr.example",
        OMR_PRODUCTION_BASE_URL: "https://omr.example",
        OMR_PRODUCTION_SUPABASE_URL: PRODUCTION_DB,
        SUPABASE_URL: STAGING_DB,
        SUPABASE_SERVICE_ROLE_KEY: "service-role-secret-that-is-at-least-thirty-two-bytes",
        VERCEL_GIT_COMMIT_SHA: BUILD,
        VERCEL_DEPLOYMENT_ID: "dpl_staging_instance_a",
    };
}

describe("initial-operations server control-plane boundary", () => {
    it("enables only an explicitly isolated production-mode staging deployment", () => {
        const env = environment();
        const first = resolveInitialOperationsServerConfig(env);
        expect(first).toMatchObject({
            build: BUILD,
            stagingHost: "staging.omr.example",
            databaseProjectRefHash: createHash("sha256").update("stagingprojectref").digest("hex"),
        });
        expect(first?.serverInstanceId).toMatch(/^instance_[a-f0-9]{16}_[a-f0-9]{16}$/);
        expect(first?.serverInstanceId).not.toBe(env.VERCEL_DEPLOYMENT_ID);
        expect(resolveInitialOperationsServerConfig(env)?.serverInstanceId).toBe(first?.serverInstanceId);
        for (const invalid of [
            { OMR_DEPLOYMENT_TIER: "production" },
            { OMR_INITIAL_OPS_LOAD_ENABLED: "0" },
            { OMR_INITIAL_OPS_TOKEN: "short" },
            { OMR_READINESS_TOKEN: LOAD_SECRET },
            { OMR_INITIAL_OPS_STAGING_HOST: "omr.example" },
            { SUPABASE_URL: PRODUCTION_DB },
            { VERCEL_GIT_COMMIT_SHA: "unknown" },
            { NODE_ENV: "development" },
        ]) {
            expect(resolveInitialOperationsServerConfig({ ...env, ...invalid })).toBeNull();
        }
    });

    it("requires the strong bearer plus run, challenge, build, request, actor, and exact staging host", () => {
        const config = resolveInitialOperationsServerConfig(environment())!;
        const headers = new Headers({
            authorization: `Bearer ${LOAD_SECRET}`,
            host: "staging.omr.example",
            "x-omr-run-id": "run-20260807-live",
            "x-omr-run-challenge": "b".repeat(32),
            "x-omr-expected-build": BUILD,
            "x-omr-request-id": "run-20260807-live:checkpoint:001",
            "x-omr-actor-id": "student_1234567890abcdef_001",
        });
        expect(authorizeInitialOperationsRequest(headers, config)).toBe(true);
        expect(parseInitialOperationsRequestContext(headers, config)).toEqual({
            runId: "run-20260807-live",
            runChallenge: "b".repeat(32),
            requestId: "run-20260807-live:checkpoint:001",
            actorId: "student_1234567890abcdef_001",
        });
        for (const [name, value] of [
            ["authorization", "Bearer wrong-secret-that-is-at-least-thirty-two-bytes"],
            ["host", "omr.example"],
            ["x-omr-run-id", "bad"],
            ["x-omr-run-challenge", "not-a-challenge"],
            ["x-omr-expected-build", "c".repeat(40)],
            ["x-omr-request-id", "foreign-run:request"],
            ["x-omr-actor-id", "../../production"],
        ]) {
            const changed = new Headers(headers);
            changed.set(name, value);
            expect(authorizeInitialOperationsRequest(changed, config)).toBe(false);
            if (name !== "authorization") {
                expect(parseInitialOperationsRequestContext(changed, config)).toBeNull();
            }
        }
    });

    it("returns bounded no-store provenance headers without exposing secrets", () => {
        const config = resolveInitialOperationsServerConfig(environment())!;
        const headers = initialOperationsResponseHeaders(config, 12.3456);
        expect(Object.fromEntries(headers)).toMatchObject({
            "cache-control": "no-store",
            "x-omr-build": BUILD,
            "x-omr-instance-id": config.serverInstanceId,
            "x-omr-server-duration-ms": "12.346",
        });
        expect(JSON.stringify(Object.fromEntries(headers))).not.toContain(LOAD_SECRET);
        expect(headers.get("content-security-policy")).toContain("default-src 'none'");
    });
});
