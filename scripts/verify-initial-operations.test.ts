import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const EXPECTED_BUILD = "a".repeat(40);
const STAGING_PROJECT_HASH = createHash("sha256").update("stagingprojectref").digest("hex");
const PRODUCTION_PATHS: Record<string, string[]> = {
    "student-read": ["rpc:omr_open_attempt_session_v1"],
    checkpoint: ["rpc:omr_checkpoint_attempt_session_v1"],
    heartbeat: ["rpc:omr_heartbeat_attempt_session_v1"],
    "teacher-live-read": ["rpc:omr_list_active_attempt_sessions_v1"],
    "teacher-upload-read": ["table:omr_remote_assets"],
    "student-submit": ["rpc:omr_prepare_attempt_session_submit_v1", "rpc:omr_commit_attempt_session_submit_v1"],
    "student-submit-replay": ["rpc:omr_prepare_attempt_session_submit_v1", "rpc:omr_commit_attempt_session_submit_v1"],
    "teacher-max-pdf-upload": [
        "rpc:omr_prepare_teacher_asset_upload_v1",
        "rpc:omr_authorize_teacher_asset_finalize_v1",
        "rpc:omr_finalize_teacher_asset_upload_v1",
    ],
};
const DATABASE_PATHS = [...new Set(Object.values(PRODUCTION_PATHS).flat())];
const passingStaticAssetProbe = async () => ({
    statusCode: 200,
    encoding: "br",
    cachePolicy: "immutable",
});

type RawRequestEvidence = {
    eventId: string;
    requestId: string;
    runId: string;
    vuId: string;
    actorId: string;
    operation: string;
    startedAtMs: number;
    endedAtMs: number;
    statusCode: number;
    success: boolean;
    responseBytes: number;
    method: "GET" | "POST" | "PUT";
    routeId: string;
    targetKind: "app" | "storage";
    serverInstanceId: string;
    responseBuild: string;
    workloadPaths: string[];
    serverDurationMs?: number;
    revision?: number;
    observedRevisions?: Record<string, number>;
    idempotencyKey?: string;
    attemptId?: string;
    receiptHash?: string;
    upload?: {
        declaredBytes: number;
        storedBytes: number;
        directToStorage: boolean;
        contentSha256: string;
        objectPath: string;
        finalized: boolean;
    };
};

function passingEvidence() {
    const runId = "run-20260807-001";
    const fixtureSuffix = createHash("sha256").update(runId).digest("hex").slice(0, 16);
    const organizationId = `teacher_${fixtureSuffix}`;
    const examId = `initial_ops_exam_${fixtureSuffix}`;
    const rampStartedAtMs = 1_000_000;
    const steadyStartedAtMs = 1_020_000;
    const steadyEndedAtMs = 1_200_000;
    const cooldownEndedAtMs = 1_320_000;
    const requests: RawRequestEvidence[] = [];
    let eventNumber = 0;
    const addRequest = (
        operation: string,
        vuId: string,
        actorId: string,
        startedAtMs: number,
        durationMs: number,
        extra: Partial<RawRequestEvidence> = {},
    ) => {
        eventNumber += 1;
        const eventId = `${runId}:event:${String(eventNumber).padStart(5, "0")}`;
        const method: RawRequestEvidence["method"] = operation === "teacher-max-pdf-upload"
            ? "PUT"
            : operation.includes("read") ? "GET" : "POST";
        const targetKind: RawRequestEvidence["targetKind"] = operation === "teacher-max-pdf-upload"
            ? "storage"
            : "app";
        const request = {
            eventId,
            requestId: `${eventId}:request`,
            runId,
            vuId,
            actorId,
            operation,
            startedAtMs,
            endedAtMs: startedAtMs + durationMs,
            statusCode: 200,
            success: true,
            responseBytes: 4_096,
            method,
            routeId: operation,
            targetKind,
            serverInstanceId: "instance-a",
            responseBuild: EXPECTED_BUILD,
            workloadPaths: PRODUCTION_PATHS[operation] ?? [],
            ...extra,
        };
        requests.push(request);
        return request;
    };
    const students = Array.from({ length: 80 }, (_, index) => `student_${fixtureSuffix}_${String(index + 1).padStart(3, "0")}`);
    const pollers = Array.from({ length: 10 }, (_, index) => `poller_${fixtureSuffix}_${String(index + 1).padStart(2, "0")}`);
    const uploaders = Array.from({ length: 10 }, (_, index) => `uploader_${fixtureSuffix}_${String(index + 1).padStart(2, "0")}`);
    const vus = [...students.map((vuId) => ({ vuId, actorId: vuId, role: "student" })),
        ...pollers.map((vuId) => ({ vuId, actorId: vuId, role: "teacher-poller" })),
        ...uploaders.map((vuId) => ({ vuId, actorId: vuId, role: "teacher-uploader" }))]
        .map((vu, index) => ({
            ...vu,
            activeStartedAtMs: rampStartedAtMs + Math.floor(index / 5) * 1_000,
            activeEndedAtMs: steadyEndedAtMs,
        }));

    const firstCheckpointEvents = new Map<string, string>();
    for (const student of students) {
        addRequest("student-read", student, student, steadyStartedAtMs + 1_000, 200);
        for (let tick = 1; tick <= 11; tick += 1) {
            const request = addRequest("checkpoint", student, student, steadyStartedAtMs + tick * 5_000, 300, {
                revision: tick,
            });
            if (tick === 1) firstCheckpointEvents.set(student, request.eventId);
        }
        for (let tick = 1; tick <= 3; tick += 1) {
            addRequest("heartbeat", student, student, steadyStartedAtMs + tick * 15_000, 200);
        }
    }
    const secondPollEvents: string[] = [];
    for (const poller of pollers) {
        for (let tick = 1; tick <= 59; tick += 1) {
            const request = addRequest("teacher-live-read", poller, poller, steadyStartedAtMs + tick * 3_000, 250, {
                observedRevisions: Object.fromEntries(students.map((student) => [student, Math.floor(tick * 3 / 5)])),
            });
            if (tick === 2) secondPollEvents.push(request.eventId);
        }
    }
    for (const uploader of uploaders) {
        addRequest("teacher-upload-read", uploader, uploader, steadyStartedAtMs + 1_000, 230);
    }
    for (const [index, student] of students.entries()) {
        const idempotencyKey = `${runId}:submission:${String(index + 1).padStart(3, "0")}`;
        const attemptId = `attempt-${index + 1}`;
        const receiptHash = createHash("sha256").update(`receipt-${index + 1}`).digest("hex");
        addRequest("student-submit", student, student, steadyStartedAtMs + 60_000 + index * 10, 800, {
            serverDurationMs: 700,
            idempotencyKey,
            attemptId,
            receiptHash,
        });
        addRequest("student-submit-replay", student, student, steadyStartedAtMs + 70_000 + index * 5, 500, {
            idempotencyKey,
            attemptId,
            receiptHash,
        });
    }
    for (const [index, uploader] of uploaders.entries()) {
        addRequest("teacher-max-pdf-upload", uploader, uploader, steadyStartedAtMs + 90_000 + index * 20, 1_000, {
            responseBytes: 2_048,
            upload: {
                declaredBytes: 50 * 1024 * 1024,
                storedBytes: 50 * 1024 * 1024,
                directToStorage: true,
                contentSha256: createHash("sha256").update(`upload-${index + 1}`).digest("hex"),
                objectPath: `organizations/${organizationId}/exams/${examId}/problem/asset_${createHash("sha256")
                    .update(`${runId}:upload:${index + 1}`).digest("hex").slice(0, 32)}.pdf`,
                finalized: true,
            },
        });
    }
    const storage = requests.filter((request) => request.operation === "teacher-max-pdf-upload").map((request) => ({
        runId,
        actorId: request.actorId,
        requestEventId: request.eventId,
        objectPath: request.upload!.objectPath,
        expectedBytes: request.upload!.declaredBytes,
        observedBytes: request.upload!.storedBytes,
        expectedSha256: request.upload!.contentSha256,
        readbackSha256: request.upload!.contentSha256,
        finalized: true,
    }));
    return {
        schemaVersion: 1,
        runId,
        target: {
            environment: "staging",
            build: EXPECTED_BUILD,
            fixture: "initial-ops-100",
            organizationId,
            examId,
            databaseProjectRefHash: STAGING_PROJECT_HASH,
        },
        probes: {
            observedAt: "2026-08-07T00:00:01.000Z",
            health: {
                statusCode: 200,
                status: "alive",
                build: EXPECTED_BUILD,
                timestamp: "2026-08-07T00:00:00.000Z",
            },
            readinessUnauthorized: { statusCode: 401 },
            readiness: {
                statusCode: 200,
                status: "ready",
                database: "ready",
                observability: "ready",
                configuration: "ready",
                version: "202608060029",
                environment: "staging",
                build: EXPECTED_BUILD,
                databaseProjectRefHash: STAGING_PROJECT_HASH,
            },
            securityHeaders: {
                "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
                "strict-transport-security": "max-age=31536000; includeSubDomains",
                "x-content-type-options": "nosniff",
                "x-frame-options": "DENY",
                "referrer-policy": "strict-origin-when-cross-origin",
                "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            },
            staticAssetCompression: {
                statusCode: 200,
                encoding: "br",
                cachePolicy: "immutable",
            },
        },
        timeline: { rampStartedAtMs, steadyStartedAtMs, steadyEndedAtMs, cooldownEndedAtMs },
        vus,
        requests,
        storage,
        livePropagation: students.map((student, index) => ({
            sourceEventId: firstCheckpointEvents.get(student),
            observedEventId: secondPollEvents[index % secondPollEvents.length],
        })),
        database: {
            instrumentation: "pg_stat_statements",
            runId,
            databaseProjectRefHash: STAGING_PROJECT_HASH,
            statsResetAtMs: rampStartedAtMs - 1_000,
            windowStartedAtMs: rampStartedAtMs,
            windowEndedAtMs: steadyEndedAtMs,
            rows: DATABASE_PATHS.map((workloadPath, index) => ({
                workloadPath,
                fingerprint: createHash("sha256").update(workloadPath).digest("hex"),
                callsBefore: 10 + index,
                callsAfter: 110 + index,
                callsDelta: 100,
                maximumExecutionMs: index === 0 ? 300 : 280,
            })),
            countersBefore: { deadlocks: 4, lockTimeouts: 7 },
            countersAfter: { deadlocks: 4, lockTimeouts: 7 },
            attemptInventory: requests.filter((request) => request.operation === "student-submit").map((request) => ({
                idempotencyKey: request.idempotencyKey,
                attemptId: request.attemptId,
                receiptHash: request.receiptHash,
            })),
        },
        memory: {
            source: "server",
            samples: Array.from({ length: (cooldownEndedAtMs - rampStartedAtMs) / 5_000 + 1 }, (_, index) => {
                const capturedAtMs = rampStartedAtMs + index * 5_000;
                return {
                    runId,
                    serverInstanceId: "instance-a",
                    build: EXPECTED_BUILD,
                    capturedAtMs,
                    rssBytes: capturedAtMs === steadyStartedAtMs + 90_000
                        ? 700 * 1024 * 1024
                        : capturedAtMs === cooldownEndedAtMs
                            ? 600 * 1024 * 1024
                            : 512 * 1024 * 1024,
                };
            }),
        },
    };
}

async function createEvidenceBundle() {
    const evidence = passingEvidence();
    const directory = await mkdtemp(join(tmpdir(), "omr-initial-ops-evidence-"));
    const suffix = createHash("sha256").update(evidence.runId).digest("hex").slice(0, 16);
    const artifactContents = {
        preflight: `${JSON.stringify({ target: evidence.target, probes: evidence.probes })}\n`,
        driver: [
            { kind: "lifecycle", event: "external-state-attested" },
            { kind: "lifecycle", event: "fixture-created", organizationId: `teacher_${suffix}`, examId: `initial_ops_exam_${suffix}` },
            { kind: "run", schemaVersion: evidence.schemaVersion, runId: evidence.runId, timeline: evidence.timeline },
            ...evidence.vus.map((record) => ({ kind: "vu", ...record })),
            ...evidence.requests.map((record) => ({ kind: "request", ...record })),
            ...evidence.livePropagation.map((record) => ({ kind: "livePropagation", ...record })),
            { kind: "lifecycle", event: "cleanup-verified", organizationId: `teacher_${suffix}`, examId: `initial_ops_exam_${suffix}` },
        ].map((record) => JSON.stringify({ runId: evidence.runId, ...record })).join("\n") + "\n",
        database: [
            {
                kind: "databaseWindow",
                instrumentation: evidence.database.instrumentation,
                runId: evidence.database.runId,
                databaseProjectRefHash: evidence.database.databaseProjectRefHash,
                statsResetAtMs: evidence.database.statsResetAtMs,
                windowStartedAtMs: evidence.database.windowStartedAtMs,
                windowEndedAtMs: evidence.database.windowEndedAtMs,
                countersBefore: evidence.database.countersBefore,
                countersAfter: evidence.database.countersAfter,
                attemptInventory: evidence.database.attemptInventory,
            },
            ...evidence.database.rows.map((record) => ({ kind: "query", ...record })),
        ].map((record) => JSON.stringify(record)).join("\n") + "\n",
        rss: evidence.memory.samples.map((record) => JSON.stringify({
            kind: "rss", source: evidence.memory.source, ...record,
        })).join("\n") + "\n",
        storage: evidence.storage.map((record) => JSON.stringify({ kind: "storage", ...record })).join("\n") + "\n",
    };
    const descriptors = [
        ["preflight", "preflight.json", 1],
        ["driver", "driver.ndjson", 4 + evidence.vus.length + evidence.requests.length + evidence.livePropagation.length],
        ["database", "database.ndjson", 1 + evidence.database.rows.length],
        ["rss", "rss.ndjson", evidence.memory.samples.length],
        ["storage", "storage.ndjson", evidence.storage.length],
    ] as const;
    const artifacts = [];
    for (const [kind, relativePath, recordCount] of descriptors) {
        const content = artifactContents[kind];
        await writeFile(join(directory, relativePath), content, { encoding: "utf8", mode: 0o600, flag: "wx" });
        artifacts.push({
            kind,
            relativePath,
            bytes: Buffer.byteLength(content),
            recordCount,
            sha256: createHash("sha256").update(content).digest("hex"),
        });
    }
    await writeFile(join(directory, "manifest.json"), `${JSON.stringify({
        schemaVersion: 2,
        runId: evidence.runId,
        runChallenge: "f".repeat(32),
        fixture: "initial-ops-100",
        target: evidence.target,
        createdAt: "2026-08-07T00:00:00.000Z",
        closed: true,
        artifacts,
    })}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return { directory, evidence };
}

async function rewriteBundleArtifact(directory: string, kind: string, relativePath: string, content: string) {
    await writeFile(join(directory, relativePath), content, { encoding: "utf8", flag: "w" });
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const descriptor = manifest.artifacts.find((artifact: { kind: string }) => artifact.kind === kind);
    descriptor.bytes = Buffer.byteLength(content);
    descriptor.sha256 = createHash("sha256").update(content).digest("hex");
    descriptor.recordCount = relativePath.endsWith(".ndjson")
        ? content.split("\n").filter(Boolean).length
        : 1;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "w" });
}

async function withPreflightServer(
    handler: (request: IncomingMessage, response: ServerResponse) => void,
    operation: (baseUrl: string) => Promise<void>,
) {
    const server = createServer(handler);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
    try {
        await operation(`http://127.0.0.1:${address.port}`);
    } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
}

function preflightResponse(
    url: URL,
    status: number,
    body: Record<string, unknown>,
    headerOverrides: Record<string, string> = {},
) {
    const response = new Response(JSON.stringify(body), {
        status,
        headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
            "strict-transport-security": "max-age=31536000; includeSubDomains",
            "x-content-type-options": "nosniff",
            "x-frame-options": "DENY",
            "referrer-policy": "strict-origin-when-cross-origin",
            "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            ...headerOverrides,
        },
    });
    Object.defineProperties(response, {
        url: { value: url.toString() },
        redirected: { value: false },
    });
    return response;
}

describe("initial operations load gate", () => {
    it("publishes the exact first-release 100-user capacity envelope", async () => {
        await expect(import("./initial-operations-core.mjs")).resolves.toMatchObject({
            INITIAL_OPERATIONS_GATE: {
                schemaVersion: 1,
                virtualUsers: 100,
                students: 80,
                teacherLivePollers: 10,
                teacherUploaders: 10,
                concurrentSubmissions: 80,
                concurrentMaxPdfUploads: 10,
                maxPdfBytes: 50 * 1024 * 1024,
                gatewayReadP95Ms: 750,
                submitRpcP95Ms: 1_500,
                submitEndToEndP99Ms: 9_000,
                maximumQueryMs: 500,
                maximumResponseBytes: 5 * 1024 * 1024,
                livePropagationMs: 6_000,
                rampUsersPerSecond: 5,
                steadyDurationMs: 3 * 60 * 1_000,
                cooldownDurationMs: 2 * 60 * 1_000,
                rssResidualRatio: 0.1,
                rssResidualFloorBytes: 128 * 1024 * 1024,
                checkpointIntervalMs: 5_000,
                heartbeatIntervalMs: 15_000,
                teacherPollIntervalMs: 3_000,
            },
        });
    });

    it("builds 100 stable VU identities with an 80-submit barrier and ten distinct upload actors", async () => {
        const core = await import("./initial-operations-core.mjs");
        expect(core.buildInitialOperationsWorkload).toBeTypeOf("function");
        const workload = core.buildInitialOperationsWorkload("run-20260807-001");
        const suffix = createHash("sha256").update("run-20260807-001").digest("hex").slice(0, 16);

        expect(workload.steady).toHaveLength(100);
        expect(new Set(workload.steady.map((item: { vuId: string }) => item.vuId)).size).toBe(100);
        expect(workload.steady.every((item: { actorId: string }) => item.actorId.includes(suffix))).toBe(true);
        expect(workload.steady.filter((item: { operation: string }) => item.operation === "student-read")).toHaveLength(80);
        expect(workload.steady.filter((item: { operation: string }) => item.operation === "teacher-live-read")).toHaveLength(10);
        expect(workload.steady.filter((item: { operation: string }) => item.operation === "teacher-upload-read")).toHaveLength(10);
        expect(workload.submissions).toHaveLength(80);
        expect(workload.submissionReplays).toHaveLength(80);
        expect(workload.submissionReplays.map((item: { requestId: string }) => item.requestId)).not.toEqual(
            workload.submissions.map((item: { requestId: string }) => item.requestId),
        );
        expect(workload.submissionReplays.map((item: { idempotencyKey: string }) => item.idempotencyKey)).toEqual(
            workload.submissions.map((item: { idempotencyKey: string }) => item.idempotencyKey),
        );
        expect(workload.uploads).toHaveLength(10);
        expect(new Set(workload.uploads.map((item: { actorId: string }) => item.actorId)).size).toBe(10);
        expect(workload.uploads.every((item: { byteSize: number }) => item.byteSize === 50 * 1024 * 1024)).toBe(true);
        expect(workload.fixture).toEqual({
            organizationId: `teacher_${suffix}`,
            examId: `initial_ops_exam_${suffix}`,
        });
        expect(workload.uploads.every((item: { organizationId: string; examId: string; objectPath?: string }) => (
            item.organizationId === workload.fixture.organizationId
            && item.examId === workload.fixture.examId
            && item.objectPath === undefined
        ))).toBe(true);
        expect(workload.cadence).toEqual({
            checkpoint: { actors: 80, intervalMs: 5_000, minimumRequests: 2_800 },
            heartbeat: { actors: 80, intervalMs: 15_000, minimumRequests: 880 },
            teacherLiveRead: { actors: 10, intervalMs: 3_000, minimumRequests: 590 },
        });
    });

    it("resolves only an explicitly confirmed isolated staging target", async () => {
        const core = await import("./initial-operations-core.mjs");
        expect(core.resolveInitialOperationsConfig).toBeTypeOf("function");
        const config = core.resolveInitialOperationsConfig({
            argv: [
                "--run",
                "--confirm-staging-host=staging.omr.example",
                "--confirm-load-fixture=initial-ops-100",
                "--output=/tmp/initial-ops-evidence",
            ],
            env: {
                OMR_INITIAL_OPS_STAGING_URL: "https://staging.omr.example",
                OMR_PRODUCTION_BASE_URL: "https://omr.example",
                OMR_INITIAL_OPS_STAGING_SUPABASE_URL: "https://stagingprojectref.supabase.co",
                OMR_PRODUCTION_SUPABASE_URL: "https://productionproject.supabase.co",
                OMR_INITIAL_OPS_TOKEN: "load-token-that-is-at-least-32-bytes",
                OMR_READINESS_TOKEN: "readiness-token-that-is-at-least-32-bytes",
                OMR_INITIAL_OPS_EXPECTED_BUILD: "a".repeat(40),
                OMR_INITIAL_OPS_LOAD_ENABLED: "1",
            },
            cwd: "/workspace/omr",
        }) as ReturnType<typeof core.resolveInitialOperationsConfig> & {
            loadToken: string;
            readinessToken: string;
        };

        expect(config).toEqual({
            mode: "run",
            baseUrl: "https://staging.omr.example",
            productionBaseUrl: "https://omr.example",
            stagingSupabaseUrl: "https://stagingprojectref.supabase.co",
            productionSupabaseUrl: "https://productionproject.supabase.co",
            stagingProjectRefHash: STAGING_PROJECT_HASH,
            expectedBuild: "a".repeat(40),
            outputDirectory: "/tmp/initial-ops-evidence",
            fixture: "initial-ops-100",
        });
        expect(config.loadToken).toBe("load-token-that-is-at-least-32-bytes");
        expect(config.readinessToken).toBe("readiness-token-that-is-at-least-32-bytes");
        expect(JSON.stringify(config)).not.toContain("token-that-is-at-least-32-bytes");
    });

    it("fails closed before network access for missing credentials, production reuse, or ambiguous CLI input", async () => {
        const { resolveInitialOperationsConfig } = await import("./initial-operations-core.mjs");
        const baseInput = {
            argv: [
                "--run",
                "--confirm-staging-host=staging.omr.example",
                "--confirm-load-fixture=initial-ops-100",
                "--output=/tmp/initial-ops-evidence",
            ],
            env: {
                OMR_INITIAL_OPS_STAGING_URL: "https://staging.omr.example",
                OMR_PRODUCTION_BASE_URL: "https://omr.example",
                OMR_INITIAL_OPS_STAGING_SUPABASE_URL: "https://stagingprojectref.supabase.co",
                OMR_PRODUCTION_SUPABASE_URL: "https://productionproject.supabase.co",
                OMR_INITIAL_OPS_TOKEN: "load-token-that-is-at-least-32-bytes",
                OMR_READINESS_TOKEN: "readiness-token-that-is-at-least-32-bytes",
                OMR_INITIAL_OPS_EXPECTED_BUILD: "a".repeat(40),
                OMR_INITIAL_OPS_LOAD_ENABLED: "1",
            },
            cwd: "/workspace/omr",
        };

        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: { ...baseInput.env, OMR_INITIAL_OPS_TOKEN: "" },
        })).toThrow(/credentials/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: { ...baseInput.env, OMR_INITIAL_OPS_STAGING_URL: "https://omr.example" },
            argv: baseInput.argv.map((value) => value.startsWith("--confirm-staging-host=")
                ? "--confirm-staging-host=omr.example"
                : value),
        })).toThrow(/production/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: {
                ...baseInput.env,
                OMR_INITIAL_OPS_STAGING_SUPABASE_URL: baseInput.env.OMR_PRODUCTION_SUPABASE_URL,
            },
        })).toThrow(/database/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            argv: [...baseInput.argv, "--unknown"],
        })).toThrow(/unknown/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: { ...baseInput.env, OMR_INITIAL_OPS_LOAD_ENABLED: "true" },
        })).toThrow(/enabled/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: { ...baseInput.env, OMR_INITIAL_OPS_STAGING_URL: "https://omr.example:444" },
            argv: baseInput.argv.map((value) => value.startsWith("--confirm-staging-host=")
                ? "--confirm-staging-host=omr.example"
                : value),
        })).toThrow(/URL|port/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: {
                ...baseInput.env,
                OMR_INITIAL_OPS_STAGING_SUPABASE_URL: "https://productionproject.supabase.co:444",
            },
        })).toThrow(/database|URL|port/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: {
                ...baseInput.env,
                OMR_READINESS_TOKEN: baseInput.env.OMR_INITIAL_OPS_TOKEN,
            },
        })).toThrow(/credentials|distinct/i);
        expect(() => resolveInitialOperationsConfig({
            ...baseInput,
            env: {
                ...baseInput.env,
                OMR_READINESS_TOKEN: "x".repeat(257),
            },
        })).toThrow(/credentials|weak/i);
    });

    it("accepts only complete evidence that satisfies every capacity and correctness budget", async () => {
        const core = await import("./initial-operations-core.mjs");
        expect(core.evaluateInitialOperationsEvidence).toBeTypeOf("function");
        expect(core.evaluateInitialOperationsEvidence(passingEvidence(), {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({
            status: "passed",
            failures: [],
            metrics: {
                gatewayReadP95Ms: 250,
                studentReadP95Ms: 200,
                teacherLiveReadP95Ms: 250,
                teacherUploadReadP95Ms: 230,
                submitRpcP95Ms: 700,
                submitEndToEndP99Ms: 800,
                maximumQueryMs: 300,
                maximumResponseBytes: 4_096,
                rssResidualBytes: 88 * 1024 * 1024,
            },
        });
    });

    it("rejects stored load evidence when deployment configuration was not ready", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const evidence = passingEvidence();
        evidence.probes.readiness.configuration = "not_ready";

        expect(evaluateInitialOperationsEvidence(evidence, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({
            status: "failed",
            failures: expect.arrayContaining([
                expect.objectContaining({ code: "readiness_probe" }),
            ]),
        });
    });

    it("rejects stored load evidence without immutable compressed static assets", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const missing = passingEvidence();
        delete (missing.probes as Record<string, unknown>).staticAssetCompression;
        expect(evaluateInitialOperationsEvidence(missing, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({ status: "unverified" });

        const uncompressed = passingEvidence();
        uncompressed.probes.staticAssetCompression.encoding = "identity";
        expect(evaluateInitialOperationsEvidence(uncompressed, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({
            status: "failed",
            failures: expect.arrayContaining([expect.objectContaining({ code: "static_asset_compression" })]),
        });
    });

    it("rejects checkpoint or heartbeat traffic that starts after a successful submission", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const evidence = passingEvidence();
        const submission = evidence.requests.find((item) => item.operation === "student-submit")!;
        const checkpoint = evidence.requests.filter((item) => item.operation === "checkpoint"
            && item.actorId === submission.actorId).at(-1)!;
        checkpoint.startedAtMs = submission.endedAtMs + 1;
        checkpoint.endedAtMs = checkpoint.startedAtMs + 300;

        expect(evaluateInitialOperationsEvidence(evidence, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        }).failures).toContainEqual(expect.objectContaining({ code: "post_submit_lease_traffic" }));
    });

    it("marks missing proof unverified and reports every hard-gate breach without a partial pass", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        expect(evaluateInitialOperationsEvidence({}, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({ status: "unverified" });

        const evidence = passingEvidence();
        const studentReads = evidence.requests.filter((item) => item.operation === "student-read");
        studentReads.forEach((item) => { item.endedAtMs = item.startedAtMs + 800; });
        studentReads[0].responseBytes = 5 * 1024 * 1024;
        const teacherRead = evidence.requests.find((item) => item.operation === "teacher-live-read")!;
        teacherRead.statusCode = 500;
        teacherRead.success = false;
        const submits = evidence.requests.filter((item) => item.operation === "student-submit");
        submits.forEach((item) => {
            item.serverDurationMs = 1_600;
            item.endedAtMs = item.startedAtMs + 2_000;
        });
        submits.at(-1)!.startedAtMs = submits[0].startedAtMs + 1_001;
        submits.at(-1)!.endedAtMs = submits.at(-1)!.startedAtMs + 2_000;
        submits[1].attemptId = submits[0].attemptId;
        const replays = evidence.requests.filter((item) => item.operation === "student-submit-replay");
        replays[2].receiptHash = "e".repeat(64);
        const upload = evidence.requests.find((item) => item.operation === "teacher-max-pdf-upload")!;
        upload.upload!.directToStorage = false;
        const propagation = evidence.livePropagation[0];
        const source = evidence.requests.find((item) => item.eventId === propagation.sourceEventId)!;
        const observed = evidence.requests.find((item) => item.eventId === propagation.observedEventId)!;
        observed.startedAtMs = source.endedAtMs + 6_001;
        observed.endedAtMs = observed.startedAtMs + 250;
        evidence.database.rows[0].maximumExecutionMs = 501;
        evidence.database.countersAfter.deadlocks += 1;
        evidence.memory.samples.at(-1)!.rssBytes = 700 * 1024 * 1024;

        const result = evaluateInitialOperationsEvidence(evidence, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        });
        expect(result.status).toBe("failed");
        expect(result.failures.map((failure: { code: string }) => failure.code)).toEqual(expect.arrayContaining([
            "gateway_read_p95",
            "response_size",
            "http_5xx",
            "functional_failures",
            "submit_rpc_p95",
            "submission_barrier",
            "duplicate_attempt",
            "idempotency_mismatch",
            "direct_upload",
            "live_propagation",
            "query_latency",
            "deadlock",
            "rss_residual",
        ]));
    });

    it("never passes fabricated summaries, duplicate raw events, sequential VUs, or a substituted workload", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const expectations = {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        };

        expect(evaluateInitialOperationsEvidence({
            ...passingEvidence(),
            requests: undefined,
            scenarios: [{ operation: "student-read", requestCount: 80, latencyMs: Array(80).fill(1) }],
            artifacts: { rawRequestsSha256: "b".repeat(64) },
        }, expectations)).toMatchObject({ status: "unverified" });

        const duplicated = passingEvidence();
        duplicated.requests[1].eventId = duplicated.requests[0].eventId;
        expect(evaluateInitialOperationsEvidence(duplicated, expectations)).toMatchObject({ status: "unverified" });

        const duplicateActor = passingEvidence();
        duplicateActor.vus[1].actorId = duplicateActor.vus[0].actorId;
        expect(evaluateInitialOperationsEvidence(duplicateActor, expectations))
            .toMatchObject({ status: "unverified" });

        const stalePreflight = passingEvidence();
        delete (stalePreflight.probes.health as { timestamp?: string }).timestamp;
        expect(evaluateInitialOperationsEvidence(stalePreflight, expectations))
            .toMatchObject({ status: "unverified" });

        const splicedDatabase = passingEvidence();
        splicedDatabase.database.runId = "foreign-run";
        expect(evaluateInitialOperationsEvidence(splicedDatabase, expectations))
            .toMatchObject({ status: "unverified" });

        const rssGap = passingEvidence();
        rssGap.memory.samples = [rssGap.memory.samples[0], rssGap.memory.samples.at(-1)!];
        expect(evaluateInitialOperationsEvidence(rssGap, expectations))
            .toMatchObject({ status: "unverified" });

        const missingServerTiming = passingEvidence();
        missingServerTiming.requests.filter((item) => item.operation === "student-submit")
            .forEach((item) => { delete item.serverDurationMs; });
        expect(evaluateInitialOperationsEvidence(missingServerTiming, expectations))
            .toMatchObject({ status: "unverified" });

        const sequential = passingEvidence();
        sequential.vus[0].activeEndedAtMs = sequential.timeline.steadyStartedAtMs + 1;
        const sequentialResult = evaluateInitialOperationsEvidence(sequential, expectations);
        expect(sequentialResult.status).toBe("failed");
        expect(sequentialResult.failures).toContainEqual(expect.objectContaining({ code: "vu_overlap" }));

        const substituted = passingEvidence();
        const submit = substituted.requests.find((item) => item.operation === "student-submit")!;
        substituted.requests.push({
            ...submit,
            eventId: `${substituted.runId}:event:extra`,
            requestId: `${substituted.runId}:request:extra`,
            idempotencyKey: `${substituted.runId}:submission:extra`,
            attemptId: "attempt-extra",
            receiptHash: "f".repeat(64),
        });
        const result = evaluateInitialOperationsEvidence(substituted, expectations);
        expect(result.status).toBe("failed");
        expect(result.failures).toContainEqual(expect.objectContaining({ code: "workload_shape" }));

        const staleLiveObservation = passingEvidence();
        const link = staleLiveObservation.livePropagation[0];
        const source = staleLiveObservation.requests.find((item) => item.eventId === link.sourceEventId)!;
        const observed = staleLiveObservation.requests.find((item) => item.eventId === link.observedEventId)!;
        observed.observedRevisions![source.actorId] = 0;
        expect(evaluateInitialOperationsEvidence(staleLiveObservation, expectations).failures)
            .toContainEqual(expect.objectContaining({ code: "live_propagation_evidence" }));

        const mismatchedReadback = passingEvidence();
        mismatchedReadback.storage[0].readbackSha256 = "0".repeat(64);
        expect(evaluateInitialOperationsEvidence(mismatchedReadback, expectations).failures)
            .toContainEqual(expect.objectContaining({ code: "direct_upload" }));

        const collapsedReplays = passingEvidence();
        const firstPrimary = collapsedReplays.requests.find((item) => item.operation === "student-submit")!;
        collapsedReplays.requests.filter((item) => item.operation === "student-submit-replay").forEach((item) => {
            item.vuId = firstPrimary.vuId;
            item.actorId = firstPrimary.actorId;
            item.idempotencyKey = firstPrimary.idempotencyKey;
            item.attemptId = firstPrimary.attemptId;
            item.receiptHash = firstPrimary.receiptHash;
        });
        expect(evaluateInitialOperationsEvidence(collapsedReplays, expectations).failures)
            .toContainEqual(expect.objectContaining({ code: "idempotency_coverage" }));

        const collapsedSubmitters = passingEvidence();
        const firstStudent = collapsedSubmitters.vus.find((vu) => vu.role === "student")!;
        collapsedSubmitters.requests.filter((item) => (
            item.operation === "student-submit" || item.operation === "student-submit-replay"
        )).forEach((item) => {
            item.vuId = firstStudent.vuId;
            item.actorId = firstStudent.actorId;
        });
        expect(evaluateInitialOperationsEvidence(collapsedSubmitters, expectations).failures)
            .toContainEqual(expect.objectContaining({ code: "submission_actor_coverage" }));

        const duplicateUploadObject = passingEvidence();
        const firstUpload = duplicateUploadObject.requests.find((item) => item.operation === "teacher-max-pdf-upload")!;
        duplicateUploadObject.requests.filter((item) => item.operation === "teacher-max-pdf-upload")
            .forEach((item) => { item.upload!.objectPath = firstUpload.upload!.objectPath; });
        duplicateUploadObject.storage.forEach((record) => { record.objectPath = firstUpload.upload!.objectPath; });
        expect(evaluateInitialOperationsEvidence(duplicateUploadObject, expectations).failures)
            .toContainEqual(expect.objectContaining({ code: "direct_upload" }));

        const missingDatabaseAttempt = passingEvidence();
        missingDatabaseAttempt.database.attemptInventory.pop();
        expect(evaluateInitialOperationsEvidence(missingDatabaseAttempt, expectations).failures)
            .toContainEqual(expect.objectContaining({ code: "database_attempt_inventory" }));
    });

    it("accepts bounded in-path RSS checkpoints without pretending a separate route sampled continuously", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const evidence = passingEvidence();
        const { rampStartedAtMs, steadyStartedAtMs, cooldownEndedAtMs } = evidence.timeline;
        evidence.memory.samples = [
            { runId: evidence.runId, serverInstanceId: "instance-a", build: EXPECTED_BUILD, capturedAtMs: rampStartedAtMs - 1, rssBytes: 512 * 1024 * 1024 },
            { runId: evidence.runId, serverInstanceId: "instance-a", build: EXPECTED_BUILD, capturedAtMs: steadyStartedAtMs + 1, rssBytes: 640 * 1024 * 1024 },
            { runId: evidence.runId, serverInstanceId: "instance-a", build: EXPECTED_BUILD, capturedAtMs: cooldownEndedAtMs, rssBytes: 520 * 1024 * 1024 },
        ];

        expect(evaluateInitialOperationsEvidence(evidence, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({ status: "passed" });
    });

    it("fails when any workload-serving instance retains RSS after cooldown", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const evidence = passingEvidence();
        evidence.requests[0].serverInstanceId = "instance-b";
        const { rampStartedAtMs, steadyStartedAtMs, cooldownEndedAtMs } = evidence.timeline;
        const sample = (serverInstanceId: string, capturedAtMs: number, rssBytes: number) => ({
            runId: evidence.runId, serverInstanceId, build: EXPECTED_BUILD, capturedAtMs, rssBytes,
        });
        evidence.memory.samples = [
            sample("instance-b", rampStartedAtMs - 1, 512 * 1024 * 1024),
            sample("instance-b", steadyStartedAtMs + 1, 700 * 1024 * 1024),
            sample("instance-b", cooldownEndedAtMs, 700 * 1024 * 1024),
            sample("instance-a", rampStartedAtMs - 1, 512 * 1024 * 1024),
            sample("instance-a", steadyStartedAtMs + 1, 600 * 1024 * 1024),
            sample("instance-a", cooldownEndedAtMs, 512 * 1024 * 1024),
        ];

        expect(evaluateInitialOperationsEvidence(evidence, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        })).toMatchObject({
            status: "failed",
            failures: expect.arrayContaining([expect.objectContaining({ code: "rss_residual" })]),
        });
    });

    it("enforces strict response and per-route latency budgets from raw requests", async () => {
        const { evaluateInitialOperationsEvidence } = await import("./initial-operations-core.mjs");
        const evidence = passingEvidence();
        const studentReads = evidence.requests.filter((item) => item.operation === "student-read");
        studentReads.forEach((item) => {
            item.endedAtMs = item.startedAtMs + 800;
            item.responseBytes = 5 * 1024 * 1024;
        });
        const result = evaluateInitialOperationsEvidence(evidence, {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        });
        expect(result.status).toBe("failed");
        expect(result.failures).toEqual(expect.arrayContaining([
            expect.objectContaining({ code: "student_read_p95" }),
            expect.objectContaining({ code: "response_size" }),
        ]));
    });

    it("preflights the live candidate over bounded HTTP without exposing either bearer token", async () => {
        const verifier = await import("./verify-initial-operations.mjs");
        expect(verifier.runInitialOperationsPreflight).toBeTypeOf("function");
        const authorization: Array<string | undefined> = [];

        await withPreflightServer((request, response) => {
            authorization.push(request.headers.authorization);
            const headers = {
                "content-type": "application/json",
                "cache-control": "no-store",
                "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
                "strict-transport-security": "max-age=31536000; includeSubDomains",
                "x-content-type-options": "nosniff",
                "x-frame-options": "DENY",
                "referrer-policy": "strict-origin-when-cross-origin",
                "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
            };
            if (request.url === "/api/healthz") {
                response.writeHead(200, headers).end(JSON.stringify({
                    status: "alive",
                    build: EXPECTED_BUILD,
                    timestamp: new Date().toISOString(),
                }));
            } else if (request.url === "/api/readyz" && !request.headers.authorization) {
                response.writeHead(401, headers).end(JSON.stringify({ status: "unauthorized" }));
            } else if (request.url === "/api/readyz") {
                response.writeHead(200, headers).end(JSON.stringify({
                    status: "ready",
                    database: "ready",
                    observability: "ready",
                    configuration: "ready",
                    version: "202608060029",
                    environment: "staging",
                    build: EXPECTED_BUILD,
                    databaseProjectRefHash: STAGING_PROJECT_HASH,
                }));
            } else if (request.url === "/") {
                response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
                    .end('<script src="/_next/static/chunks/app-shell.js" async></script>');
            } else if (request.url === "/_next/static/chunks/app-shell.js") {
                response.writeHead(200, {
                    "content-type": "application/javascript; charset=utf-8",
                    "content-encoding": "gzip",
                    "cache-control": "public, max-age=31536000, immutable",
                }).end(gzipSync("console.log('bounded fixture')"));
            } else {
                response.writeHead(404, headers).end("{}");
            }
        }, async (baseUrl) => {
            const result = await verifier.runInitialOperationsPreflight({
                baseUrl,
                expectedBuild: EXPECTED_BUILD,
                stagingProjectRefHash: STAGING_PROJECT_HASH,
                readinessToken: "readiness-token-that-is-at-least-32-bytes",
            });
            const expectedProbes = passingEvidence().probes;
            expect(result).toMatchObject({
                health: {
                    statusCode: 200,
                    status: "alive",
                    build: EXPECTED_BUILD,
                },
                readinessUnauthorized: expectedProbes.readinessUnauthorized,
                readiness: expectedProbes.readiness,
                securityHeaders: expectedProbes.securityHeaders,
                staticAssetCompression: {
                    statusCode: 200,
                    encoding: "gzip",
                    cachePolicy: "immutable",
                },
            });
            expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true);
            const serialized = JSON.stringify(result);
            expect(serialized).not.toContain("readiness-token-that-is-at-least-32-bytes");
            expect(serialized).not.toContain("load-token-that-is-at-least-32-bytes");
        });
        expect(authorization).toHaveLength(5);
        expect(authorization.filter(Boolean)).toEqual([
            "Bearer readiness-token-that-is-at-least-32-bytes",
        ]);
    });

    it("proves that the staging CDN serves an immutable first-party JavaScript chunk with compression", async () => {
        const { probeStaticAssetCompression } = await import("./verify-initial-operations.mjs");
        expect(probeStaticAssetCompression).toBeTypeOf("function");
        const calls: string[] = [];
        const responseAt = (url: URL, body: string, headers: Record<string, string>) => {
            const response = new Response(body, { status: 200, headers });
            Object.defineProperties(response, {
                url: { value: url.toString() },
                redirected: { value: false },
            });
            return response;
        };
        const compressedFetch = async (input: RequestInfo | URL) => {
            const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
            calls.push(url.toString());
            if (url.pathname === "/") return responseAt(url,
                '<script src="/_next/static/chunks/app-shell.js" async></script>',
                { "content-type": "text/html; charset=utf-8" });
            return responseAt(url, "console.log('bounded fixture')", {
                "content-type": "application/javascript; charset=utf-8",
                "content-encoding": "br",
                "cache-control": "public, max-age=31536000, immutable",
            });
        };

        await expect(probeStaticAssetCompression({ baseUrl: "https://staging.omr.example" }, compressedFetch))
            .resolves.toEqual({ statusCode: 200, encoding: "br", cachePolicy: "immutable" });
        expect(calls).toEqual([
            "https://staging.omr.example/",
            "https://staging.omr.example/_next/static/chunks/app-shell.js",
        ]);

        await expect(probeStaticAssetCompression({ baseUrl: "https://staging.omr.example" }, async (input: RequestInfo | URL) => {
            const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
            if (url.pathname === "/") return responseAt(url,
                '<script src="/_next/static/chunks/app-shell.js"></script>',
                { "content-type": "text/html" });
            return responseAt(url, "uncompressed", {
                "content-type": "application/javascript",
                "cache-control": "public, max-age=31536000, immutable",
            });
        })).rejects.toThrow(/compression/i);
    });

    it("rejects a green-looking candidate that omits deployment configuration readiness", async () => {
        const { runInitialOperationsPreflight } = await import("./verify-initial-operations.mjs");
        const config = {
            baseUrl: "https://staging.omr.example",
            expectedBuild: EXPECTED_BUILD,
            stagingProjectRefHash: STAGING_PROJECT_HASH,
            readinessToken: "readiness-token-that-is-at-least-32-bytes",
        };
        let call = 0;
        const fetchImpl = async (url: URL) => {
            call += 1;
            if (call === 1) return preflightResponse(url, 200, {
                status: "alive",
                build: EXPECTED_BUILD,
                timestamp: new Date().toISOString(),
            });
            if (call === 2) return preflightResponse(url, 401, { status: "unauthorized" });
            return preflightResponse(url, 200, {
                status: "ready",
                database: "ready",
                observability: "ready",
                version: "202608060029",
                environment: "staging",
                build: EXPECTED_BUILD,
                databaseProjectRefHash: STAGING_PROJECT_HASH,
            });
        };

        await expect(runInitialOperationsPreflight(config, { fetchImpl, assetCompressionProbe: passingStaticAssetProbe }))
            .rejects.toThrow(/isolated staging candidate/i);
    });

    it("keeps the timeout active while reading the body and parses security directives exactly", async () => {
        const { runInitialOperationsPreflight } = await import("./verify-initial-operations.mjs");
        const config = {
            baseUrl: "https://staging.omr.example",
            expectedBuild: EXPECTED_BUILD,
            stagingProjectRefHash: STAGING_PROJECT_HASH,
            readinessToken: "readiness-token-that-is-at-least-32-bytes",
        };
        const hangingBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("{"));
            },
            cancel() {
                return new Promise<void>(() => undefined);
            },
        });
        const hangingResponse = new Response(hangingBody, {
            status: 200,
            headers: { "content-type": "application/json", "cache-control": "no-store" },
        });
        Object.defineProperties(hangingResponse, {
            url: { value: "https://staging.omr.example/api/healthz" },
            redirected: { value: false },
        });
        const timeoutOutcome = await Promise.race([
            runInitialOperationsPreflight(config, {
                fetchImpl: async () => hangingResponse,
                healthTimeoutMs: 20,
            }).then(() => "resolved", () => "rejected"),
            new Promise<string>((resolve) => setTimeout(() => resolve("hung"), 150)),
        ]);
        expect(timeoutOutcome).toBe("rejected");

        let call = 0;
        const invalidCspFetch = async (url: URL) => {
            call += 1;
            if (call === 1) return preflightResponse(url, 200, {
                status: "alive", build: EXPECTED_BUILD, timestamp: new Date().toISOString(),
            }, { "content-security-policy": "xdefault-src 'self'; xframe-ancestors 'none'" });
            if (call === 2) return preflightResponse(url, 401, { status: "unauthorized" });
            return preflightResponse(url, 200, {
                status: "ready",
                database: "ready",
                observability: "ready",
                version: "202608060029",
                environment: "staging",
                build: EXPECTED_BUILD,
                databaseProjectRefHash: STAGING_PROJECT_HASH,
            });
        };
        await expect(runInitialOperationsPreflight(config, {
            fetchImpl: invalidCspFetch,
            assetCompressionProbe: passingStaticAssetProbe,
        }))
            .rejects.toThrow(/security headers/i);

        call = 0;
        const duplicateCspFetch = async (url: URL) => {
            call += 1;
            if (call === 1) return preflightResponse(url, 200, {
                status: "alive", build: EXPECTED_BUILD, timestamp: new Date().toISOString(),
            }, { "content-security-policy": "default-src 'none'; default-src 'self'; frame-ancestors 'none'" });
            if (call === 2) return preflightResponse(url, 401, { status: "unauthorized" });
            return preflightResponse(url, 200, passingEvidence().probes.readiness);
        };
        await expect(runInitialOperationsPreflight(config, {
            fetchImpl: duplicateCspFetch,
            assetCompressionProbe: passingStaticAssetProbe,
        }))
            .rejects.toThrow(/security headers/i);
    });

    it("rejects duplicate JSON response keys during live preflight", async () => {
        const { runInitialOperationsPreflight } = await import("./verify-initial-operations.mjs");
        const url = "https://staging.omr.example/api/healthz";
        const duplicateBody = new Response(
            `{"status":"wrong","status":"alive","build":"${EXPECTED_BUILD}","timestamp":"${new Date().toISOString()}"}`,
            { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } },
        );
        Object.defineProperties(duplicateBody, {
            url: { value: url },
            redirected: { value: false },
        });
        await expect(runInitialOperationsPreflight({
            baseUrl: "https://staging.omr.example",
            expectedBuild: EXPECTED_BUILD,
            stagingProjectRefHash: STAGING_PROJECT_HASH,
            readinessToken: "readiness-token-that-is-at-least-32-bytes",
        }, { fetchImpl: async () => duplicateBody }))
            .rejects.toThrow(/preflight request failed/i);
    });

    it("rehashes and evaluates a closed raw evidence bundle, rejecting tampering and symlinks", async () => {
        const bundle = await import("./initial-operations-evidence-bundle.mjs");
        expect(bundle.evaluateInitialOperationsEvidenceBundle).toBeTypeOf("function");
        const expectations = {
            expectedBuild: EXPECTED_BUILD,
            expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
        };

        const valid = await createEvidenceBundle();
        try {
            await expect(bundle.evaluateInitialOperationsEvidenceBundle(valid.directory, expectations))
                .resolves.toMatchObject({ status: "passed", failures: [] });
            await writeFile(join(valid.directory, "driver.ndjson"), "{}\n", { flag: "a" });
            await expect(bundle.evaluateInitialOperationsEvidenceBundle(valid.directory, expectations))
                .resolves.toMatchObject({ status: "unverified" });
        } finally {
            await rm(valid.directory, { recursive: true, force: true });
        }

        const linked = await createEvidenceBundle();
        try {
            const storagePath = join(linked.directory, "storage.ndjson");
            await rm(storagePath);
            await symlink(join(linked.directory, "rss.ndjson"), storagePath);
            await expect(bundle.evaluateInitialOperationsEvidenceBundle(linked.directory, expectations))
                .resolves.toMatchObject({ status: "unverified" });
        } finally {
            await rm(linked.directory, { recursive: true, force: true });
        }

        const duplicateKey = await createEvidenceBundle();
        try {
            const driverPath = join(duplicateKey.directory, "driver.ndjson");
            const original = await readFile(driverPath, "utf8");
            const malformed = original.replace(
                `"runId":"${duplicateKey.evidence.runId}"`,
                `"runId":"foreign-run","runId":"${duplicateKey.evidence.runId}"`,
            );
            await rewriteBundleArtifact(duplicateKey.directory, "driver", "driver.ndjson", malformed);
            await expect(bundle.evaluateInitialOperationsEvidenceBundle(duplicateKey.directory, expectations))
                .resolves.toMatchObject({ status: "unverified" });
        } finally {
            await rm(duplicateKey.directory, { recursive: true, force: true });
        }

        const reorderedTarget = await createEvidenceBundle();
        try {
            const manifestPath = join(reorderedTarget.directory, "manifest.json");
            const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
            manifest.target = Object.fromEntries(Object.entries(manifest.target).reverse());
            await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { encoding: "utf8", flag: "w" });
            await expect(bundle.evaluateInitialOperationsEvidenceBundle(reorderedTarget.directory, expectations))
                .resolves.toMatchObject({ status: "passed", failures: [] });
        } finally {
            await rm(reorderedTarget.directory, { recursive: true, force: true });
        }
    });

    it("accepts only the verified driver lifecycle surrounding an otherwise valid bundle", async () => {
        const { evaluateInitialOperationsEvidenceBundle } = await import("./initial-operations-evidence-bundle.mjs");
        const valid = await createEvidenceBundle();
        try {
            await expect(evaluateInitialOperationsEvidenceBundle(valid.directory, {
                expectedBuild: EXPECTED_BUILD,
                expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
            })).resolves.toMatchObject({ status: "passed", failures: [] });
            const driverPath = join(valid.directory, "driver.ndjson");
            const records = (await readFile(driverPath, "utf8")).trimEnd().split("\n")
                .map(line => JSON.parse(line));
            const cleanup = records.pop();
            records.splice(3, 0, cleanup);
            await rewriteBundleArtifact(
                valid.directory,
                "driver",
                "driver.ndjson",
                `${records.map(record => JSON.stringify(record)).join("\n")}\n`,
            );
            await expect(evaluateInitialOperationsEvidenceBundle(valid.directory, {
                expectedBuild: EXPECTED_BUILD,
                expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
            })).resolves.toMatchObject({ status: "unverified" });
        } finally {
            await rm(valid.directory, { recursive: true, force: true });
        }
    });

    it("serializes collected DB and RSS evidence into a closed bundle before success is possible", async () => {
        const bundle = await import("./initial-operations-evidence-bundle.mjs");
        expect(typeof bundle.serializeInitialOperationsEvidenceBundle).toBe("function");
        expect(typeof bundle.initialOperationsRunSucceeded).toBe("function");
        const pending = { status: "collected", code: "evaluation_required", cleanupVerified: true };
        expect(bundle.initialOperationsRunSucceeded(pending, undefined)).toBe(false);
        expect(bundle.initialOperationsRunSucceeded(pending, { status: "unverified" })).toBe(false);

        const valid = await createEvidenceBundle();
        try {
            await rm(join(valid.directory, "database.ndjson"));
            await rm(join(valid.directory, "rss.ndjson"));
            await rm(join(valid.directory, "manifest.json"));
            const evidence = valid.evidence;
            const databaseEvidence = [
                {
                    status: "ok", kind: "databaseWindow", phase: "before",
                    instrumentation: evidence.database.instrumentation,
                    statsResetAt: new Date(evidence.database.statsResetAtMs).toISOString(),
                    capturedAt: new Date(evidence.database.windowStartedAtMs).toISOString(),
                    counters: evidence.database.countersBefore,
                    rows: evidence.database.rows.map((row) => ({
                        workloadPath: row.workloadPath,
                        fingerprint: row.fingerprint,
                        calls: row.callsBefore,
                        maximumExecutionMs: row.maximumExecutionMs,
                    })),
                    attemptInventory: [],
                },
                {
                    status: "ok", kind: "databaseWindow", phase: "after",
                    instrumentation: evidence.database.instrumentation,
                    statsResetAt: new Date(evidence.database.statsResetAtMs).toISOString(),
                    capturedAt: new Date(evidence.database.windowEndedAtMs).toISOString(),
                    counters: evidence.database.countersAfter,
                    rows: evidence.database.rows.map((row) => ({
                        workloadPath: row.workloadPath,
                        fingerprint: row.fingerprint,
                        calls: row.callsAfter,
                        maximumExecutionMs: row.maximumExecutionMs,
                    })),
                    attemptInventory: evidence.database.attemptInventory,
                },
            ];
            const rssEvidence = evidence.memory.samples.map(sample => ({
                kind: "rss", source: evidence.memory.source, ...sample,
            }));
            await bundle.serializeInitialOperationsEvidenceBundle(valid.directory, {
                runId: evidence.runId,
                runChallenge: "f".repeat(32),
                databaseProjectRefHash: STAGING_PROJECT_HASH,
                databaseEvidence,
                rssEvidence,
                createdAt: "2026-08-07T00:00:00.000Z",
            });
            const evaluation = await bundle.evaluateInitialOperationsEvidenceBundle(valid.directory, {
                expectedBuild: EXPECTED_BUILD,
                expectedDatabaseProjectRefHash: STAGING_PROJECT_HASH,
            });
            expect(evaluation).toMatchObject({ status: "passed", failures: [] });
            expect(bundle.initialOperationsRunSucceeded(pending, evaluation)).toBe(true);
            await expect(readFile(join(valid.directory, "database.ndjson"), "utf8")).resolves.toContain('"kind":"databaseWindow"');
            await expect(readFile(join(valid.directory, "rss.ndjson"), "utf8")).resolves.toContain('"kind":"rss"');
            await expect(readFile(join(valid.directory, "manifest.json"), "utf8")).resolves.toContain('"closed":true');
        } finally {
            await rm(valid.directory, { recursive: true, force: true });
        }
    });

    it("parses strict JSON without prototype mutation", async () => {
        const { parseStrictJson } = await import("./strict-json.mjs");
        const parsed = parseStrictJson('{"__proto__":{"polluted":true},"safe":1}') as Record<string, unknown>;
        expect(Object.getPrototypeOf(parsed)).toBeNull();
        expect(Object.prototype.hasOwnProperty.call(parsed, "__proto__")).toBe(true);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    });
});
