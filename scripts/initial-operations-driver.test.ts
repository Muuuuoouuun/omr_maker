import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const STAGING = "https://staging.omr.example";
const PRODUCTION = "https://omr.example";
const STAGING_DB = "https://stagingprojectref.supabase.co";
const PRODUCTION_DB = "https://productionproject.supabase.co";
const BUILD = "a".repeat(40);
const RUN_ID = "run-20260807-driver";
const CHALLENGE = "b".repeat(32);
const STAGING_DB_HASH = createHash("sha256").update("stagingprojectref").digest("hex");
const FIXTURE = { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" };
const TEACHER_IDENTITY = {
    sessionAuthority: "legacy_account",
    accountId: FIXTURE.organizationId,
    accountSessionGeneration: 1,
    actorUserId: FIXTURE.organizationId,
};
const CONTROL_PATHS = {
    "student-read": ["rpc:omr_open_attempt_session_v3"],
    checkpoint: ["rpc:omr_checkpoint_attempt_session_v2"],
    heartbeat: ["rpc:omr_heartbeat_attempt_session_v2"],
    "teacher-live-read": ["rpc:omr_list_active_attempt_sessions_v2"],
    "teacher-upload-read": ["table:omr_remote_assets"],
    "student-submit": ["rpc:omr_prepare_attempt_session_submit_v2", "rpc:omr_commit_attempt_session_submit_v2"],
    "student-submit-replay": ["rpc:omr_prepare_attempt_session_submit_v2", "rpc:omr_commit_attempt_session_submit_v2"],
    "teacher-max-pdf-upload-prepare": ["rpc:omr_prepare_teacher_asset_upload_v2"],
    "teacher-max-pdf-upload-finalize": ["rpc:omr_authorize_teacher_asset_finalize_v2", "rpc:omr_finalize_teacher_asset_upload_v2"],
};

const temporaryDirectories: string[] = [];

async function temporaryDirectory() {
    const directory = await mkdtemp(join(tmpdir(), "omr-initial-ops-driver-"));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
        recursive: true,
        force: true,
    })));
});

describe("initial-operations staging load driver", () => {
    it("accepts only the exact safe legacy teacher identity returned for the fixture", async () => {
        const { normalizeInitialOperationsTeacherIdentity } = await import("./initial-operations-driver.mjs");
        expect(normalizeInitialOperationsTeacherIdentity(TEACHER_IDENTITY, FIXTURE)).toEqual(TEACHER_IDENTITY);
        for (const invalid of [
            undefined,
            {},
            { ...TEACHER_IDENTITY, extra: true },
            { ...TEACHER_IDENTITY, sessionAuthority: "account" },
            { ...TEACHER_IDENTITY, accountId: "teacher_short" },
            { ...TEACHER_IDENTITY, accountId: "teacher_0000000000000000" },
            { ...TEACHER_IDENTITY, accountSessionGeneration: 0 },
            { ...TEACHER_IDENTITY, accountSessionGeneration: 1.5 },
            { ...TEACHER_IDENTITY, actorUserId: "uploader_f2ea1de9e08ca3d3_01" },
        ]) {
            expect(normalizeInitialOperationsTeacherIdentity(invalid, FIXTURE)).toBeNull();
        }
    });

    it("merges in-path RSS only for workload-serving instances without creating workload requests", async () => {
        const { buildInPathRssEvidence } = await import("./initial-operations-driver.mjs");
        const evidence = buildInPathRssEvidence(RUN_ID, BUILD, [
            { targetKind: "app", serverInstanceId: "instance-a", rssCapturedAtMs: 2_000, rssBytes: 120 },
            { targetKind: "app", serverInstanceId: "instance-b", rssCapturedAtMs: 2_100, rssBytes: 130 },
            { targetKind: "storage", serverInstanceId: "instance-storage", rssCapturedAtMs: 2_200, rssBytes: 140 },
        ], [
            { kind: "rss", source: "server", runId: RUN_ID, build: BUILD, serverInstanceId: "instance-a", capturedAtMs: 1_000, rssBytes: 100 },
            { kind: "rss", source: "server", runId: RUN_ID, build: BUILD, serverInstanceId: "instance-b", capturedAtMs: 1_100, rssBytes: 110 },
            { kind: "rss", source: "server", runId: RUN_ID, build: BUILD, serverInstanceId: "probe-only", capturedAtMs: 1_200, rssBytes: 90 },
        ]);

        expect(evidence.map((sample: { serverInstanceId: string }) => sample.serverInstanceId))
            .toEqual(["instance-a", "instance-b", "instance-a", "instance-b", "instance-storage"]);
        expect(evidence.every((sample: { kind: string; source: string }) => sample.kind === "rss" && sample.source === "server"))
            .toBe(true);
    });

    it("uses each actor's earliest checkpoint as the live-propagation source", async () => {
        const { firstCheckpointRecordsByActor } = await import("./initial-operations-driver.mjs");
        const first = { operation: "checkpoint", actorId: "student-a", startedAtMs: 10, revision: 1 };
        const latest = { operation: "checkpoint", actorId: "student-a", startedAtMs: 60, revision: 9 };
        const selected = firstCheckpointRecordsByActor([latest, first]);
        expect(selected.get("student-a")).toBe(first);
    });

    it("fails closed until a physically isolated staging control plane is attested", async () => {
        const driver = await import("./initial-operations-driver.mjs");
        const base = {
            runId: RUN_ID,
            runChallenge: CHALLENGE,
            baseUrl: STAGING,
            productionBaseUrl: PRODUCTION,
            stagingSupabaseUrl: STAGING_DB,
            productionSupabaseUrl: PRODUCTION_DB,
            expectedBuild: BUILD,
            loadToken: "l".repeat(40),
            outputDirectory: await temporaryDirectory(),
        };

        expect(() => driver.assertInitialOperationsDriverConfig({
            ...base,
            baseUrl: PRODUCTION,
        })).toThrow(/production/i);
        expect(() => driver.assertInitialOperationsDriverConfig({
            ...base,
            stagingSupabaseUrl: PRODUCTION_DB,
        })).toThrow(/database|production/i);
        expect(() => driver.assertInitialOperationsDriverConfig({
            ...base,
            externalState: undefined,
        })).toThrow(/external state|attestation/i);
        expect(() => driver.assertInitialOperationsDriverConfig({
            ...base,
            externalState: {
                environment: "staging",
                appOrigin: STAGING,
                storageOrigin: STAGING_DB,
                databaseProjectRefHash: STAGING_DB_HASH,
                controlPlaneVersion: 2,
                productionWorkloadPaths: CONTROL_PATHS,
            },
        })).not.toThrow();
        expect(() => driver.assertInitialOperationsDriverConfig({
            ...base,
            externalState: {
                environment: "staging",
                appOrigin: STAGING,
                storageOrigin: STAGING_DB,
                databaseProjectRefHash: "0".repeat(64),
                controlPlaneVersion: 2,
                productionWorkloadPaths: CONTROL_PATHS,
            },
        })).toThrow(/attestation|database/i);
    });

    it("builds the exact 100-VU cadence and two 80-request submission barriers", async () => {
        const { buildInitialOperationsExecutionPlan } = await import("./initial-operations-driver.mjs");
        const plan = buildInitialOperationsExecutionPlan(RUN_ID);

        expect(plan.vus).toHaveLength(100);
        expect(plan.vus.filter((vu: { role: string }) => vu.role === "student")).toHaveLength(80);
        expect(plan.vus.filter((vu: { role: string }) => vu.role === "teacher-poller")).toHaveLength(10);
        expect(plan.vus.filter((vu: { role: string }) => vu.role === "teacher-uploader")).toHaveLength(10);
        expect(plan.steady.filter((item: { operation: string }) => item.operation === "checkpoint")).toHaveLength(2_800);
        expect(plan.steady.filter((item: { operation: string }) => item.operation === "heartbeat")).toHaveLength(880);
        expect(plan.steady.filter((item: { operation: string }) => item.operation === "teacher-live-read")).toHaveLength(590);
        expect(plan.submissionPrimary).toHaveLength(80);
        expect(plan.submissionReplay).toHaveLength(80);
        expect(new Set(plan.submissionReplay.map((item: { idempotencyKey: string }) => item.idempotencyKey)))
            .toEqual(new Set(plan.submissionPrimary.map((item: { idempotencyKey: string }) => item.idempotencyKey)));
        expect(plan.uploads).toHaveLength(10);
        expect(plan.uploads.every((item: { byteSize: number }) => item.byteSize === 50 * 1024 * 1024)).toBe(true);
        expect(Math.max(...plan.vus.map((vu: { rampOffsetMs: number }) => vu.rampOffsetMs))).toBe(19_000);
    });

    it("writes bounded monotonic raw records linked to run, challenge, build, target, and process", async () => {
        const { createInitialOperationsRawWriter } = await import("./initial-operations-driver.mjs");
        const directory = await temporaryDirectory();
        const targetHash = createHash("sha256").update(`${STAGING}\n${STAGING_DB}`).digest("hex");
        const writer = await createInitialOperationsRawWriter({
            path: join(directory, "driver.ndjson"),
            maximumBytes: 4_096,
            maximumRecords: 2,
            runId: RUN_ID,
            runChallenge: CHALLENGE,
            expectedBuild: BUILD,
            targetHash,
        });

        await writer.append({ kind: "run", schemaVersion: 1, event: "fixture-create-started" });
        await writer.append({ kind: "lifecycle", event: "fixture-create-finished" });
        await expect(writer.append({ kind: "lifecycle", event: "overflow" })).rejects.toThrow(/bounded/i);
        const closed = await writer.close();

        const rawContent = await readFile(join(directory, "driver.ndjson"), "utf8");
        const records = rawContent
            .trimEnd().split("\n").map((line) => JSON.parse(line));
        expect(closed.sha256).toBe(createHash("sha256").update(rawContent).digest("hex"));
        expect(records.map((record) => record.sequence)).toEqual([1, 2]);
        for (const record of records) {
            expect(record).toMatchObject({
                rawEnvelopeVersion: 1,
                runId: RUN_ID,
                runChallenge: CHALLENGE,
                expectedBuild: BUILD,
                targetHash,
            });
            expect(record.writerPid).toBe(process.pid);
            expect(Number.isSafeInteger(record.monotonicNs)).toBe(true);
        }
        expect(records[0].schemaVersion).toBe(1);
    });

    it("executes bounded non-redirecting HTTP operations with server provenance headers", async () => {
        const { createInitialOperationsControlPlane } = await import("./initial-operations-driver.mjs");
        const calls: Array<{ url: string; init: RequestInit }> = [];
        const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
            const url = input.toString();
            calls.push({ url, init });
            const fixtureBody = init.body ? JSON.parse(String(init.body)) : undefined;
            const body = JSON.stringify(url.endsWith("/contract")
                ? {
                    environment: "staging",
                    appOrigin: STAGING,
                    storageOrigin: STAGING_DB,
                    databaseProjectRefHash: STAGING_DB_HASH,
                    controlPlaneVersion: 2,
                    productionWorkloadPaths: CONTROL_PATHS,
                }
                : url.endsWith("/fixture")
                    ? fixtureBody.action === "create"
                        ? { status: "created", ...fixtureBody.fixture, examUpdatedAt: "2026-08-07T00:00:00.000Z", teacherIdentity: TEACHER_IDENTITY }
                        : { status: "cleaned", remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 } }
                    : { status: "ok", revision: 1 });
            const response = new Response(body, {
                status: 200,
                headers: {
                    "content-type": "application/json",
                    "content-length": String(Buffer.byteLength(body)),
                    "cache-control": "no-store",
                    "x-omr-build": BUILD,
                    "x-omr-instance-id": "staging-instance-a",
                    "x-omr-server-duration-ms": "12.5",
                    "x-omr-rss-bytes": "123456",
                    "x-omr-rss-captured-at-ms": "456789",
                },
            });
            Object.defineProperties(response, {
                url: { value: url },
                redirected: { value: false },
            });
            return response;
        };
        const control = createInitialOperationsControlPlane({
            runId: RUN_ID,
            runChallenge: CHALLENGE,
            baseUrl: STAGING,
            productionBaseUrl: PRODUCTION,
            stagingSupabaseUrl: STAGING_DB,
            productionSupabaseUrl: PRODUCTION_DB,
            expectedBuild: BUILD,
            loadToken: "l".repeat(40),
            outputDirectory: await temporaryDirectory(),
            externalState: {
                environment: "staging",
                appOrigin: STAGING,
                storageOrigin: STAGING_DB,
                databaseProjectRefHash: STAGING_DB_HASH,
                controlPlaneVersion: 2,
                productionWorkloadPaths: CONTROL_PATHS,
            },
        }, { fetchImpl });

        await expect(control.attest()).resolves.toMatchObject({ environment: "staging" });
        await expect(control.createFixture({
            fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
        })).resolves.toMatchObject({ status: "created", teacherIdentity: TEACHER_IDENTITY });
        await expect(control.cleanupFixture({
            fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
        })).resolves.toMatchObject({ status: "cleaned" });
        const result = await control.requestOperation({
            operation: "checkpoint",
            actorId: "student_1234567890abcdef_001",
            requestId: `${RUN_ID}:checkpoint:001:1`,
            body: { revision: 1 },
        });

        expect(calls).toHaveLength(4);
        expect(calls[0].url).toBe(`${STAGING}/api/internal/initial-operations/contract`);
        expect(calls[1].url).toBe(`${STAGING}/api/internal/initial-operations/fixture`);
        expect(calls[2].url).toBe(`${STAGING}/api/internal/initial-operations/fixture`);
        expect(calls[3].url).toBe(`${STAGING}/api/internal/initial-operations/operations/checkpoint`);
        expect(calls[3].init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
        expect(calls.every(call => call.init.signal instanceof AbortSignal)).toBe(true);
        expect(new Headers(calls[0].init.headers).get("x-omr-actor-id")).toBe("control_f2ea1de9e08ca3d3");
        const headers = new Headers(calls[3].init.headers);
        expect(headers.get("x-omr-run-id")).toBe(RUN_ID);
        expect(headers.get("x-omr-run-challenge")).toBe(CHALLENGE);
        expect(headers.get("x-omr-expected-build")).toBe(BUILD);
        expect(headers.get("x-omr-request-id")).toBe(`${RUN_ID}:checkpoint:001:1`);
        expect(result).toMatchObject({
            statusCode: 200,
            responseBuild: BUILD,
            serverInstanceId: "staging-instance-a",
            serverDurationMs: 12.5,
            rssBytes: 123_456,
            rssCapturedAtMs: 456_789,
            body: { status: "ok", revision: 1 },
        });
        expect(result.responseBytes).toBeGreaterThan(0);
    });

    it("waits for every scheduled request to settle before reporting a workload failure", async () => {
        const { executeInitialOperationsWorkload } = await import("./initial-operations-driver.mjs");
        let slowRequestSettled = false;
        let releaseSlowStart!: () => void;
        const slowStarted = new Promise<void>(resolve => { releaseSlowStart = resolve; });
        const plan = {
            fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
            vus: [
                { vuId: "student-a", actorId: "student-a", role: "student", rampOffsetMs: 0 },
                { vuId: "student-b", actorId: "student-b", role: "student", rampOffsetMs: 0 },
            ],
            steady: [
                { operation: "checkpoint", vuId: "student-a", actorId: "student-a", requestId: `${RUN_ID}:bad`, revision: 1, offsetMs: 0 },
                { operation: "heartbeat", vuId: "student-b", actorId: "student-b", requestId: `${RUN_ID}:slow`, offsetMs: 0 },
            ],
            submissionPrimary: [],
            submissionReplay: [],
            uploads: [],
            steadyDurationMs: 0,
            cooldownDurationMs: 0,
        };

        await expect(executeInitialOperationsWorkload({
            config: { runId: RUN_ID, expectedBuild: BUILD },
            plan,
            writer: { async append() {} },
            controlPlane: {
                async requestOperation(input: { operation: string }) {
                    if (input.operation === "checkpoint") {
                        await slowStarted;
                        throw new Error("first request failed");
                    }
                    releaseSlowStart();
                    await new Promise(resolve => setTimeout(resolve, 10));
                    slowRequestSettled = true;
                    return {
                        statusCode: 200,
                        responseBuild: BUILD,
                        serverInstanceId: "instance-a",
                        serverDurationMs: 1,
                        responseBytes: 10,
                        body: { status: "ok", revision: 1 },
                    };
                },
            },
            overrides: { now: () => 1_000, waitUntil: async () => {}, rampLeadMs: 0 },
        })).rejects.toThrow("first request failed");
        expect(slowRequestSettled).toBe(true);
    });

    it("streams direct uploads only to staging storage and verifies the entire readback", async () => {
        const {
            initialOperationsStorageObjectSha256,
            transferInitialOperationsStorageObject,
        } = await import("./initial-operations-driver.mjs");
        const stored: Uint8Array[] = [];
        const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
            const url = input.toString();
            if (init.method === "PUT") {
                const request = new Request(url, init);
                stored.push(new Uint8Array(await request.arrayBuffer()));
                const response = new Response(null, { status: 200 });
                Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
                return response;
            }
            const response = new Response(stored[0].slice().buffer as ArrayBuffer, {
                status: 200,
                headers: { "content-length": String(stored[0].byteLength) },
            });
            Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
            return response;
        };
        const input = {
            uploadUrl: `${STAGING_DB}/storage/v1/object/upload/sign/load.pdf?token=staging`,
            readbackUrl: `${STAGING_DB}/storage/v1/object/sign/load.pdf?token=staging`,
            stagingStorageOrigin: STAGING_DB,
            productionStorageOrigin: PRODUCTION_DB,
            expectedBytes: 4_096,
            seed: `${RUN_ID}:upload:01`,
        };

        const result = await transferInitialOperationsStorageObject(input, { fetchImpl });
        expect(result.observedBytes).toBe(4_096);
        expect(result.expectedSha256).toBe(initialOperationsStorageObjectSha256(input.seed, input.expectedBytes));
        expect(result.readbackSha256).toBe(result.expectedSha256);
        expect(stored[0]).toHaveLength(4_096);
        expect(new TextDecoder().decode(stored[0].slice(0, 5))).toBe("%PDF-");
        await expect(transferInitialOperationsStorageObject({
            ...input,
            uploadUrl: `${PRODUCTION_DB}/storage/v1/object/upload/sign/load.pdf?token=prod`,
        }, { fetchImpl })).rejects.toThrow(/production|storage target/i);
    });

    it("uploads large fixtures with bounded production TUS chunks and integrity metadata", async () => {
        const {
            initialOperationsStorageObjectSha256,
            transferInitialOperationsStorageObject,
        } = await import("./initial-operations-driver.mjs");
        const expectedBytes = 7 * 1024 * 1024;
        const seed = `${RUN_ID}:upload:tus:01`;
        const expectedSha256 = initialOperationsStorageObjectSha256(seed, expectedBytes);
        const stored: Uint8Array[] = [];
        let offset = 0;
        const tusOrigin = "https://stagingprojectref.storage.supabase.co";
        const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
            const url = input.toString();
            const headers = new Headers(init.headers);
            if (init.method === "POST") {
                expect(url).toBe(`${tusOrigin}/storage/v1/upload/resumable`);
                expect(headers.get("tus-resumable")).toBe("1.0.0");
                expect(headers.get("upload-length")).toBe(String(expectedBytes));
                const metadata = headers.get("upload-metadata") ?? "";
                expect(metadata).toContain(`bucketName ${Buffer.from("omr-private-assets").toString("base64")}`);
                const customMetadata = metadata.split(",").find(value => value.startsWith("metadata "))?.split(" ")[1];
                expect(JSON.parse(Buffer.from(customMetadata ?? "", "base64").toString("utf8")))
                    .toEqual({ sha256Hex: expectedSha256, uploadId: "asset_1" });
                const request = new Request(url, init);
                const chunk = new Uint8Array(await request.arrayBuffer());
                expect(chunk).toHaveLength(6 * 1024 * 1024);
                stored.push(chunk);
                offset += chunk.byteLength;
                const response = new Response(null, {
                    status: 201,
                    headers: {
                        location: `${tusOrigin}/storage/v1/upload/resumable/upload-1`,
                        "upload-offset": String(offset),
                    },
                });
                Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
                return response;
            }
            if (init.method === "PATCH") {
                expect(url).toBe(`${tusOrigin}/storage/v1/upload/resumable/upload-1`);
                expect(headers.get("upload-offset")).toBe(String(offset));
                const request = new Request(url, init);
                const chunk = new Uint8Array(await request.arrayBuffer());
                expect(chunk.byteLength).toBeLessThanOrEqual(6 * 1024 * 1024);
                stored.push(chunk);
                offset += chunk.byteLength;
                const response = new Response(null, {
                    status: 204,
                    headers: { "upload-offset": String(offset) },
                });
                Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
                return response;
            }
            const body = Buffer.concat(stored.map(chunk => Buffer.from(chunk)), expectedBytes);
            const response = new Response(body, {
                status: 200,
                headers: { "content-length": String(body.byteLength) },
            });
            Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
            return response;
        };
        const result = await transferInitialOperationsStorageObject({
            uploadUrl: `${STAGING_DB}/storage/v1/object/upload/sign/load.pdf?token=staging`,
            readbackUrl: `${STAGING_DB}/storage/v1/object/sign/load.pdf?token=staging`,
            stagingStorageOrigin: STAGING_DB,
            productionStorageOrigin: PRODUCTION_DB,
            expectedBytes,
            expectedSha256,
            seed,
            mode: "tus",
            token: "signed-upload-token",
            bucket: "omr-private-assets",
            objectPath: "organizations/teacher_1/exams/exam_1/problem/asset_1.pdf",
            mimeType: "application/pdf",
            uploadId: "asset_1",
        }, { fetchImpl });

        expect(offset).toBe(expectedBytes);
        expect(stored).toHaveLength(2);
        expect(result.expectedSha256).toBe(expectedSha256);
        expect(result.readbackSha256).toBe(expectedSha256);
    });

    it("returns unverified without real DB/RSS collectors and always cleans a created fixture after failure", async () => {
        const { runInitialOperationsStagingLoad } = await import("./initial-operations-driver.mjs");
        const outputDirectory = await temporaryDirectory();
        const config = {
            runId: RUN_ID,
            runChallenge: CHALLENGE,
            baseUrl: STAGING,
            productionBaseUrl: PRODUCTION,
            stagingSupabaseUrl: STAGING_DB,
            productionSupabaseUrl: PRODUCTION_DB,
            expectedBuild: BUILD,
            loadToken: "l".repeat(40),
            outputDirectory,
            externalState: {
                environment: "staging",
                appOrigin: STAGING,
                storageOrigin: STAGING_DB,
                databaseProjectRefHash: STAGING_DB_HASH,
                controlPlaneVersion: 2,
                productionWorkloadPaths: CONTROL_PATHS,
            },
        };

        await expect(runInitialOperationsStagingLoad(config, {})).resolves.toMatchObject({
            status: "unverified",
            code: "missing_external_collectors",
        });

        const lifecycle: string[] = [];
        const secondOutput = await temporaryDirectory();
        const failed = await runInitialOperationsStagingLoad({ ...config, outputDirectory: secondOutput }, {
            controlPlane: {
                async attest() { lifecycle.push("attest"); return config.externalState; },
                async createFixture() {
                    lifecycle.push("create");
                    return { status: "created", ...FIXTURE, examUpdatedAt: "2026-08-07T00:00:00.000Z", teacherIdentity: TEACHER_IDENTITY };
                },
                async cleanupFixture() {
                    lifecycle.push("cleanup");
                    return { status: "cleaned", remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 } };
                },
            },
            collectors: {
                database: { async start() { lifecycle.push("db-start"); }, async stop() { lifecycle.push("db-stop"); return []; } },
                rss: { async start() { lifecycle.push("rss-start"); }, async stop() { lifecycle.push("rss-stop"); return []; } },
            },
            async executeWorkload() {
                lifecycle.push("workload");
                throw new Error("deliberate workload failure");
            },
        });

        expect(failed).toMatchObject({ status: "unverified", code: "load_execution_failed", cleanupVerified: true });
        expect(lifecycle).toEqual([
            "attest", "create", "db-start", "rss-start", "workload", "rss-stop", "db-stop", "cleanup",
        ]);
        const raw = await readFile(join(secondOutput, "driver.ndjson"), "utf8");
        expect(raw).toContain('"event":"cleanup-verified"');
        expect(raw).not.toContain("deliberate workload failure");

        const emptyCollectorOutput = await temporaryDirectory();
        await expect(runInitialOperationsStagingLoad({ ...config, outputDirectory: emptyCollectorOutput }, {
            controlPlane: {
                async attest() { return config.externalState; },
                async createFixture() { return { status: "created", ...FIXTURE, examUpdatedAt: "2026-08-07T00:00:00.000Z", teacherIdentity: TEACHER_IDENTITY }; },
                async cleanupFixture() { return { status: "cleaned", remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 } }; },
            },
            collectors: {
                database: { async start() {}, async stop() { return []; } },
                rss: { async start() {}, async stop() { return []; } },
            },
            async executeWorkload() {},
        })).resolves.toMatchObject({
            status: "unverified",
            code: "collector_evidence_missing",
            cleanupVerified: true,
        });
    });

    it.each([
        ["missing", undefined],
        ["malformed", { ...TEACHER_IDENTITY, accountSessionGeneration: 0 }],
    ])("fails the run closed when fixture teacher identity is %s", async (_label, suppliedIdentity) => {
        const { runInitialOperationsStagingLoad } = await import("./initial-operations-driver.mjs");
        const executeWorkload = vi.fn();
        const cleanupFixture = vi.fn(async () => ({
            status: "cleaned",
            remaining: { sessions: 0, attempts: 0, assets: 0, objects: 0 },
        }));
        const outputDirectory = await temporaryDirectory();
        const config = {
            runId: RUN_ID,
            runChallenge: CHALLENGE,
            baseUrl: STAGING,
            productionBaseUrl: PRODUCTION,
            stagingSupabaseUrl: STAGING_DB,
            productionSupabaseUrl: PRODUCTION_DB,
            expectedBuild: BUILD,
            loadToken: "l".repeat(40),
            outputDirectory,
            externalState: {
                environment: "staging",
                appOrigin: STAGING,
                storageOrigin: STAGING_DB,
                databaseProjectRefHash: STAGING_DB_HASH,
                controlPlaneVersion: 2,
                productionWorkloadPaths: CONTROL_PATHS,
            },
        };
        const result = await runInitialOperationsStagingLoad(config, {
            controlPlane: {
                async attest() { return config.externalState; },
                async createFixture() {
                    return {
                        status: "created",
                        ...FIXTURE,
                        examUpdatedAt: "2026-08-07T00:00:00.000Z",
                        ...(suppliedIdentity ? { teacherIdentity: suppliedIdentity } : {}),
                    };
                },
                cleanupFixture,
            },
            collectors: {
                database: { async start() {}, async stop() { return []; } },
                rss: { async start() {}, async stop() { return []; } },
            },
            executeWorkload,
        });

        expect(result).toMatchObject({ status: "unverified", code: "fixture_create_unverified" });
        expect(executeWorkload).not.toHaveBeenCalled();
        expect(cleanupFixture).toHaveBeenCalledOnce();
    });

    it("executes primary and replay phases as distinct concurrent barriers", async () => {
        const {
            createInitialOperationsRawWriter,
            executeInitialOperationsWorkload,
        } = await import("./initial-operations-driver.mjs");
        const records: Array<Record<string, unknown>> = [];
        const directory = await temporaryDirectory();
        const rawWriter = await createInitialOperationsRawWriter({
            path: join(directory, "driver.ndjson"),
            maximumBytes: 64 * 1024,
            maximumRecords: 100,
            runId: RUN_ID,
            runChallenge: CHALLENGE,
            expectedBuild: BUILD,
            targetHash: createHash("sha256").update("integration-target").digest("hex"),
        });
        let now = 1_000_000;
        let primariesStarted = 0;
        let primariesFinished = 0;
        let peakPrimary = 0;
        const operations: string[] = [];
        const response = (operation: string, actorId: string) => ({
            statusCode: 200,
            responseBuild: BUILD,
            serverInstanceId: "instance-a",
            serverDurationMs: 5,
            responseBytes: 100,
            body: operation.includes("submit")
                ? { status: "submitted", attemptId: `attempt-${actorId}`, receiptHash: "d".repeat(64), receipt: { actorId, score: 1 } }
                : { status: "ok", revision: 1, observedRevisions: {} },
        });
        const actors = ["student_f2ea1de9e08ca3d3_001", "student_f2ea1de9e08ca3d3_002"];
        const plan = {
            fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
            vus: actors.map((actorId, index) => ({ vuId: actorId, actorId, role: "student", rampOffsetMs: index * 200 })),
            steady: actors.map((actorId, index) => ({ operation: "student-read", vuId: actorId, actorId, requestId: `${RUN_ID}:read:${index}`, offsetMs: 1 })),
            submissionPrimary: actors.map((actorId, index) => ({ operation: "student-submit", vuId: actorId, actorId, requestId: `${RUN_ID}:primary:${index}`, idempotencyKey: `${RUN_ID}:submission:${index}` })),
            submissionReplay: actors.map((actorId, index) => ({ operation: "student-submit-replay", vuId: actorId, actorId, requestId: `${RUN_ID}:replay:${index}`, idempotencyKey: `${RUN_ID}:submission:${index}` })),
            uploads: [],
            steadyDurationMs: 100,
            cooldownDurationMs: 10,
        };
        await executeInitialOperationsWorkload({
            config: { runId: RUN_ID, expectedBuild: BUILD },
            plan,
            writer: {
                async append(record: Record<string, unknown>) {
                    records.push(record);
                    return rawWriter.append(record);
                },
            },
            controlPlane: {
                async requestOperation(input: { operation: string; actorId: string }) {
                    operations.push(input.operation);
                    now += 1;
                    if (input.operation === "student-submit") {
                        primariesStarted += 1;
                        peakPrimary = Math.max(peakPrimary, primariesStarted - primariesFinished);
                        await Promise.resolve();
                        primariesFinished += 1;
                    }
                    if (input.operation === "student-submit-replay") expect(primariesFinished).toBe(2);
                    return response(input.operation, input.actorId);
                },
            },
            overrides: {
                now: () => now,
                waitUntil: async () => { now += 1; },
                rampLeadMs: 0,
                submissionOffsetMs: 10,
                uploadOffsetMs: 20,
            },
        });
        await rawWriter.close();

        expect(peakPrimary).toBe(2);
        expect(operations.filter((operation) => operation === "student-submit")).toHaveLength(2);
        expect(operations.filter((operation) => operation === "student-submit-replay")).toHaveLength(2);
        expect(records.filter((record) => record.kind === "request")).toHaveLength(6);
        expect(records.filter((record) => record.kind === "request" && String(record.operation).includes("submit")))
            .toEqual(expect.arrayContaining([expect.objectContaining({ receiptHash: "d".repeat(64) })]));
        expect(records.filter((record) => record.kind === "vu")).toHaveLength(2);
        expect(records).toContainEqual(expect.objectContaining({ kind: "run", timeline: expect.any(Object) }));
        expect(await readFile(join(directory, "driver.ndjson"), "utf8")).toContain('"kind":"run"');
    });

    it("cancels each student's scheduled checkpoint and heartbeat after submission succeeds", async () => {
        const { executeInitialOperationsWorkload } = await import("./initial-operations-driver.mjs");
        const actorId = "student_f2ea1de9e08ca3d3_001";
        const operations: string[] = [];
        const response = (operation: string) => ({
            statusCode: 200,
            responseBuild: BUILD,
            serverInstanceId: "instance-a",
            serverDurationMs: 1,
            responseBytes: 10,
            body: operation.includes("submit")
                ? { status: "submitted", attemptId: "attempt-1", receiptHash: "d".repeat(64) }
                : { status: "ok", revision: 1 },
        });
        await executeInitialOperationsWorkload({
            config: { runId: RUN_ID, expectedBuild: BUILD },
            plan: {
                fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
                vus: [{ vuId: actorId, actorId, role: "student", rampOffsetMs: 0 }],
                steady: [
                    { operation: "student-read", vuId: actorId, actorId, requestId: `${RUN_ID}:read:1`, offsetMs: 1 },
                    { operation: "checkpoint", vuId: actorId, actorId, requestId: `${RUN_ID}:checkpoint:1`, offsetMs: 20, revision: 1 },
                    { operation: "heartbeat", vuId: actorId, actorId, requestId: `${RUN_ID}:heartbeat:1`, offsetMs: 30 },
                ],
                submissionPrimary: [{ operation: "student-submit", vuId: actorId, actorId, requestId: `${RUN_ID}:submit:1`, idempotencyKey: `${RUN_ID}:submission:1` }],
                submissionReplay: [{ operation: "student-submit-replay", vuId: actorId, actorId, requestId: `${RUN_ID}:replay:1`, idempotencyKey: `${RUN_ID}:submission:1` }],
                uploads: [], steadyDurationMs: 40, cooldownDurationMs: 0,
            },
            writer: { async append() {} },
            controlPlane: {
                async requestOperation(input: { operation: string }) {
                    operations.push(input.operation);
                    return response(input.operation);
                },
            },
            overrides: { rampLeadMs: -1_000, submissionOffsetMs: 5 },
        });

        expect(operations).toContain("student-submit");
        expect(operations).toContain("student-submit-replay");
        expect(operations).not.toContain("checkpoint");
        expect(operations).not.toContain("heartbeat");
    });

    it("settles or cancels reserved requests before rejection can hand control to cleanup", async () => {
        const { executeInitialOperationsWorkload } = await import("./initial-operations-driver.mjs");
        const actorId = "student_f2ea1de9e08ca3d3_001";
        let cleanupStarted = false;
        let requestOverlappedCleanup = false;
        const execution = executeInitialOperationsWorkload({
            config: { runId: RUN_ID, expectedBuild: BUILD },
            plan: {
                fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
                vus: [{ vuId: actorId, actorId, role: "student", rampOffsetMs: 0 }],
                steady: [
                    { operation: "student-read", vuId: actorId, actorId, requestId: `${RUN_ID}:read:1`, offsetMs: 1 },
                    { operation: "checkpoint", vuId: actorId, actorId, requestId: `${RUN_ID}:checkpoint:1`, offsetMs: 20, revision: 1 },
                ],
                submissionPrimary: [], submissionReplay: [], uploads: [],
                steadyDurationMs: 40, cooldownDurationMs: 0,
            },
            writer: { async append() {} },
            controlPlane: {
                async requestOperation(input: { operation: string }) {
                    if (cleanupStarted) requestOverlappedCleanup = true;
                    if (input.operation === "student-read") throw new Error("deliberate request failure");
                    return { statusCode: 200, responseBuild: BUILD, serverInstanceId: "instance-a", responseBytes: 1, body: { status: "ok" } };
                },
            },
            overrides: { rampLeadMs: -1_000, submissionOffsetMs: 5 },
        });
        await expect(execution).rejects.toThrow("deliberate request failure");
        cleanupStarted = true;
        await new Promise(resolve => setTimeout(resolve, 35));
        expect(requestOverlappedCleanup).toBe(false);
    });

    it("declares the deterministic PDF hash before signed upload preparation", async () => {
        const { executeInitialOperationsWorkload, initialOperationsStorageObjectSha256 } = await import("./initial-operations-driver.mjs");
        const bytes = 4_096;
        const idempotencyKey = `${RUN_ID}:upload:01`;
        const uploadUrl = `${STAGING_DB}/storage/v1/object/upload/sign/load.pdf?token=staging`;
        const readbackUrl = `${STAGING_DB}/storage/v1/object/sign/load.pdf?token=staging`;
        let stored = new Uint8Array();
        let prepareBody: Record<string, unknown> | undefined;
        let finalizeBody: Record<string, unknown> | undefined;
        const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
            const url = input.toString();
            if (init.method === "PUT") {
                stored = new Uint8Array(await new Request(url, init).arrayBuffer());
                const response = new Response(null, { status: 200 });
                Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
                return response;
            }
            const response = new Response(stored.slice().buffer as ArrayBuffer, {
                status: 200,
                headers: { "content-length": String(stored.byteLength) },
            });
            Object.defineProperties(response, { url: { value: url }, redirected: { value: false } });
            return response;
        };
        let now = 1_000_000;
        await executeInitialOperationsWorkload({
            config: { runId: RUN_ID, expectedBuild: BUILD, stagingSupabaseUrl: STAGING_DB, productionSupabaseUrl: PRODUCTION_DB },
            plan: {
                fixture: { organizationId: "teacher_f2ea1de9e08ca3d3", examId: "initial_ops_exam_f2ea1de9e08ca3d3" },
                vus: [], steady: [], submissionPrimary: [], submissionReplay: [],
                uploads: [{
                    operation: "teacher-max-pdf-upload", vuId: "uploader_f2ea1de9e08ca3d3_01",
                    actorId: "uploader_f2ea1de9e08ca3d3_01", requestId: `${RUN_ID}:upload:01`,
                    idempotencyKey, byteSize: bytes,
                }],
                steadyDurationMs: 100, cooldownDurationMs: 0,
            },
            writer: { async append() {} },
            controlPlane: {
                async requestOperation(input: { operation: string; body: Record<string, unknown> }) {
                    now += 1;
                    if (input.operation.endsWith("prepare")) {
                        prepareBody = input.body;
                        return { statusCode: 200, responseBuild: BUILD, serverInstanceId: "a", responseBytes: 1, body: {
                            status: "prepared", uploadUrl, readbackUrl,
                            objectPath: "organizations/teacher_f2ea1de9e08ca3d3/exams/initial_ops_exam_f2ea1de9e08ca3d3/problem/asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf",
                            uploadId: "asset_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                            mode: "standard", token: "signed-token", bucket: "omr-private-assets", mimeType: "application/pdf",
                        } };
                    }
                    finalizeBody = input.body;
                    return { statusCode: 200, responseBuild: BUILD, serverInstanceId: "a", responseBytes: 1, body: { status: "finalized", readbackUrl } };
                },
            },
            overrides: {
                now: () => now, waitUntil: async () => { now += 1; }, uploadOffsetMs: 1,
                fetchImpl, storageWriter: { async append() {} }, fixtureTeacherIdentity: TEACHER_IDENTITY,
            },
        });
        const expectedSha256 = initialOperationsStorageObjectSha256(idempotencyKey, bytes);
        expect(prepareBody).toMatchObject({ sha256Hex: expectedSha256, teacherIdentity: TEACHER_IDENTITY });
        expect(finalizeBody).toMatchObject({ expectedSha256, teacherIdentity: TEACHER_IDENTITY });
    });

    it("exposes only the fail-closed staging runner as the operations package command", async () => {
        const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
        expect(packageJson.scripts["test:ops:initial"]).toBe("node scripts/run-initial-operations.mjs");
        const runner = await readFile(join(process.cwd(), "scripts/run-initial-operations.mjs"), "utf8");
        expect(runner).toContain("serializeInitialOperationsEvidenceBundle");
        expect(runner).toContain("evaluateInitialOperationsEvidenceBundle");
        expect(runner).toContain("initialOperationsRunSucceeded");
        expect(runner).not.toContain('result.status === "collected" ? 0 : 2');
    });
});
