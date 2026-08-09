import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import {
    buildInitialOperationsWorkload,
    INITIAL_OPERATIONS_GATE,
} from "./initial-operations-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const GIT_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RUN_ID = /^[a-z0-9][a-z0-9-]{7,63}$/;
const CHALLENGE = /^[a-f0-9]{32,128}$/;
const OPERATIONS = new Set([
    "student-read",
    "teacher-live-read",
    "teacher-upload-read",
    "checkpoint",
    "heartbeat",
    "student-submit",
    "student-submit-replay",
    "teacher-max-pdf-upload-prepare",
    "teacher-max-pdf-upload-finalize",
    "instance-rss-read",
]);

export const INITIAL_OPERATIONS_CONTROL_PRODUCTION_PATHS = Object.freeze({
    "student-read": Object.freeze(["rpc:omr_open_attempt_session_v3"]),
    checkpoint: Object.freeze(["rpc:omr_checkpoint_attempt_session_v2"]),
    heartbeat: Object.freeze(["rpc:omr_heartbeat_attempt_session_v2"]),
    "teacher-live-read": Object.freeze(["rpc:omr_list_active_attempt_sessions_v2"]),
    "teacher-upload-read": Object.freeze(["table:omr_remote_assets"]),
    "student-submit": Object.freeze([
        "rpc:omr_prepare_attempt_session_submit_v2",
        "rpc:omr_commit_attempt_session_submit_v2",
    ]),
    "student-submit-replay": Object.freeze([
        "rpc:omr_prepare_attempt_session_submit_v2",
        "rpc:omr_commit_attempt_session_submit_v2",
    ]),
    "teacher-max-pdf-upload-prepare": Object.freeze(["rpc:omr_prepare_teacher_asset_upload_v2"]),
    "teacher-max-pdf-upload-finalize": Object.freeze([
        "rpc:omr_authorize_teacher_asset_finalize_v2",
        "rpc:omr_finalize_teacher_asset_upload_v2",
    ]),
});

export function firstCheckpointRecordsByActor(records) {
    const first = new Map();
    for (const record of records
        .filter((candidate) => candidate.operation === "checkpoint")
        .sort((left, right) => left.startedAtMs - right.startedAtMs)) {
        if (!first.has(record.actorId)) first.set(record.actorId, record);
    }
    return first;
}

export function buildInPathRssEvidence(runId, build, requestRecords, probeRecords) {
    const workloadInstances = new Set((Array.isArray(requestRecords) ? requestRecords : [])
        .map((record) => clean(record?.serverInstanceId)).filter(Boolean));
    const samples = [];
    for (const record of Array.isArray(probeRecords) ? probeRecords : []) {
        if (record?.kind === "rss" && record?.source === "server"
            && record.runId === runId && record.build === build
            && workloadInstances.has(clean(record.serverInstanceId))
            && Number.isSafeInteger(record.capturedAtMs) && record.capturedAtMs > 0
            && Number.isSafeInteger(record.rssBytes) && record.rssBytes > 0) {
            samples.push({
                kind: "rss", source: "server", runId, build,
                serverInstanceId: clean(record.serverInstanceId),
                capturedAtMs: record.capturedAtMs,
                rssBytes: record.rssBytes,
            });
        }
    }
    for (const record of Array.isArray(requestRecords) ? requestRecords : []) {
        if (workloadInstances.has(clean(record?.serverInstanceId))
            && Number.isSafeInteger(record?.rssCapturedAtMs) && record.rssCapturedAtMs > 0
            && Number.isSafeInteger(record?.rssBytes) && record.rssBytes > 0) {
            samples.push({
                kind: "rss", source: "server", runId, build,
                serverInstanceId: clean(record.serverInstanceId),
                capturedAtMs: record.rssCapturedAtMs,
                rssBytes: record.rssBytes,
            });
        }
    }
    const unique = new Map(samples.map((sample) => [
        `${sample.serverInstanceId}:${sample.capturedAtMs}`,
        sample,
    ]));
    return [...unique.values()].sort((left, right) => left.capturedAtMs - right.capturedAtMs
        || left.serverInstanceId.localeCompare(right.serverInstanceId));
}

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

export function normalizeInitialOperationsTeacherIdentity(value, fixture) {
    if (!value || typeof value !== "object" || Array.isArray(value)
        || !fixture || typeof fixture !== "object" || Array.isArray(fixture)
        || Object.keys(value).sort().join(",") !== [
            "accountId",
            "accountSessionGeneration",
            "actorUserId",
            "sessionAuthority",
        ].join(",")) return null;
    const accountId = clean(value.accountId);
    const actorUserId = clean(value.actorUserId);
    if (value.sessionAuthority !== "legacy_account"
        || !/^teacher_[a-z0-9]{16}$/.test(accountId)
        || accountId !== clean(fixture.organizationId)
        || !/^teacher_[a-z0-9]{7,16}$/.test(actorUserId)
        || !Number.isSafeInteger(value.accountSessionGeneration)
        || value.accountSessionGeneration < 1) return null;
    return Object.freeze({
        sessionAuthority: "legacy_account",
        accountId,
        accountSessionGeneration: value.accountSessionGeneration,
        actorUserId,
    });
}

function strictOrigin(value, label, requiredSuffix = "") {
    let url;
    try {
        url = new URL(clean(value));
    } catch {
        throw new Error(`${label} is invalid`);
    }
    if (url.protocol !== "https:" || url.username || url.password || url.port
        || url.pathname !== "/" || url.search || url.hash
        || (requiredSuffix && !url.hostname.endsWith(requiredSuffix))) {
        throw new Error(`${label} is invalid`);
    }
    return url.origin;
}

function supabaseProjectRef(origin) {
    const ref = new URL(origin).hostname.match(/^([a-z0-9-]+)\.supabase\.co$/)?.[1];
    if (!ref) throw new Error("Staging database target is invalid");
    return ref;
}

function sha256(value) {
    return createHash("sha256").update(value).digest("hex");
}

export function assertInitialOperationsDriverConfig(input) {
    if (!input || typeof input !== "object") throw new Error("Initial-operations driver config is invalid");
    const baseUrl = strictOrigin(input.baseUrl, "Staging application target");
    const productionBaseUrl = strictOrigin(input.productionBaseUrl, "Production application target");
    const stagingSupabaseUrl = strictOrigin(input.stagingSupabaseUrl, "Staging database target", ".supabase.co");
    const productionSupabaseUrl = strictOrigin(input.productionSupabaseUrl, "Production database target", ".supabase.co");
    if (baseUrl === productionBaseUrl) throw new Error("Staging application target must not be production");
    if (stagingSupabaseUrl === productionSupabaseUrl) throw new Error("Staging database target must not be production");
    if (!RUN_ID.test(clean(input.runId)) || !CHALLENGE.test(clean(input.runChallenge))
        || !GIT_SHA.test(clean(input.expectedBuild)) || clean(input.loadToken).length < 32
        || !clean(input.outputDirectory)) throw new Error("Initial-operations driver config is invalid");
    const externalState = input.externalState;
    if (!externalState || typeof externalState !== "object") {
        throw new Error("External state attestation is required");
    }
    const stagingProjectRef = supabaseProjectRef(stagingSupabaseUrl);
    const expectedProjectHash = sha256(stagingProjectRef);
    if (externalState.environment !== "staging"
        || externalState.appOrigin !== baseUrl
        || externalState.storageOrigin !== stagingSupabaseUrl
        || externalState.controlPlaneVersion !== 2
        || stableJson(externalState.productionWorkloadPaths) !== stableJson(INITIAL_OPERATIONS_CONTROL_PRODUCTION_PATHS)
        || externalState.databaseProjectRefHash !== expectedProjectHash) {
        throw new Error("External state attestation does not match staging");
    }
    return { baseUrl, productionBaseUrl, stagingSupabaseUrl, productionSupabaseUrl, stagingProjectRef };
}

export async function createInitialOperationsRawWriter(options) {
    if (!options || typeof options !== "object"
        || !RUN_ID.test(clean(options.runId))
        || !CHALLENGE.test(clean(options.runChallenge))
        || !GIT_SHA.test(clean(options.expectedBuild))
        || !SHA256.test(clean(options.targetHash))
        || !Number.isSafeInteger(options.maximumBytes) || options.maximumBytes < 1
        || !Number.isSafeInteger(options.maximumRecords) || options.maximumRecords < 1) {
        throw new Error("Raw evidence writer config is invalid");
    }
    const handle = await open(options.path, "wx", 0o600);
    const startedAtNs = process.hrtime.bigint();
    let bytes = 0;
    let sequence = 0;
    let closed = false;
    let closeSummary;
    const contentHash = createHash("sha256");
    let pending = Promise.resolve();
    const append = (payload) => {
        const operation = pending.then(async () => {
            if (closed) throw new Error("Raw evidence writer is closed");
            if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
                throw new Error("Raw evidence record is invalid");
            }
            for (const reserved of ["rawEnvelopeVersion", "sequence", "runId", "runChallenge", "expectedBuild", "targetHash", "writerPid", "monotonicNs"]) {
                if (Object.hasOwn(payload, reserved)) throw new Error("Raw evidence record overrides provenance");
            }
            const nextSequence = sequence + 1;
            const record = {
                rawEnvelopeVersion: 1,
                sequence: nextSequence,
                runId: options.runId,
                runChallenge: options.runChallenge,
                expectedBuild: options.expectedBuild,
                targetHash: options.targetHash,
                writerPid: process.pid,
                monotonicNs: Number(process.hrtime.bigint() - startedAtNs),
                ...payload,
            };
            const line = `${JSON.stringify(record)}\n`;
            const lineBytes = Buffer.byteLength(line);
            if (nextSequence > options.maximumRecords || bytes + lineBytes > options.maximumBytes) {
                throw new Error("Raw evidence writer bounded limit exceeded");
            }
            await handle.write(line, null, "utf8");
            contentHash.update(line);
            sequence = nextSequence;
            bytes += lineBytes;
            return record;
        });
        pending = operation.catch(() => undefined);
        return operation;
    };
    const close = async () => {
        await pending;
        if (!closed) {
            closed = true;
            await handle.sync();
            await handle.close();
            closeSummary = { bytes, records: sequence, sha256: contentHash.digest("hex") };
        }
        return closeSummary;
    };
    return Object.freeze({ append, close });
}

export function buildInitialOperationsExecutionPlan(runId) {
    const workload = buildInitialOperationsWorkload(runId);
    const roleFor = (operation) => operation === "student-read"
        ? "student"
        : operation === "teacher-live-read" ? "teacher-poller" : "teacher-uploader";
    const vus = workload.steady.map((actor, index) => Object.freeze({
        vuId: actor.vuId,
        actorId: actor.actorId,
        role: roleFor(actor.operation),
        rampOffsetMs: Math.floor(index / INITIAL_OPERATIONS_GATE.rampUsersPerSecond) * 1_000,
    }));
    const steady = workload.steady.map((actor) => Object.freeze({
        ...actor,
        offsetMs: 1_000,
    }));
    const students = vus.filter((vu) => vu.role === "student");
    const pollers = vus.filter((vu) => vu.role === "teacher-poller");
    for (const student of students) {
        for (let tick = 1; tick <= 35; tick += 1) {
            steady.push(Object.freeze({
                operation: "checkpoint",
                vuId: student.vuId,
                actorId: student.actorId,
                offsetMs: tick * INITIAL_OPERATIONS_GATE.checkpointIntervalMs,
                revision: tick,
                requestId: `${runId}:checkpoint:${student.actorId}:${tick}`,
            }));
        }
        for (let tick = 1; tick <= 11; tick += 1) {
            steady.push(Object.freeze({
                operation: "heartbeat",
                vuId: student.vuId,
                actorId: student.actorId,
                offsetMs: tick * INITIAL_OPERATIONS_GATE.heartbeatIntervalMs,
                requestId: `${runId}:heartbeat:${student.actorId}:${tick}`,
            }));
        }
    }
    for (const poller of pollers) {
        for (let tick = 2; tick <= 59; tick += 1) {
            steady.push(Object.freeze({
                operation: "teacher-live-read",
                vuId: poller.vuId,
                actorId: poller.actorId,
                offsetMs: tick * INITIAL_OPERATIONS_GATE.teacherPollIntervalMs,
                requestId: `${runId}:teacher-live-read:${poller.actorId}:${tick}`,
            }));
        }
    }
    return Object.freeze({
        fixture: workload.fixture,
        vus: Object.freeze(vus),
        steady: Object.freeze(steady),
        submissionPrimary: workload.submissions,
        submissionReplay: workload.submissionReplays,
        uploads: workload.uploads,
        steadyDurationMs: INITIAL_OPERATIONS_GATE.steadyDurationMs,
        cooldownDurationMs: INITIAL_OPERATIONS_GATE.cooldownDurationMs,
    });
}

function boundedPositiveInteger(value, fallback, maximum) {
    const normalized = Number.isSafeInteger(value) && value > 0 ? value : fallback;
    return Math.min(normalized, maximum);
}

async function readBoundedResponse(response, maximumBytes) {
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) throw new Error("Control-plane response is not JSON");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > maximumBytes)) {
        throw new Error("Control-plane response exceeds bounded limit");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Control-plane response body is missing");
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maximumBytes) throw new Error("Control-plane response exceeds bounded limit");
            chunks.push(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes);
    let body;
    try {
        body = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    } catch {
        throw new Error("Control-plane response JSON is invalid");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Control-plane response JSON is invalid");
    }
    return { body, bytes };
}

export function createInitialOperationsControlPlane(config, overrides = {}) {
    const target = assertInitialOperationsDriverConfig(config);
    const fetchImpl = overrides.fetchImpl ?? fetch;
    const requestControl = async (path, method, requestId, body) => {
        const url = new URL(path, `${target.baseUrl}/`);
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), boundedPositiveInteger(
            overrides.timeoutMs,
            15_000,
            120_000,
        ));
        let response;
        try {
            response = await fetchImpl(url, {
                method,
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${config.loadToken}`,
                    "cache-control": "no-store",
                    ...(method === "POST" ? { "content-type": "application/json" } : {}),
                    "x-omr-run-id": config.runId,
                    "x-omr-run-challenge": config.runChallenge,
                    "x-omr-expected-build": config.expectedBuild,
                    "x-omr-request-id": requestId,
                    "x-omr-actor-id": `control_${sha256(config.runId).slice(0, 16)}`,
                },
                ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (response.redirected || response.url !== url.toString()) {
            throw new Error("Control-plane request target changed");
        }
        if (!response.headers.get("cache-control")?.toLowerCase().split(",")
            .map((value) => value.trim()).includes("no-store")
            || response.headers.get("x-omr-build") !== config.expectedBuild
            || !response.headers.get("x-omr-instance-id")) {
            throw new Error("Control-plane server provenance is invalid");
        }
        const parsed = await readBoundedResponse(response, 64 * 1024);
        if (response.status < 200 || response.status >= 300) {
            throw new Error("Control-plane lifecycle request failed");
        }
        return parsed.body;
    };
    const attest = () => requestControl(
        "/api/internal/initial-operations/contract",
        "GET",
        `${config.runId}:contract`,
    );
    const createFixture = ({ fixture }) => requestControl(
        "/api/internal/initial-operations/fixture",
        "POST",
        `${config.runId}:fixture:create`,
        { action: "create", fixture },
    );
    const cleanupFixture = ({ fixture }) => requestControl(
        "/api/internal/initial-operations/fixture",
        "POST",
        `${config.runId}:fixture:cleanup`,
        { action: "cleanup", fixture },
    );
    const requestOperation = async (input) => {
        if (!input || !OPERATIONS.has(input.operation)
            || typeof input.actorId !== "string" || !input.actorId
            || typeof input.requestId !== "string" || !input.requestId.startsWith(`${config.runId}:`)) {
            throw new Error("Control-plane operation is invalid");
        }
        const method = input.operation.includes("read") ? "GET" : "POST";
        const url = new URL(`/api/internal/initial-operations/operations/${input.operation}`, `${target.baseUrl}/`);
        if (method === "GET") {
            url.searchParams.set("actorId", input.actorId);
            if (typeof input.body?.examUpdatedAt === "string") {
                url.searchParams.set("examUpdatedAt", input.body.examUpdatedAt);
            }
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), boundedPositiveInteger(
            overrides.timeoutMs,
            15_000,
            120_000,
        ));
        let response;
        try {
            response = await fetchImpl(url, {
                method,
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${config.loadToken}`,
                    "cache-control": "no-store",
                    "content-type": "application/json",
                    "x-omr-run-id": config.runId,
                    "x-omr-run-challenge": config.runChallenge,
                    "x-omr-expected-build": config.expectedBuild,
                    "x-omr-request-id": input.requestId,
                    "x-omr-actor-id": input.actorId,
                },
                ...(method === "POST" ? { body: JSON.stringify(input.body ?? {}) } : {}),
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                signal: controller.signal,
            });
            if (response.redirected || response.url !== url.toString()) {
                throw new Error("Control-plane request target changed");
            }
            if (!response.headers.get("cache-control")?.toLowerCase().split(",")
                .map((value) => value.trim()).includes("no-store")) {
                throw new Error("Control-plane response is cacheable");
            }
            const responseBuild = response.headers.get("x-omr-build") ?? "";
            const serverInstanceId = response.headers.get("x-omr-instance-id") ?? "";
            const serverDurationMs = Number(response.headers.get("x-omr-server-duration-ms"));
            const rssBytes = Number(response.headers.get("x-omr-rss-bytes"));
            const rssCapturedAtMs = Number(response.headers.get("x-omr-rss-captured-at-ms"));
            if (responseBuild !== config.expectedBuild || !serverInstanceId
                || !Number.isFinite(serverDurationMs) || serverDurationMs < 0
                || !Number.isSafeInteger(rssBytes) || rssBytes < 1
                || !Number.isSafeInteger(rssCapturedAtMs) || rssCapturedAtMs < 1) {
                throw new Error("Control-plane server provenance is invalid");
            }
            const parsed = await readBoundedResponse(response, boundedPositiveInteger(
                overrides.maximumResponseBytes,
                5 * 1024 * 1024 - 1,
                5 * 1024 * 1024 - 1,
            ));
            return {
                statusCode: response.status,
                responseBuild,
                serverInstanceId,
                serverDurationMs,
                rssBytes,
                rssCapturedAtMs,
                responseBytes: parsed.bytes,
                body: parsed.body,
            };
        } finally {
            clearTimeout(timer);
        }
    };
    return Object.freeze({ attest, createFixture, cleanupFixture, requestOperation });
}

function assertStorageUrl(value, stagingOrigin, productionOrigin) {
    let url;
    try {
        url = new URL(value);
    } catch {
        throw new Error("Storage target is invalid");
    }
    if (url.protocol !== "https:" || url.username || url.password || url.hash
        || url.origin !== stagingOrigin || url.origin === productionOrigin) {
        throw new Error("Storage target must be isolated from production");
    }
    return url;
}

function deterministicChunk(seed, counter, emitted, length) {
    const digest = createHash("sha256").update(seed).update(":").update(String(counter)).digest();
    const chunk = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < length; offset += digest.length) {
        digest.copy(chunk, offset, 0, Math.min(digest.length, length - offset));
    }
    if (emitted === 0) Buffer.from("%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n", "binary").copy(chunk, 0);
    return chunk;
}

function deterministicChunks(seed, totalBytes) {
    return async function* chunks(onChunk) {
        let emitted = 0;
        let counter = 0;
        while (emitted < totalBytes) {
            const length = Math.min(64 * 1024, totalBytes - emitted);
            const chunk = deterministicChunk(seed, counter, emitted, length);
            onChunk(chunk);
            yield chunk;
            emitted += length;
            counter += 1;
        }
    };
}

const TUS_CHUNK_BYTES = 6 * 1024 * 1024;

function tusEndpointFromSignedUploadUrl(signedUrl) {
    const url = new URL(signedUrl);
    if (url.hostname.endsWith(".supabase.co") && !url.hostname.endsWith(".storage.supabase.co")) {
        const projectRef = url.hostname.slice(0, -".supabase.co".length);
        url.hostname = `${projectRef}.storage.supabase.co`;
    }
    url.pathname = "/storage/v1/upload/resumable";
    url.search = "";
    url.hash = "";
    return url;
}

function tusMetadata(input) {
    const metadata = {
        sha256Hex: input.expectedSha256,
        uploadId: input.uploadId,
    };
    const values = {
        bucketName: input.bucket,
        objectName: input.objectPath,
        contentType: input.mimeType,
        cacheControl: "300",
        metadata: JSON.stringify(metadata),
    };
    return Object.entries(values)
        .map(([key, value]) => `${key} ${Buffer.from(value, "utf8").toString("base64")}`)
        .join(",");
}

async function* deterministicTusChunks(seed, totalBytes) {
    let emitted = 0;
    let counter = 0;
    while (emitted < totalBytes) {
        const chunkBytes = Math.min(TUS_CHUNK_BYTES, totalBytes - emitted);
        const parts = [];
        let buffered = 0;
        while (buffered < chunkBytes) {
            const length = Math.min(64 * 1024, chunkBytes - buffered);
            parts.push(deterministicChunk(seed, counter, emitted + buffered, length));
            buffered += length;
            counter += 1;
        }
        emitted += chunkBytes;
        yield Buffer.concat(parts, chunkBytes);
    }
}

function responseUrlIsExact(response, url) {
    return !response.redirected && response.url === url.toString();
}

async function uploadDeterministicTusObject(input, fetchImpl) {
    const endpoint = tusEndpointFromSignedUploadUrl(input.uploadUrl);
    const chunks = deterministicTusChunks(input.seed, input.expectedBytes);
    const first = await chunks.next();
    if (first.done) throw new Error("TUS upload body is empty");
    const commonHeaders = {
        "Tus-Resumable": "1.0.0",
        "x-signature": input.token,
    };
    const created = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
            ...commonHeaders,
            "Upload-Length": String(input.expectedBytes),
            "Upload-Metadata": tusMetadata(input),
            "Content-Type": "application/offset+octet-stream",
        },
        body: first.value,
        duplex: "half",
        credentials: "omit",
        redirect: "error",
    });
    const location = created.headers.get("location");
    let offset = Number(created.headers.get("upload-offset"));
    if (!responseUrlIsExact(created, endpoint) || created.status !== 201 || !location
        || !Number.isSafeInteger(offset) || offset !== first.value.byteLength) {
        throw new Error("TUS staging upload creation failed");
    }
    const uploadUrl = new URL(location, endpoint);
    if (uploadUrl.origin !== endpoint.origin
        || !uploadUrl.pathname.startsWith("/storage/v1/upload/resumable/")
        || uploadUrl.username || uploadUrl.password || uploadUrl.hash) {
        throw new Error("TUS staging upload location is invalid");
    }
    for await (const chunk of chunks) {
        const patched = await fetchImpl(uploadUrl, {
            method: "PATCH",
            headers: {
                ...commonHeaders,
                "Upload-Offset": String(offset),
                "Content-Type": "application/offset+octet-stream",
            },
            body: chunk,
            duplex: "half",
            credentials: "omit",
            redirect: "error",
        });
        const nextOffset = Number(patched.headers.get("upload-offset"));
        if (!responseUrlIsExact(patched, uploadUrl) || patched.status !== 204
            || !Number.isSafeInteger(nextOffset) || nextOffset !== offset + chunk.byteLength) {
            throw new Error("TUS staging upload chunk failed");
        }
        offset = nextOffset;
    }
    if (offset !== input.expectedBytes) throw new Error("TUS staging upload is incomplete");
}

export function initialOperationsStorageObjectSha256(seed, totalBytes) {
    if (typeof seed !== "string" || !seed || !Number.isSafeInteger(totalBytes)
        || totalBytes < 1 || totalBytes > INITIAL_OPERATIONS_GATE.maxPdfBytes) {
        throw new Error("Storage object hash contract is invalid");
    }
    const hash = createHash("sha256");
    let emitted = 0;
    let counter = 0;
    while (emitted < totalBytes) {
        const length = Math.min(64 * 1024, totalBytes - emitted);
        hash.update(deterministicChunk(seed, counter, emitted, length));
        emitted += length;
        counter += 1;
    }
    return hash.digest("hex");
}

export async function transferInitialOperationsStorageObject(input, overrides = {}) {
    const stagingOrigin = strictOrigin(input?.stagingStorageOrigin, "Staging storage target", ".supabase.co");
    const productionOrigin = strictOrigin(input?.productionStorageOrigin, "Production storage target", ".supabase.co");
    const uploadUrl = assertStorageUrl(input.uploadUrl, stagingOrigin, productionOrigin);
    let readbackUrl = input.readbackUrl
        ? assertStorageUrl(input.readbackUrl, stagingOrigin, productionOrigin)
        : null;
    const expectedBytes = input.expectedBytes;
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1
        || expectedBytes > INITIAL_OPERATIONS_GATE.maxPdfBytes || typeof input.seed !== "string" || !input.seed) {
        throw new Error("Storage transfer contract is invalid");
    }
    const fetchImpl = overrides.fetchImpl ?? fetch;
    const expectedSha256 = initialOperationsStorageObjectSha256(input.seed, expectedBytes);
    if (input.expectedSha256 && input.expectedSha256 !== expectedSha256) {
        throw new Error("Storage upload hash declaration differs");
    }
    if ((input.mode ?? "standard") === "tus") {
        if (!input.token || input.bucket !== "omr-private-assets" || !input.objectPath
            || input.mimeType !== "application/pdf" || !input.uploadId) {
            throw new Error("TUS upload contract is invalid");
        }
        await uploadDeterministicTusObject({
            ...input,
            uploadUrl: uploadUrl.toString(),
            expectedSha256,
        }, fetchImpl);
    } else {
        const expectedHash = createHash("sha256");
        const chunks = deterministicChunks(input.seed, expectedBytes);
        const uploadResponse = await fetchImpl(uploadUrl, {
            method: "PUT",
            headers: {
                "content-type": "application/pdf",
                "content-length": String(expectedBytes),
            },
            body: chunks((chunk) => expectedHash.update(chunk)),
            duplex: "half",
            credentials: "omit",
            redirect: "error",
        });
        if (!responseUrlIsExact(uploadResponse, uploadUrl)
            || uploadResponse.status < 200 || uploadResponse.status >= 300
            || expectedHash.digest("hex") !== expectedSha256) {
            throw new Error("Direct staging storage upload failed");
        }
    }
    if (typeof overrides.beforeReadback === "function") {
        const finalized = await overrides.beforeReadback({ expectedBytes, expectedSha256 });
        if (finalized?.readbackUrl) {
            readbackUrl = assertStorageUrl(finalized.readbackUrl, stagingOrigin, productionOrigin);
        }
    }
    if (!readbackUrl) throw new Error("Full staging storage readback URL is missing");
    const readbackResponse = await fetchImpl(readbackUrl, {
        method: "GET",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
    });
    if (readbackResponse.redirected || readbackResponse.url !== readbackUrl.toString()
        || readbackResponse.status < 200 || readbackResponse.status >= 300) {
        throw new Error("Full staging storage readback failed");
    }
    const declared = readbackResponse.headers.get("content-length");
    if (declared !== null && declared !== String(expectedBytes)) {
        throw new Error("Full staging storage readback size differs");
    }
    const reader = readbackResponse.body?.getReader();
    if (!reader) throw new Error("Full staging storage readback body is missing");
    const readbackHash = createHash("sha256");
    let observedBytes = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            observedBytes += part.value.byteLength;
            if (observedBytes > expectedBytes) throw new Error("Full staging storage readback exceeds expected size");
            readbackHash.update(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    const readbackSha256 = readbackHash.digest("hex");
    if (observedBytes !== expectedBytes || readbackSha256 !== expectedSha256) {
        throw new Error("Full staging storage readback hash differs");
    }
    return { expectedBytes, observedBytes, expectedSha256, readbackSha256 };
}

function collectorContractIsComplete(collectors) {
    return collectors && typeof collectors === "object"
        && [collectors.database, collectors.rss].every((collector) => collector
            && typeof collector.start === "function" && typeof collector.stop === "function");
}

function attestationMatches(actual, expected) {
    return actual && typeof actual === "object"
        && actual.environment === expected.environment
        && actual.appOrigin === expected.appOrigin
        && actual.storageOrigin === expected.storageOrigin
        && actual.databaseProjectRefHash === expected.databaseProjectRefHash
        && actual.controlPlaneVersion === expected.controlPlaneVersion
        && stableJson(actual.productionWorkloadPaths) === stableJson(expected.productionWorkloadPaths);
}

function cleanupIsEmpty(result) {
    return result?.status === "cleaned" && result.remaining && typeof result.remaining === "object"
        && ["sessions", "attempts", "assets", "objects"].every((key) => result.remaining[key] === 0);
}

export async function runInitialOperationsStagingLoad(config, overrides = {}) {
    const target = assertInitialOperationsDriverConfig(config);
    const targetHash = sha256([
        target.baseUrl,
        target.stagingSupabaseUrl,
        config.externalState.databaseProjectRefHash,
        config.expectedBuild,
    ].join("\n"));
    const writer = await createInitialOperationsRawWriter({
        path: join(config.outputDirectory, "driver.ndjson"),
        maximumBytes: 32 * 1024 * 1024,
        maximumRecords: 20_000,
        runId: config.runId,
        runChallenge: config.runChallenge,
        expectedBuild: config.expectedBuild,
        targetHash,
    });
    if (!collectorContractIsComplete(overrides.collectors)) {
        await writer.append({ kind: "lifecycle", event: "unverified", code: "missing_external_collectors" });
        await writer.close();
        return { status: "unverified", code: "missing_external_collectors", cleanupVerified: false };
    }
    const storageWriter = await createInitialOperationsRawWriter({
        path: join(config.outputDirectory, "storage.ndjson"),
        maximumBytes: 2 * 1024 * 1024,
        maximumRecords: 100,
        runId: config.runId,
        runChallenge: config.runChallenge,
        expectedBuild: config.expectedBuild,
        targetHash,
    });

    const controlPlane = overrides.controlPlane ?? createInitialOperationsControlPlane(config, overrides);
    const plan = buildInitialOperationsExecutionPlan(config.runId);
    let fixtureCreated = false;
    let databaseStarted = false;
    let rssStarted = false;
    let failureCode = "";
    let cleanupVerified = false;
    let databaseEvidence = [];
    let rssEvidence = [];
    let workloadRequestRecords = [];
    try {
        const attestation = await controlPlane.attest();
        if (!attestationMatches(attestation, config.externalState)) {
            failureCode = "external_state_unverified";
            throw new Error("External state attestation differs");
        }
        await writer.append({ kind: "lifecycle", event: "external-state-attested" });
        const created = await controlPlane.createFixture({ fixture: plan.fixture });
        fixtureCreated = created?.status === "created";
        if (!fixtureCreated || created.organizationId !== plan.fixture.organizationId
            || created.examId !== plan.fixture.examId) {
            failureCode = "fixture_create_unverified";
            throw new Error("Fixture create response differs");
        }
        const fixtureExamUpdatedAt = typeof created.examUpdatedAt === "string"
            && Number.isFinite(Date.parse(created.examUpdatedAt))
            ? created.examUpdatedAt
            : "";
        if (!fixtureExamUpdatedAt) {
            failureCode = "fixture_create_unverified";
            throw new Error("Fixture exam revision is invalid");
        }
        const fixtureTeacherIdentity = normalizeInitialOperationsTeacherIdentity(
            created.teacherIdentity,
            plan.fixture,
        );
        if (!fixtureTeacherIdentity) {
            failureCode = "fixture_create_unverified";
            throw new Error("Fixture teacher identity is invalid");
        }
        await writer.append({ kind: "lifecycle", event: "fixture-created", ...plan.fixture });
        await overrides.collectors.database.start({ config, plan });
        databaseStarted = true;
        await overrides.collectors.rss.start({ config, plan });
        rssStarted = true;
        const executeWorkload = overrides.executeWorkload ?? executeInitialOperationsWorkload;
        const workload = await executeWorkload({
            config,
            plan,
            controlPlane,
            writer,
            overrides: { ...overrides, storageWriter, fixtureExamUpdatedAt, fixtureTeacherIdentity },
        });
        workloadRequestRecords = Array.isArray(workload?.requestRecords) ? workload.requestRecords : [];
    } catch {
        if (!failureCode) failureCode = "load_execution_failed";
    } finally {
        if (rssStarted) {
            try {
                const probeRssEvidence = await overrides.collectors.rss.stop({ config, plan });
                rssEvidence = buildInPathRssEvidence(
                    config.runId,
                    config.expectedBuild,
                    workloadRequestRecords,
                    probeRssEvidence,
                );
            } catch {
                failureCode = "rss_collection_failed";
            }
        }
        if (databaseStarted) {
            try {
                databaseEvidence = await overrides.collectors.database.stop({ config, plan });
            } catch {
                failureCode = "database_collection_failed";
            }
        }
        if (fixtureCreated) {
            try {
                cleanupVerified = cleanupIsEmpty(await controlPlane.cleanupFixture({ fixture: plan.fixture }));
                if (cleanupVerified) {
                    await writer.append({ kind: "lifecycle", event: "cleanup-verified", ...plan.fixture });
                } else {
                    failureCode = "cleanup_unverified";
                }
            } catch {
                failureCode = "cleanup_unverified";
            }
        }
        await storageWriter.close();
        await writer.close();
    }
    if (!failureCode && (!Array.isArray(databaseEvidence) || databaseEvidence.length === 0
        || !Array.isArray(rssEvidence) || rssEvidence.length === 0)) {
        failureCode = "collector_evidence_missing";
    }
    if (failureCode) return { status: "unverified", code: failureCode, cleanupVerified };
    return {
        status: "collected",
        code: "evaluation_required",
        cleanupVerified,
        databaseEvidence,
        rssEvidence,
    };
}

function stableJson(value) {
    if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

export async function executeInitialOperationsWorkload({ config, plan, controlPlane, writer, overrides = {} }) {
    const now = overrides.now ?? Date.now;
    const fixtureTeacherIdentity = normalizeInitialOperationsTeacherIdentity(
        overrides.fixtureTeacherIdentity,
        plan.fixture,
    );
    if (plan.uploads.length > 0 && !fixtureTeacherIdentity) {
        throw new Error("Fixture teacher identity is required for upload workload");
    }
    const controller = new AbortController();
    const pendingWaitCancellations = new Set();
    const cancelled = new Promise((resolve) => {
        controller.signal.addEventListener("abort", () => resolve(false), { once: true });
    });
    const defaultWaitUntil = async (targetMs) => {
        const remaining = targetMs - Date.now();
        if (remaining <= 0 || controller.signal.aborted) return;
        await new Promise((resolve) => {
            let timer;
            const finish = () => {
                clearTimeout(timer);
                pendingWaitCancellations.delete(finish);
                resolve();
            };
            timer = setTimeout(finish, remaining);
            pendingWaitCancellations.add(finish);
        });
    };
    const waitUntil = overrides.waitUntil ?? defaultWaitUntil;
    const waitForSchedule = async (targetMs) => {
        if (controller.signal.aborted) return false;
        const reached = await Promise.race([
            Promise.resolve(waitUntil(targetMs, controller.signal)).then(() => true),
            cancelled,
        ]);
        return reached === true && !controller.signal.aborted;
    };
    let firstFailure;
    const tracked = (operation) => Promise.resolve().then(operation).catch((error) => {
        if (!firstFailure) firstFailure = error;
        controller.abort();
        for (const cancelWait of [...pendingWaitCancellations]) cancelWait();
        throw error;
    });
    const settleAll = async (tasks) => {
        const outcomes = await Promise.allSettled(tasks);
        const rejected = outcomes.find((outcome) => outcome.status === "rejected");
        if (rejected) throw firstFailure ?? rejected.reason;
        return outcomes.map((outcome) => outcome.value);
    };
    const rampStartedAtMs = now() + (overrides.rampLeadMs ?? 1_000);
    const finalRampOffset = Math.max(0, ...plan.vus.map((vu) => vu.rampOffsetMs));
    const steadyStartedAtMs = rampStartedAtMs + finalRampOffset + 1_000;
    const steadyEndedAtMs = steadyStartedAtMs + plan.steadyDurationMs;
    const cooldownEndedAtMs = steadyEndedAtMs + plan.cooldownDurationMs;
    const timeline = { rampStartedAtMs, steadyStartedAtMs, steadyEndedAtMs, cooldownEndedAtMs };
    await writer.append({ kind: "run", schemaVersion: 1, timeline });
    const requestRecords = [];
    const submittedActors = new Set();
    const studentSessionState = new Map();
    const runRequest = async (item, scheduledAtMs) => {
        if ((item.operation === "checkpoint" || item.operation === "heartbeat")
            && submittedActors.has(item.actorId)) return null;
        if (!await waitForSchedule(scheduledAtMs)) return null;
        if ((item.operation === "checkpoint" || item.operation === "heartbeat")
            && submittedActors.has(item.actorId)) return null;
        const startedAtMs = now();
        const result = await controlPlane.requestOperation({
            ...item,
            body: {
                fixture: plan.fixture,
                examUpdatedAt: overrides.fixtureExamUpdatedAt,
                ...(item.revision ? { revision: item.revision } : {}),
                ...(item.idempotencyKey ? { idempotencyKey: item.idempotencyKey } : {}),
                ...(["checkpoint", "heartbeat", "student-submit", "student-submit-replay"].includes(item.operation)
                    ? {
                        expectedRevision: studentSessionState.get(item.actorId)?.revision,
                        expectedLeaseEpoch: studentSessionState.get(item.actorId)?.leaseEpoch,
                    }
                    : {}),
            },
        });
        const endedAtMs = Math.max(startedAtMs, now());
        const receipt = result.body?.receipt ?? result.body;
        const record = {
            kind: "request",
            eventId: `${item.requestId}:event`,
            requestId: item.requestId,
            vuId: item.vuId,
            actorId: item.actorId,
            operation: item.operation,
            startedAtMs,
            endedAtMs,
            statusCode: result.statusCode,
            success: result.statusCode >= 200 && result.statusCode < 300,
            responseBytes: result.responseBytes,
            method: item.operation.includes("read") ? "GET" : "POST",
            routeId: item.operation,
            targetKind: "app",
            serverInstanceId: result.serverInstanceId,
            responseBuild: result.responseBuild,
            rssBytes: result.rssBytes,
            rssCapturedAtMs: result.rssCapturedAtMs,
            workloadPaths: result.body?.workloadPaths,
            ...(item.operation === "student-submit" ? { serverDurationMs: result.serverDurationMs } : {}),
            ...(item.revision ? { revision: item.revision } : {}),
            ...(result.body?.observedRevisions ? { observedRevisions: result.body.observedRevisions } : {}),
            ...(item.idempotencyKey ? {
                idempotencyKey: item.idempotencyKey,
                attemptId: result.body?.attemptId ?? result.body?.receipt?.attemptId ?? `missing-${item.actorId}`,
                receiptHash: /^[a-f0-9]{64}$/.test(result.body?.receiptHash)
                    ? result.body.receiptHash
                    : sha256(stableJson(receipt)),
            } : {}),
        };
        requestRecords.push(record);
        await writer.append(record);
        if (Number.isSafeInteger(result.body?.revision) && Number.isSafeInteger(result.body?.leaseEpoch)) {
            studentSessionState.set(item.actorId, {
                revision: result.body.revision,
                leaseEpoch: result.body.leaseEpoch,
            });
        }
        if (item.operation === "student-submit" && record.success && result.body?.status === "submitted") {
            submittedActors.add(item.actorId);
        }
        return record;
    };

    const steadyByVu = new Map(plan.vus.map((vu) => [vu.vuId, []]));
    for (const item of plan.steady) steadyByVu.get(item.vuId)?.push(item);
    for (const schedule of steadyByVu.values()) {
        schedule.sort((left, right) => left.offsetMs - right.offsetMs);
    }
    const vuTasks = plan.vus.map((vu) => tracked(async () => {
        if (!await waitForSchedule(rampStartedAtMs + vu.rampOffsetMs)) return;
        const activeStartedAtMs = now();
        for (const item of steadyByVu.get(vu.vuId) ?? []) {
            await runRequest(item, steadyStartedAtMs + item.offsetMs);
            if (controller.signal.aborted) return;
        }
        if (!await waitForSchedule(steadyEndedAtMs)) return;
        const activeEndedAtMs = now();
        await writer.append({ kind: "vu", ...vu, activeStartedAtMs, activeEndedAtMs });
    }));
    const primaryTask = tracked(async () => {
        const offset = overrides.submissionOffsetMs ?? 63_000;
        if (!await waitForSchedule(steadyStartedAtMs + offset)) return { primary: [], replay: [] };
        const primary = await settleAll(plan.submissionPrimary.map((item) => tracked(
            () => runRequest(item, now()),
        )));
        const replay = await settleAll(plan.submissionReplay.map((item) => tracked(
            () => runRequest(item, now()),
        )));
        return { primary, replay };
    });
    const uploadTask = tracked(async () => {
        if (plan.uploads.length === 0) return [];
        if (!await waitForSchedule(steadyStartedAtMs + (overrides.uploadOffsetMs ?? 90_000))) return [];
        return settleAll(plan.uploads.map((item) => tracked(async () => {
            const startedAtMs = now();
            const declaredSha256 = initialOperationsStorageObjectSha256(item.idempotencyKey, item.byteSize);
            const prepare = await controlPlane.requestOperation({
                ...item,
                operation: "teacher-max-pdf-upload-prepare",
                requestId: `${item.requestId}:prepare`,
                body: {
                    fixture: plan.fixture,
                    teacherIdentity: fixtureTeacherIdentity,
                    byteSize: item.byteSize,
                    sha256Hex: declaredSha256,
                    idempotencyKey: item.idempotencyKey,
                },
            });
            if (prepare.body?.status !== "prepared" || typeof prepare.body.uploadUrl !== "string"
                || typeof prepare.body.objectPath !== "string"
                || prepare.body.mode !== (item.byteSize > 6 * 1024 * 1024 ? "tus" : "standard")
                || typeof prepare.body.token !== "string"
                || prepare.body.bucket !== "omr-private-assets" || prepare.body.mimeType !== "application/pdf"
                || typeof prepare.body.uploadId !== "string") {
                throw new Error("Storage prepare evidence is invalid");
            }
            let finalize;
            const transfer = await transferInitialOperationsStorageObject({
                uploadUrl: prepare.body.uploadUrl,
                stagingStorageOrigin: config.stagingSupabaseUrl,
                productionStorageOrigin: config.productionSupabaseUrl,
                expectedBytes: item.byteSize,
                expectedSha256: declaredSha256,
                seed: item.idempotencyKey,
                mode: prepare.body.mode,
                token: prepare.body.token,
                bucket: prepare.body.bucket,
                objectPath: prepare.body.objectPath,
                mimeType: prepare.body.mimeType,
                uploadId: prepare.body.uploadId,
            }, {
                fetchImpl: overrides.fetchImpl,
                beforeReadback: async ({ expectedBytes, expectedSha256 }) => {
                    finalize = await controlPlane.requestOperation({
                        ...item,
                        operation: "teacher-max-pdf-upload-finalize",
                        requestId: `${item.requestId}:finalize`,
                        body: {
                            fixture: plan.fixture,
                            teacherIdentity: fixtureTeacherIdentity,
                            objectPath: prepare.body.objectPath,
                            expectedBytes,
                            expectedSha256,
                            idempotencyKey: item.idempotencyKey,
                        },
                    });
                    if (finalize.body?.status !== "finalized") throw new Error("Storage finalize evidence is invalid");
                    if (expectedSha256 !== declaredSha256) throw new Error("Storage upload hash differs from declaration");
                    return { readbackUrl: finalize.body.readbackUrl };
                },
            });
            const endedAtMs = now();
            const record = {
                kind: "request",
                eventId: `${item.requestId}:event`,
                requestId: item.requestId,
                vuId: item.vuId,
                actorId: item.actorId,
                operation: "teacher-max-pdf-upload",
                startedAtMs,
                endedAtMs,
                statusCode: finalize.statusCode,
                success: true,
                responseBytes: finalize.responseBytes,
                method: "PUT",
                routeId: "teacher-max-pdf-upload",
                targetKind: "storage",
                serverInstanceId: finalize.serverInstanceId,
                responseBuild: finalize.responseBuild,
                rssBytes: finalize.rssBytes,
                rssCapturedAtMs: finalize.rssCapturedAtMs,
                workloadPaths: [
                    ...(Array.isArray(prepare.body?.workloadPaths) ? prepare.body.workloadPaths : []),
                    ...(Array.isArray(finalize.body?.workloadPaths) ? finalize.body.workloadPaths : []),
                ],
                upload: {
                    declaredBytes: item.byteSize,
                    storedBytes: transfer.observedBytes,
                    directToStorage: true,
                    contentSha256: transfer.expectedSha256,
                    objectPath: prepare.body.objectPath,
                    finalized: true,
                },
            };
            requestRecords.push(record);
            await writer.append(record);
            await overrides.storageWriter?.append({
                kind: "storage",
                actorId: item.actorId,
                requestEventId: record.eventId,
                objectPath: prepare.body.objectPath,
                expectedBytes: item.byteSize,
                observedBytes: transfer.observedBytes,
                expectedSha256: transfer.expectedSha256,
                readbackSha256: transfer.readbackSha256,
                finalized: true,
            });
            return record;
        })));
    });

    await settleAll([...vuTasks, primaryTask, uploadTask]);
    const firstCheckpointByActor = firstCheckpointRecordsByActor(requestRecords);
    const teacherReads = requestRecords.filter((record) => record.operation === "teacher-live-read")
        .sort((left, right) => left.startedAtMs - right.startedAtMs);
    for (const source of firstCheckpointByActor.values()) {
        const observed = teacherReads.find((candidate) => candidate.startedAtMs >= source.endedAtMs
            && candidate.observedRevisions?.[source.actorId] >= source.revision);
        if (observed) {
            await writer.append({
                kind: "livePropagation",
                sourceEventId: source.eventId,
                observedEventId: observed.eventId,
            });
        }
    }
    await waitForSchedule(cooldownEndedAtMs);
    return { timeline, requestRecords };
}
