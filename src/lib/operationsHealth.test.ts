import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
    authorizeReadinessRequest,
    buildLivenessPayload,
    probeOperationalReadiness,
} from "./operationsHealth";

const readyConfigurationProbe = () => ({
    label: "배포 준비됨",
    detail: "ready",
    credentialCount: 1,
    readyCount: 1,
    totalCount: 1,
    checks: [{ key: "configuration", label: "configuration", detail: "ready", tone: "ready" as const }],
});

describe("operational health", () => {
    it("exposes only a bounded public liveness payload", () => {
        expect(buildLivenessPayload({
            VERCEL_GIT_COMMIT_SHA: "abc123def456",
            SUPABASE_SERVICE_ROLE_KEY: "must-never-leak",
        }, new Date("2026-08-06T01:02:03.000Z"))).toEqual({
            status: "alive",
            build: "abc123def456",
            timestamp: "2026-08-06T01:02:03.000Z",
        });
    });

    it("requires an exact bearer token and fails closed when configuration is absent", () => {
        const env = { OMR_READINESS_TOKEN: "readiness-token-0123456789" };
        expect(authorizeReadinessRequest(new Headers(), env)).toBe(false);
        expect(authorizeReadinessRequest(new Headers({ authorization: "Basic abc" }), env)).toBe(false);
        expect(authorizeReadinessRequest(new Headers({ authorization: "Bearer wrong" }), env)).toBe(false);
        expect(authorizeReadinessRequest(new Headers({ authorization: "Bearer readiness-token-0123456789" }), env)).toBe(true);
        expect(authorizeReadinessRequest(new Headers({ authorization: "Bearer readiness-token-0123456789 extra" }), env)).toBe(false);
        expect(authorizeReadinessRequest(new Headers({ authorization: "Bearer anything" }), {})).toBe(false);
    });

    it("reports ready only when configured Supabase evidence is complete", async () => {
        const env = {
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/events",
            OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
        };
        await expect(probeOperationalReadiness(env, async () => ({
            ready: true,
            version: "202608060004",
            failedChecks: [],
        }), 50, async () => "ready", readyConfigurationProbe, async () => "ready")).resolves.toEqual({
            status: "ready",
            database: "ready",
            observability: "ready",
            configuration: "ready",
            version: "202608060004",
        });

        await expect(probeOperationalReadiness(env, async () => ({
            ready: false,
            version: "202608060004",
            failedChecks: ["queryPathIndexesReady"],
        }), 50, async () => "ready")).resolves.toEqual({
            status: "not_ready",
            database: "not_ready",
            observability: "ready",
            version: "202608060004",
            failedChecks: ["queryPathIndexesReady"],
        });
    });

    it("fails readiness when fatal deployment configuration is missing", async () => {
        const env = {
            NODE_ENV: "production",
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        };
        const configurationProbe = vi.fn(() => ({
            label: "배포 확인 필요",
            detail: "fatal configuration missing",
            credentialCount: 0,
            readyCount: 0,
            totalCount: 1,
            checks: [{
                key: "teacher_account_delivery",
                label: "교사 계정 이메일 전달",
                detail: "missing",
                tone: "error" as const,
            }],
        }));

        await expect(probeOperationalReadiness(
            env,
            async () => ({ ready: true, version: "202608080005", failedChecks: [] }),
            50,
            async () => "ready",
            configurationProbe,
        )).resolves.toEqual({
            status: "not_ready",
            database: "ready",
            observability: "ready",
            configuration: "not_ready",
            version: "202608080005",
            failedChecks: ["configuration:teacher_account_delivery"],
        });
        expect(configurationProbe).toHaveBeenCalledOnce();
    });

    it("fails readiness when the configured account delivery endpoint is unreachable", async () => {
        const env = {
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
        };

        await expect(probeOperationalReadiness(
            env,
            async () => ({ ready: true, version: "202608080005", failedChecks: [] }),
            50,
            async () => "ready",
            readyConfigurationProbe,
            async () => "probe_failed",
        )).resolves.toEqual({
            status: "not_ready",
            database: "ready",
            observability: "ready",
            configuration: "not_ready",
            version: "202608080005",
            failedChecks: ["configuration:teacher_account_delivery_probe"],
        });
    });

    it("attests the candidate build and hashed database binding for an explicit staging deployment", async () => {
        const projectRef = "stagingprojectref";
        const serviceRoleKey = "service-role-secret-that-must-not-leak";
        const result = await probeOperationalReadiness({
            SUPABASE_URL: `https://${projectRef}.supabase.co`,
            SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
            OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/events",
            OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
            OMR_DEPLOYMENT_TIER: "staging",
            VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
        }, async () => ({
            ready: true,
            version: "202608080005",
            failedChecks: [],
        }), 50, async () => "ready", readyConfigurationProbe, async () => "ready");

        expect(result).toEqual({
            status: "ready",
            database: "ready",
            observability: "ready",
            configuration: "ready",
            version: "202608080005",
            environment: "staging",
            build: "a".repeat(40),
            databaseProjectRefHash: createHash("sha256").update(projectRef).digest("hex"),
        });
        expect(JSON.stringify(result)).not.toContain(projectRef);
        expect(JSON.stringify(result)).not.toContain(serviceRoleKey);
    });

    it("fails readiness when the central operational sink is absent or unreachable", async () => {
        const databaseProbe = vi.fn(async () => ({ ready: true as const, version: "v" }));
        const base = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key" };

        await expect(probeOperationalReadiness(base, databaseProbe, 20, async () => "not_configured", readyConfigurationProbe, async () => "ready"))
            .resolves.toEqual({
                status: "degraded",
                database: "ready",
                observability: "not_configured",
                configuration: "ready",
                version: "v",
            });
        await expect(probeOperationalReadiness({
            ...base,
            OMR_OPERATIONAL_SINK_URL: "https://ops.example.test/events",
            OMR_OPERATIONAL_SINK_TOKEN: "ops_sink_token_0123456789_abcdef",
        }, databaseProbe, 20, async () => "probe_failed", readyConfigurationProbe, async () => "ready")).resolves.toEqual({
            status: "degraded",
            database: "ready",
            observability: "probe_failed",
            configuration: "ready",
            version: "v",
        });
    });

    it("fails closed for missing backend configuration, probe rejection, and timeout", async () => {
        const probe = vi.fn(async () => ({ ready: true as const }));
        await expect(probeOperationalReadiness({}, probe, 20)).resolves.toEqual({
            status: "not_ready",
            database: "not_configured",
            observability: "not_configured",
        });
        expect(probe).not.toHaveBeenCalled();

        const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "key" };
        await expect(probeOperationalReadiness(env, async () => {
            throw new Error("raw database secret");
        }, 20, async () => "not_configured")).resolves.toEqual({
            status: "not_ready",
            database: "probe_failed",
            observability: "not_configured",
        });

        let receivedSignal: AbortSignal | undefined;
        await expect(probeOperationalReadiness(env, (_probeEnv, signal) => {
            receivedSignal = signal;
            return new Promise(() => undefined);
        }, 5, async () => "not_configured")).resolves.toEqual({
            status: "not_ready",
            database: "probe_timeout",
            observability: "not_configured",
        });
        expect(receivedSignal?.aborted).toBe(true);
    });

    it("requires a live healthy asset cleanup heartbeat when the scheduler is configured", async () => {
        const buildSha = "0123456789abcdef0123456789abcdef01234567";
        const env = {
            SUPABASE_URL: "https://example.supabase.co",
            SUPABASE_SERVICE_ROLE_KEY: "service-role",
            OMR_ASSET_GC_SCHEDULED: "1",
            CRON_SECRET: "cron-secret-that-is-at-least-thirty-two-characters",
            VERCEL_GIT_COMMIT_SHA: buildSha,
        };
        const databaseProbe = async () => ({ ready: true as const, version: "v", failedChecks: [] });
        const heartbeatAt = new Date().toISOString();

        await expect(probeOperationalReadiness(
            env,
            databaseProbe,
            50,
            async () => "ready",
            readyConfigurationProbe,
            async () => "ready",
            async () => null,
        )).resolves.toEqual({
            status: "not_ready",
            database: "ready",
            observability: "ready",
            configuration: "not_ready",
            version: "v",
            failedChecks: ["configuration:remote_asset_cleanup_heartbeat"],
        });

        await expect(probeOperationalReadiness(
            env,
            databaseProbe,
            50,
            async () => "ready",
            readyConfigurationProbe,
            async () => "ready",
            async () => ({
                status: "healthy",
                lastAttemptAt: heartbeatAt,
                lastSuccessAt: heartbeatAt,
                deadCount: 0,
                buildSha,
                failureCategory: null,
            }),
        )).resolves.toMatchObject({ status: "ready" });
    });

    it("fails production readiness when the required asset cleanup scheduler is absent", async () => {
        await expect(probeOperationalReadiness(
            {
                NODE_ENV: "production",
                SUPABASE_URL: "https://example.supabase.co",
                SUPABASE_SERVICE_ROLE_KEY: "service-role",
            },
            async () => ({ ready: true, version: "v", failedChecks: [] }),
            50,
            async () => "ready",
            readyConfigurationProbe,
            async () => "ready",
            async () => null,
        )).resolves.toEqual({
            status: "not_ready",
            database: "ready",
            observability: "ready",
            configuration: "not_ready",
            version: "v",
            failedChecks: ["configuration:remote_asset_cleanup_schedule"],
        });
    });
});
