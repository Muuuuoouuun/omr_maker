import { execFileSync, spawnSync } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
    resolveProductionDeploymentConfig,
    runProductionDeploymentVerification,
} from "../../scripts/verify-production-deployment.mjs";

const PROJECT_REF = "production-project-ref";
const BUILD = execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
    encoding: "utf8",
}).trim();
const VERSION = "202608060029";
const PREVIEW_DEPLOYMENT_ID = "preview_deployment:production-42";
const PREVIEW_ARTIFACT_DIGEST = `sha256:${"b".repeat(64)}`;
const RELEASE_ATTESTATION_SECRET = "release-attestation-secret-with-strong-entropy-42";
const READINESS_TOKEN = "readiness-token-which-is-at-least-32-bytes";
const ANON_KEY = "anon-key-which-is-at-least-32-random-bytes";
const AUTH_JWT = `eyJhbGciOiJIUzI1NiJ9.${"a".repeat(32)}.${"b".repeat(32)}`;
const SERVICE_KEY = "service-role-key-which-is-at-least-32-bytes";

function signPreviewIdentity(secret: string): string {
    return createHmac("sha256", secret)
        .update(`${BUILD}\n${PREVIEW_DEPLOYMENT_ID}\n${PREVIEW_ARTIFACT_DIGEST}`, "utf8")
        .digest("hex");
}

const PREVIEW_ATTESTATION_SIGNATURE = signPreviewIdentity(RELEASE_ATTESTATION_SECRET);

function env() {
    return {
        OMR_PRODUCTION_BASE_URL: "https://app.example.com",
        OMR_PRODUCTION_SUPABASE_URL: `https://${PROJECT_REF}.supabase.co`,
        OMR_PRODUCTION_SUPABASE_ANON_KEY: ANON_KEY,
        OMR_PRODUCTION_AUTHENTICATED_JWT: AUTH_JWT,
        OMR_PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
        OMR_READINESS_TOKEN: READINESS_TOKEN,
        OMR_PRODUCTION_EXPECTED_BUILD: BUILD,
        OMR_PRODUCTION_EXPECTED_READINESS_VERSION: VERSION,
        OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID: PREVIEW_DEPLOYMENT_ID,
        OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST: PREVIEW_ARTIFACT_DIGEST,
        OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE: PREVIEW_ATTESTATION_SIGNATURE,
        OMR_RELEASE_ATTESTATION_SECRET: RELEASE_ATTESTATION_SECRET,
    };
}

function response(url: string, body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            ...headers,
        },
    }) as Response & { url: string; redirected: boolean };
}

function fetchFor(options: { build?: string; readyStatus?: string; denyStatus?: number } = {}) {
    return vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://app.example.com/") {
            const result = new Response('<script src="/_next/static/chunks/app.js"></script>', {
                status: 200,
                headers: { "content-type": "text/html" },
            });
            Object.defineProperties(result, { url: { value: url }, redirected: { value: false } });
            return result;
        }
        if (url.endsWith("/_next/static/chunks/app.js")) {
            const result = new Response("console.log('compressed')", {
                status: 200,
                headers: {
                    "content-type": "application/javascript",
                    "content-encoding": "gzip",
                    "cache-control": "public, max-age=31536000, immutable",
                },
            });
            Object.defineProperties(result, { url: { value: url }, redirected: { value: false } });
            return result;
        }
        if (url.endsWith("/api/healthz")) {
            const result = response(url, {
                status: "alive",
                build: options.build ?? BUILD,
                timestamp: new Date().toISOString(),
            });
            Object.defineProperties(result, { url: { value: url }, redirected: { value: false } });
            return result;
        }
        if (url.endsWith("/api/readyz")) {
            expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${READINESS_TOKEN}`);
            const result = response(url, {
                status: options.readyStatus ?? "ready",
                database: "ready",
                observability: "ready",
                configuration: "ready",
                version: VERSION,
            });
            Object.defineProperties(result, { url: { value: url }, redirected: { value: false } });
            return result;
        }
        if (url.endsWith("/rest/v1/rpc/omr_service_readiness_v1")) {
            expect(new Headers(init?.headers).get("apikey")).toBe(SERVICE_KEY);
            const result = response(url, { ready: true, version: VERSION });
            Object.defineProperties(result, { url: { value: url }, redirected: { value: false } });
            return result;
        }
        if (url.includes("/rest/v1/omr_exams")) {
            const headers = new Headers(init?.headers);
            expect(headers.get("apikey")).toBe(ANON_KEY);
            expect(headers.get("authorization")).toMatch(/^Bearer /);
            const result = response(url, { code: "42501" }, options.denyStatus ?? 403);
            Object.defineProperties(result, { url: { value: url }, redirected: { value: false } });
            return result;
        }
        throw new Error(`Unexpected URL: ${url}`);
    });
}

describe("hosted production deployment verification", () => {
    it("fails closed when hosted credentials are missing and the CLI emits unverified", () => {
        expect(() => resolveProductionDeploymentConfig({
            argv: ["--confirm-production-host=app.example.com", "--output=/tmp/release.json"],
            env: {},
            cwd: process.cwd(),
        })).toThrow(/missing|invalid/i);

        const result = spawnSync(process.execPath, ["scripts/verify-production-deployment.mjs"], {
            cwd: process.cwd(),
            env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
            encoding: "utf8",
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({ status: "unverified" });
    });

    it("binds the checked-out verifier SHA, release identity, readiness version, and Supabase project hash", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-contract-"));
        const config = resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: env(),
            cwd: process.cwd(),
        });

        expect(config).toMatchObject({
            baseUrl: "https://app.example.com",
            supabaseUrl: `https://${PROJECT_REF}.supabase.co`,
            productionHost: "app.example.com",
            expectedBuild: BUILD,
            verifierSha: BUILD,
            previewDeploymentId: PREVIEW_DEPLOYMENT_ID,
            previewArtifactDigest: PREVIEW_ARTIFACT_DIGEST,
            previewIdentityAttested: true,
            expectedReadinessVersion: VERSION,
            databaseProjectRefHash: createHash("sha256").update(PROJECT_REF).digest("hex"),
        });
        expect(JSON.stringify(config)).not.toContain(READINESS_TOKEN);
        expect(JSON.stringify(config)).not.toContain(SERVICE_KEY);
        expect(JSON.stringify(config)).not.toContain(RELEASE_ATTESTATION_SECRET);
        expect(JSON.stringify(config)).not.toContain(PREVIEW_ATTESTATION_SIGNATURE);
    });

    it("fails closed unless the expected build is the checked-out verifier HEAD", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-sha-"));
        expect(() => resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: { ...env(), OMR_PRODUCTION_EXPECTED_BUILD: "f".repeat(40) },
            cwd: process.cwd(),
        })).toThrow(/verifier.*expected build|expected build.*verifier/i);
    });

    it("rejects a non-canonical expected build even when it identifies the same commit", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-canonical-sha-"));
        expect(() => resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: { ...env(), OMR_PRODUCTION_EXPECTED_BUILD: BUILD.toUpperCase() },
            cwd: process.cwd(),
        })).toThrow(/expected production build.*invalid/i);
    });

    it("rejects whitespace-padded expected builds", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-padded-sha-"));
        expect(() => resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: { ...env(), OMR_PRODUCTION_EXPECTED_BUILD: ` ${BUILD}` },
            cwd: process.cwd(),
        })).toThrow(/expected production build.*invalid/i);
    });

    it.each([
        ["missing deployment ID", "OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID", undefined],
        ["malformed deployment ID", "OMR_PRODUCTION_PREVIEW_DEPLOYMENT_ID", "preview deployment/42"],
        ["missing artifact digest", "OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST", undefined],
        ["63-character artifact digest", "OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST", `sha256:${"a".repeat(63)}`],
        ["65-character artifact digest", "OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST", `sha256:${"a".repeat(65)}`],
        ["uppercase artifact digest", "OMR_PRODUCTION_PREVIEW_ARTIFACT_DIGEST", `sha256:${"A".repeat(64)}`],
    ])("fails closed for a %s", (_label, key, value) => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-identity-"));
        const invalidEnv: Record<string, string | undefined> = { ...env(), [key]: value };
        expect(() => resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: invalidEnv,
            cwd: process.cwd(),
        })).toThrow(/preview.*missing|preview.*invalid/i);
    });

    it.each([
        ["missing secret", "OMR_RELEASE_ATTESTATION_SECRET", undefined],
        ["short secret", "OMR_RELEASE_ATTESTATION_SECRET", "s".repeat(31)],
        ["long secret", "OMR_RELEASE_ATTESTATION_SECRET", "s".repeat(513)],
        ["secret containing whitespace", "OMR_RELEASE_ATTESTATION_SECRET", `${"s".repeat(32)} space`],
        ["missing signature", "OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE", undefined],
        ["malformed signature", "OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE", "g".repeat(64)],
        ["incorrect signature", "OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE", "0".repeat(64)],
    ])("fails closed for an attestation with a %s", (_label, key, value) => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-attestation-"));
        const invalidEnv: Record<string, string | undefined> = { ...env(), [key]: value };
        let failure: Error | undefined;
        try {
            resolveProductionDeploymentConfig({
                argv: [
                    "--confirm-production-host=app.example.com",
                    `--output=${join(outputRoot, "release.json")}`,
                ],
                env: invalidEnv,
                cwd: process.cwd(),
            });
        } catch (error) {
            failure = error as Error;
        }
        expect(failure?.message).toMatch(/release attestation.*missing|release attestation.*invalid/i);
        expect(failure?.message).not.toContain(String(value));
    });

    it("rejects a release attestation secret reused as another production credential", () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-attestation-reuse-"));
        expect(() => resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: {
                ...env(),
                OMR_RELEASE_ATTESTATION_SECRET: READINESS_TOKEN,
                OMR_PRODUCTION_PREVIEW_ATTESTATION_SIGNATURE: signPreviewIdentity(READINESS_TOKEN),
            },
            cwd: process.cwd(),
        })).toThrow(/credentials.*distinct/i);
    });

    it("requires ready health, direct service readiness, and both anon/authenticated table denials", async () => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-run-"));
        const config = resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: env(),
            cwd: process.cwd(),
        });
        const result = await runProductionDeploymentVerification(config, fetchFor());

        expect(result).toMatchObject({
            status: "verified",
            build: BUILD,
            readinessVersion: VERSION,
            databaseProjectRefHash: config.databaseProjectRefHash,
            access: { anon: "denied", authenticated: "denied" },
            staticAssetCompression: { statusCode: 200, encoding: "gzip", cachePolicy: "immutable" },
        });
        expect(JSON.parse(readFileSync(config.outputPath, "utf8"))).toEqual(result);
        expect(JSON.stringify(result)).not.toContain(ANON_KEY);
        expect(JSON.stringify(result)).not.toContain(AUTH_JWT);
        expect(JSON.stringify(result)).not.toContain(SERVICE_KEY);
        expect(JSON.stringify(result)).not.toContain(RELEASE_ATTESTATION_SECRET);
        expect(JSON.stringify(result)).not.toContain(PREVIEW_ATTESTATION_SIGNATURE);
        expect(result.releaseIdentity).toEqual({
            verifierSha: BUILD,
            deployedSha: BUILD,
            previewDeploymentId: PREVIEW_DEPLOYMENT_ID,
            previewArtifactDigest: PREVIEW_ARTIFACT_DIGEST,
            previewIdentityAttested: true,
        });
    });

    it.each([
        ["wrong build", { build: "b".repeat(40) }],
        ["degraded readiness", { readyStatus: "degraded" }],
        ["anon/auth read succeeds", { denyStatus: 200 }],
    ])("rejects %s", async (_label, fetchOptions) => {
        const outputRoot = mkdtempSync(join(tmpdir(), "omr-release-reject-"));
        const config = resolveProductionDeploymentConfig({
            argv: [
                "--confirm-production-host=app.example.com",
                `--output=${join(outputRoot, "release.json")}`,
            ],
            env: env(),
            cwd: process.cwd(),
        });
        await expect(runProductionDeploymentVerification(config, fetchFor(fetchOptions))).rejects.toThrow();
    });

    it("keeps package and workflow entrypoints wired to the verifier", () => {
        const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8"));
        const workflow = readFileSync(resolve(".github/workflows/production-readiness.yml"), "utf8");
        expect(packageJson.scripts["ops:verify:production"]).toBe("node scripts/verify-production-deployment.mjs");
        expect(workflow).toContain("npm run ops:verify:production");
        expect(workflow).toContain("environment: production");
        expect(workflow).toContain("upload-artifact");
        expect(workflow).toContain("github.event.repository.default_branch");
        expect(workflow).toContain('ref: ${{ inputs.expected_build }}');
        expect(execFileSync(process.execPath, ["--check", "scripts/verify-production-deployment.mjs"], { encoding: "utf8" })).toBe("");
    });
});
