import { createHash } from "node:crypto";
import { isAbsolute, parse, relative, resolve, sep } from "node:path";

export const INITIAL_OPERATIONS_GATE = Object.freeze({
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
});

const GIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const FIXTURE_NAME = "initial-ops-100";

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

export function buildInitialOperationsFixtureScope(runId) {
    const normalizedRunId = clean(runId).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(normalizedRunId)) {
        throw new Error("Initial-operations run ID is invalid");
    }
    const suffix = createHash("sha256").update(normalizedRunId).digest("hex").slice(0, 16);
    return Object.freeze({
        organizationId: `teacher_${suffix}`,
        examId: `initial_ops_exam_${suffix}`,
    });
}

function setOnce(target, key, value) {
    if (Object.hasOwn(target, key)) throw new Error(`Duplicate initial-operations argument: ${key}`);
    target[key] = value;
}

function parseArgs(argv) {
    if (!Array.isArray(argv)) throw new Error("Initial-operations arguments must be an array");
    const parsed = {};
    let run = false;
    for (const argument of argv) {
        if (argument === "--run") {
            if (run) throw new Error("Duplicate initial-operations argument: run");
            run = true;
        } else if (argument.startsWith("--confirm-staging-host=")) {
            setOnce(parsed, "confirmedStagingHost", argument.slice("--confirm-staging-host=".length));
        } else if (argument.startsWith("--confirm-load-fixture=")) {
            setOnce(parsed, "confirmedFixture", argument.slice("--confirm-load-fixture=".length));
        } else if (argument.startsWith("--output=")) {
            setOnce(parsed, "outputDirectory", argument.slice("--output=".length));
        } else {
            throw new Error(`Unknown initial-operations argument: ${String(argument).slice(0, 48)}`);
        }
    }
    if (!run) throw new Error("Initial-operations run mode must be explicit");
    return { mode: "run", ...parsed };
}

function strictHttpsOrigin(value, label, requiredSuffix) {
    let url;
    try {
        url = new URL(clean(value));
    } catch {
        throw new Error(`${label} is invalid`);
    }
    if (
        url.protocol !== "https:"
        || url.username
        || url.password
        || url.port
        || url.pathname !== "/"
        || url.search
        || url.hash
        || (requiredSuffix && !url.hostname.endsWith(requiredSuffix))
    ) throw new Error(`${label} is invalid`);
    return { origin: url.origin, hostname: url.hostname.toLowerCase() };
}

function projectRefFromSupabaseHost(hostname) {
    const match = hostname.match(/^(?<ref>[a-z0-9-]+)\.supabase\.co$/);
    if (!match?.groups?.ref || !/^[a-z0-9][a-z0-9-]{2,62}$/.test(match.groups.ref)) {
        throw new Error("Supabase project URL does not contain a valid project ref");
    }
    return match.groups.ref;
}

function strongCredential(value) {
    const normalized = clean(value);
    const byteLength = Buffer.byteLength(normalized, "utf8");
    return byteLength >= 32 && byteLength <= 256 && !/\s/.test(normalized) ? normalized : "";
}

function safeOutputDirectory(value, cwd) {
    if (!isAbsolute(clean(value))) throw new Error("Initial-operations output must be an absolute path");
    const output = resolve(value);
    const repository = resolve(cwd);
    const repositoryRelative = relative(repository, output);
    if (
        output === parse(output).root
        || output === repository
        || (!repositoryRelative.startsWith(`..${sep}`) && repositoryRelative !== ".." && !isAbsolute(repositoryRelative))
    ) throw new Error("Initial-operations output must be outside the repository");
    return output;
}

export function resolveInitialOperationsConfig(input) {
    const args = parseArgs(input.argv);
    const env = input.env ?? {};
    if (clean(env.OMR_INITIAL_OPS_LOAD_ENABLED) !== "1") {
        throw new Error("Initial-operations load is not explicitly enabled");
    }
    const staging = strictHttpsOrigin(env.OMR_INITIAL_OPS_STAGING_URL, "Staging URL");
    const production = strictHttpsOrigin(env.OMR_PRODUCTION_BASE_URL, "Production URL");
    if (staging.hostname === production.hostname) throw new Error("Staging target must not be the production host");
    if (clean(args.confirmedStagingHost).toLowerCase() !== staging.hostname) {
        throw new Error("Confirmed staging host does not match the target");
    }
    if (clean(args.confirmedFixture) !== FIXTURE_NAME) {
        throw new Error("The isolated initial-operations fixture must be explicitly confirmed");
    }
    const stagingDatabase = strictHttpsOrigin(
        env.OMR_INITIAL_OPS_STAGING_SUPABASE_URL,
        "Staging database URL",
        ".supabase.co",
    );
    const productionDatabase = strictHttpsOrigin(
        env.OMR_PRODUCTION_SUPABASE_URL,
        "Production database URL",
        ".supabase.co",
    );
    const stagingProjectRef = projectRefFromSupabaseHost(stagingDatabase.hostname);
    const productionProjectRef = projectRefFromSupabaseHost(productionDatabase.hostname);
    if (stagingProjectRef === productionProjectRef) {
        throw new Error("Staging database must be isolated from the production database");
    }
    const stagingProjectRefHash = createHash("sha256")
        .update(stagingProjectRef)
        .digest("hex");
    const loadToken = strongCredential(env.OMR_INITIAL_OPS_TOKEN);
    const readinessToken = strongCredential(env.OMR_READINESS_TOKEN);
    if (!loadToken || !readinessToken || loadToken === readinessToken) {
        throw new Error("Initial-operations credentials are missing, weak, or not distinct");
    }
    const expectedBuild = clean(env.OMR_INITIAL_OPS_EXPECTED_BUILD).toLowerCase();
    if (!GIT_SHA_PATTERN.test(expectedBuild)) throw new Error("Expected staging build SHA is missing or invalid");
    const config = {
        mode: args.mode,
        baseUrl: staging.origin,
        productionBaseUrl: production.origin,
        stagingSupabaseUrl: stagingDatabase.origin,
        productionSupabaseUrl: productionDatabase.origin,
        stagingProjectRefHash,
        expectedBuild,
        outputDirectory: safeOutputDirectory(args.outputDirectory, input.cwd),
        fixture: FIXTURE_NAME,
    };
    Object.defineProperties(config, {
        loadToken: { value: loadToken, enumerable: false, writable: false },
        readinessToken: { value: readinessToken, enumerable: false, writable: false },
    });
    return Object.freeze(config);
}

function plainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validSha(value) {
    return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validIdentifier(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function validNonnegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function percentile(samples, quantile) {
    if (!Array.isArray(samples) || samples.length === 0) return Number.NaN;
    const sorted = [...samples].sort((left, right) => left - right);
    return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

const REQUIRED_SCENARIOS = Object.freeze({
    "student-read": 80,
    "teacher-live-read": 590,
    "teacher-upload-read": 10,
    checkpoint: 880,
    heartbeat: 240,
    "student-submit": 80,
    "student-submit-replay": 80,
    "teacher-max-pdf-upload": 10,
});

const EXACT_SCENARIOS = Object.freeze({
    "student-read": 80,
    "teacher-upload-read": 10,
    "student-submit": 80,
    "student-submit-replay": 80,
    "teacher-max-pdf-upload": 10,
});

const SCENARIO_ROLES = Object.freeze({
    "student-read": "student",
    checkpoint: "student",
    heartbeat: "student",
    "student-submit": "student",
    "student-submit-replay": "student",
    "teacher-live-read": "teacher-poller",
    "teacher-upload-read": "teacher-uploader",
    "teacher-max-pdf-upload": "teacher-uploader",
});

export const INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS = Object.freeze({
    "student-read": Object.freeze(["rpc:omr_open_attempt_session_v1"]),
    checkpoint: Object.freeze(["rpc:omr_checkpoint_attempt_session_v1"]),
    heartbeat: Object.freeze(["rpc:omr_heartbeat_attempt_session_v1"]),
    "teacher-live-read": Object.freeze(["rpc:omr_list_active_attempt_sessions_v1"]),
    "teacher-upload-read": Object.freeze(["table:omr_remote_assets"]),
    "student-submit": Object.freeze([
        "rpc:omr_prepare_attempt_session_submit_v1",
        "rpc:omr_commit_attempt_session_submit_v1",
    ]),
    "student-submit-replay": Object.freeze([
        "rpc:omr_prepare_attempt_session_submit_v1",
        "rpc:omr_commit_attempt_session_submit_v1",
    ]),
    "teacher-max-pdf-upload": Object.freeze([
        "rpc:omr_prepare_teacher_asset_upload_v1",
        "rpc:omr_authorize_teacher_asset_finalize_v1",
        "rpc:omr_finalize_teacher_asset_upload_v1",
    ]),
});

const REQUIRED_DATABASE_WORKLOAD_PATHS = Object.freeze([
    ...new Set(Object.values(INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS).flat()),
]);

function evidenceIsComplete(evidence) {
    if (!plainObject(evidence) || evidence.schemaVersion !== INITIAL_OPERATIONS_GATE.schemaVersion) return false;
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(clean(evidence.runId))) return false;
    if (!plainObject(evidence.target) || !plainObject(evidence.probes) || !plainObject(evidence.timeline)) return false;
    if (!plainObject(evidence.probes.health)
        || !plainObject(evidence.probes.readinessUnauthorized)
        || !plainObject(evidence.probes.readiness)
        || !plainObject(evidence.probes.securityHeaders)
        || !plainObject(evidence.probes.staticAssetCompression)) return false;
    const preflightObservedAtMs = Date.parse(evidence.probes.observedAt);
    const healthTimestampMs = Date.parse(evidence.probes.health.timestamp);
    if (!Number.isFinite(preflightObservedAtMs) || !Number.isFinite(healthTimestampMs)
        || Math.abs(preflightObservedAtMs - healthTimestampMs) > 5 * 60 * 1_000) return false;
    const timelineValues = [
        evidence.timeline.rampStartedAtMs,
        evidence.timeline.steadyStartedAtMs,
        evidence.timeline.steadyEndedAtMs,
        evidence.timeline.cooldownEndedAtMs,
    ];
    if (!timelineValues.every(validNonnegativeInteger)
        || !(timelineValues[0] < timelineValues[1]
            && timelineValues[1] < timelineValues[2]
            && timelineValues[2] < timelineValues[3])) return false;
    if (!Array.isArray(evidence.vus) || !Array.isArray(evidence.requests) || !Array.isArray(evidence.storage)
        || !Array.isArray(evidence.livePropagation) || !plainObject(evidence.database)
        || !plainObject(evidence.memory)) return false;
    const vuIds = new Set();
    const actorIds = new Set();
    for (const vu of evidence.vus) {
        if (!plainObject(vu) || !validIdentifier(vu.vuId) || !validIdentifier(vu.actorId)
            || !["student", "teacher-poller", "teacher-uploader"].includes(vu.role)
            || !validNonnegativeInteger(vu.activeStartedAtMs)
            || !validNonnegativeInteger(vu.activeEndedAtMs)
            || vu.activeEndedAtMs < vu.activeStartedAtMs
            || vuIds.has(vu.vuId)
            || actorIds.has(vu.actorId)) return false;
        vuIds.add(vu.vuId);
        actorIds.add(vu.actorId);
    }
    const eventIds = new Set();
    const requestIds = new Set();
    for (const request of evidence.requests) {
        if (!plainObject(request)
            || !validIdentifier(request.eventId)
            || !validIdentifier(request.requestId)
            || request.runId !== evidence.runId
            || !validIdentifier(request.vuId)
            || !validIdentifier(request.actorId)
            || !Object.hasOwn(REQUIRED_SCENARIOS, request.operation)
            || !validNonnegativeInteger(request.startedAtMs)
            || !validNonnegativeInteger(request.endedAtMs)
            || request.endedAtMs < request.startedAtMs
            || !Number.isSafeInteger(request.statusCode)
            || request.statusCode < 100
            || request.statusCode > 599
            || typeof request.success !== "boolean"
            || !Array.isArray(request.workloadPaths)
            || request.workloadPaths.some(path => !validIdentifier(path))
            || !validNonnegativeInteger(request.responseBytes)
            || !["GET", "POST", "PUT"].includes(request.method)
            || request.routeId !== request.operation
            || request.targetKind !== (request.operation === "teacher-max-pdf-upload" ? "storage" : "app")
            || !validIdentifier(request.serverInstanceId)
            || !GIT_SHA_PATTERN.test(request.responseBuild)
            || !request.eventId.startsWith(`${evidence.runId}:`)
            || !request.requestId.startsWith(`${evidence.runId}:`)
            || eventIds.has(request.eventId)
            || requestIds.has(request.requestId)) return false;
        if (request.serverDurationMs !== undefined
            && (!Number.isFinite(request.serverDurationMs) || request.serverDurationMs < 0)) return false;
        if (request.operation === "student-submit"
            && (!Number.isFinite(request.serverDurationMs)
                || request.serverDurationMs < 0
                || request.serverDurationMs > request.endedAtMs - request.startedAtMs)) return false;
        if (request.operation === "checkpoint"
            && (!Number.isSafeInteger(request.revision) || request.revision < 1)) return false;
        if (request.operation === "teacher-live-read"
            && (!plainObject(request.observedRevisions)
                || Object.values(request.observedRevisions).some((revision) => !validNonnegativeInteger(revision)))) return false;
        eventIds.add(request.eventId);
        requestIds.add(request.requestId);
    }
    if (!Array.isArray(evidence.database.rows) || evidence.database.rows.length === 0
        || !Array.isArray(evidence.database.attemptInventory)
        || evidence.database.runId !== evidence.runId
        || !validSha(evidence.database.databaseProjectRefHash)
        || !validNonnegativeInteger(evidence.database.statsResetAtMs)
        || !plainObject(evidence.database.countersBefore) || !plainObject(evidence.database.countersAfter)
        || !validNonnegativeInteger(evidence.database.windowStartedAtMs)
        || !validNonnegativeInteger(evidence.database.windowEndedAtMs)
        || evidence.database.rows.some((row) => !plainObject(row)
            || !validIdentifier(row.workloadPath)
            || !validIdentifier(row.fingerprint)
            || !validNonnegativeInteger(row.callsBefore)
            || !validNonnegativeInteger(row.callsAfter)
            || !validNonnegativeInteger(row.callsDelta)
            || row.callsAfter < row.callsBefore
            || row.callsDelta !== row.callsAfter - row.callsBefore
            || !Number.isFinite(row.maximumExecutionMs)
            || row.maximumExecutionMs < 0)) return false;
    if (evidence.database.attemptInventory.some((attempt) => !plainObject(attempt)
        || !validIdentifier(attempt.idempotencyKey)
        || !validIdentifier(attempt.attemptId)
        || !validSha(attempt.receiptHash))) return false;
    for (const counters of [evidence.database.countersBefore, evidence.database.countersAfter]) {
        if (!validNonnegativeInteger(counters.deadlocks) || !validNonnegativeInteger(counters.lockTimeouts)) return false;
    }
    if (evidence.database.countersAfter.deadlocks < evidence.database.countersBefore.deadlocks
        || evidence.database.countersAfter.lockTimeouts < evidence.database.countersBefore.lockTimeouts) return false;
    if (evidence.memory.source !== "server" || !Array.isArray(evidence.memory.samples)
        || evidence.memory.samples.length < 3
        || evidence.memory.samples.some((sample) => !plainObject(sample)
            || sample.runId !== evidence.runId
            || !validIdentifier(sample.serverInstanceId)
            || !GIT_SHA_PATTERN.test(sample.build)
            || !validNonnegativeInteger(sample.capturedAtMs)
            || !validNonnegativeInteger(sample.rssBytes))) return false;
    const memoryByInstance = new Map();
    for (const sample of evidence.memory.samples) {
        const samples = memoryByInstance.get(sample.serverInstanceId) ?? [];
        samples.push(sample);
        memoryByInstance.set(sample.serverInstanceId, samples);
    }
    for (const samples of memoryByInstance.values()) {
        samples.sort((left, right) => left.capturedAtMs - right.capturedAtMs);
        if (samples[0].capturedAtMs > timelineValues[0]
            || samples.at(-1).capturedAtMs < timelineValues[3]
            || samples.at(-1).capturedAtMs > timelineValues[3] + 10_000
            || !samples.some((sample) => sample.capturedAtMs >= timelineValues[1]
                && sample.capturedAtMs <= timelineValues[2])) return false;
        for (let index = 1; index < samples.length; index += 1) {
            if (samples[index].capturedAtMs <= samples[index - 1].capturedAtMs) return false;
        }
    }
    if (evidence.storage.some((record) => !plainObject(record)
        || record.runId !== evidence.runId
        || !validIdentifier(record.actorId)
        || !validIdentifier(record.requestEventId)
        || !validIdentifier(record.objectPath)
        || !validNonnegativeInteger(record.expectedBytes)
        || !validNonnegativeInteger(record.observedBytes)
        || !validSha(record.expectedSha256)
        || !validSha(record.readbackSha256)
        || typeof record.finalized !== "boolean")) return false;
    return evidence.livePropagation.every((sample) => plainObject(sample)
        && validIdentifier(sample.sourceEventId)
        && validIdentifier(sample.observedEventId));
}

export function evaluateInitialOperationsEvidence(evidence, expectations = {}) {
    if (!evidenceIsComplete(evidence)) {
        return {
            status: "unverified",
            failures: [{ code: "missing_evidence", message: "Hosted capacity evidence is incomplete" }],
            metrics: {},
        };
    }

    const requestsByOperation = new Map(Object.keys(REQUIRED_SCENARIOS).map((operation) => [
        operation,
        evidence.requests.filter((request) => request.operation === operation),
    ]));
    const latency = (operation) => requestsByOperation.get(operation).map((request) => request.endedAtMs - request.startedAtMs);
    const studentReadP95Ms = percentile(latency("student-read"), 0.95);
    const teacherLiveReadP95Ms = percentile(latency("teacher-live-read"), 0.95);
    const teacherUploadReadP95Ms = percentile(latency("teacher-upload-read"), 0.95);
    const submitRequests = requestsByOperation.get("student-submit");
    const memorySamplesByInstance = new Map();
    for (const sample of evidence.memory.samples) {
        const samples = memorySamplesByInstance.get(sample.serverInstanceId) ?? [];
        samples.push(sample);
        memorySamplesByInstance.set(sample.serverInstanceId, samples);
    }
    const memoryWindows = [...memorySamplesByInstance.entries()].map(([serverInstanceId, samples]) => {
        const ordered = [...samples].sort((left, right) => left.capturedAtMs - right.capturedAtMs);
        const baseline = ordered.filter((sample) => sample.capturedAtMs <= evidence.timeline.rampStartedAtMs).at(-1);
        const postCooldown = ordered.filter((sample) => sample.capturedAtMs >= evidence.timeline.cooldownEndedAtMs).at(-1);
        return {
            serverInstanceId,
            baseline,
            postCooldown,
            peakRssBytes: Math.max(...ordered.map((sample) => sample.rssBytes)),
        };
    });
    if (memoryWindows.some((window) => !window.baseline || !window.postCooldown)) {
        return {
            status: "unverified",
            failures: [{ code: "missing_evidence", message: "Hosted capacity evidence is incomplete" }],
            metrics: {},
        };
    }
    const peakRssBytes = Math.max(...memoryWindows.map((window) => window.peakRssBytes));
    const rssResidualBytes = Math.max(...memoryWindows.map((window) => Math.max(
        0,
        window.postCooldown.rssBytes - window.baseline.rssBytes,
    )));
    const maximumQueryMs = Math.max(...evidence.database.rows.map((row) => row.maximumExecutionMs));
    const metrics = {
        gatewayReadP95Ms: Math.max(studentReadP95Ms, teacherLiveReadP95Ms, teacherUploadReadP95Ms),
        studentReadP95Ms,
        teacherLiveReadP95Ms,
        teacherUploadReadP95Ms,
        submitRpcP95Ms: percentile(submitRequests.map((request) => request.serverDurationMs), 0.95),
        submitEndToEndP99Ms: percentile(latency("student-submit"), 0.99),
        maximumQueryMs,
        maximumResponseBytes: Math.max(...evidence.requests.map((request) => request.responseBytes)),
        peakRssBytes,
        rssResidualBytes,
    };
    const failures = [];
    const failureCodes = new Set();
    const fail = (code, message) => {
        if (failureCodes.has(code)) return;
        failureCodes.add(code);
        failures.push({ code, message });
    };

    for (const [operation, expectedPaths] of Object.entries(INITIAL_OPERATIONS_PRODUCTION_WORKLOAD_PATHS)) {
        if (requestsByOperation.get(operation).some(request => (
            request.workloadPaths.length !== expectedPaths.length
            || request.workloadPaths.some((path, index) => path !== expectedPaths[index])
        ))) {
            fail("production_workload_coverage", "A workload request did not attest the exact production path");
        }
    }
    const databasePaths = new Map(evidence.database.rows.map(row => [row.workloadPath, row]));
    if (databasePaths.size !== REQUIRED_DATABASE_WORKLOAD_PATHS.length
        || REQUIRED_DATABASE_WORKLOAD_PATHS.some(path => (databasePaths.get(path)?.callsDelta || 0) < 1)) {
        fail("database_workload_coverage", "Database evidence did not cover every production workload path in-window");
    }

    const expectedBuild = clean(expectations.expectedBuild).toLowerCase();
    const expectedDatabaseProjectRefHash = clean(expectations.expectedDatabaseProjectRefHash).toLowerCase();
    const expectedFixture = buildInitialOperationsFixtureScope(evidence.runId);
    if (!GIT_SHA_PATTERN.test(expectedBuild) || !validSha(expectedDatabaseProjectRefHash)) {
        return {
            status: "unverified",
            failures: [{ code: "missing_expectations", message: "Expected build or database identity is missing" }],
            metrics,
        };
    }
    if (
        evidence.target.environment !== "staging"
        || evidence.target.build !== expectedBuild
        || evidence.target.fixture !== FIXTURE_NAME
        || evidence.target.organizationId !== expectedFixture.organizationId
        || evidence.target.examId !== expectedFixture.examId
        || evidence.target.databaseProjectRefHash !== expectedDatabaseProjectRefHash
    ) fail("target_identity", "Evidence target does not match the isolated staging target");
    if (
        evidence.probes.health.statusCode !== 200
        || evidence.probes.health.status !== "alive"
        || evidence.probes.health.build !== expectedBuild
    ) fail("health_probe", "Health probe did not prove the expected candidate build");
    if (evidence.probes.readinessUnauthorized.statusCode !== 401) {
        fail("readiness_auth", "Readiness endpoint did not reject an unauthenticated request");
    }
    if (
        evidence.probes.readiness.statusCode !== 200
        || evidence.probes.readiness.status !== "ready"
        || evidence.probes.readiness.database !== "ready"
        || evidence.probes.readiness.observability !== "ready"
        || evidence.probes.readiness.configuration !== "ready"
        || evidence.probes.readiness.version !== "202608080007"
        || evidence.probes.readiness.environment !== "staging"
        || evidence.probes.readiness.build !== expectedBuild
        || evidence.probes.readiness.databaseProjectRefHash !== expectedDatabaseProjectRefHash
    ) fail("readiness_probe", "Readiness evidence is not fully ready");

    const headers = evidence.probes.securityHeaders;
    const csp = new Map(clean(headers["content-security-policy"]).split(";").map((directive) => {
        const [name, ...values] = directive.trim().split(/\s+/);
        return [name, values];
    }).filter(([name]) => name));
    const hsts = new Map(clean(headers["strict-transport-security"]).split(";").map((directive) => {
        const [name, value = ""] = directive.trim().split("=");
        return [name.toLowerCase(), value];
    }));
    if (
        !csp.get("default-src")?.includes("'self'")
        || !csp.get("frame-ancestors")?.includes("'none'")
        || hsts.get("max-age") !== "31536000"
        || headers["x-content-type-options"] !== "nosniff"
        || headers["x-frame-options"] !== "DENY"
        || headers["referrer-policy"] !== "strict-origin-when-cross-origin"
        || typeof headers["permissions-policy"] !== "string"
        || !headers["permissions-policy"].includes("payment=()")
    ) fail("security_headers", "Production security headers are incomplete");
    if (
        evidence.probes.staticAssetCompression.statusCode !== 200
        || !["br", "gzip"].includes(evidence.probes.staticAssetCompression.encoding)
        || evidence.probes.staticAssetCompression.cachePolicy !== "immutable"
    ) fail("static_asset_compression", "Production static assets were not immutable and compressed");

    const vuById = new Map(evidence.vus.map((vu) => [vu.vuId, vu]));
    const roleCounts = Object.fromEntries(["student", "teacher-poller", "teacher-uploader"].map((role) => [
        role,
        evidence.vus.filter((vu) => vu.role === role).length,
    ]));
    if (evidence.vus.length !== INITIAL_OPERATIONS_GATE.virtualUsers
        || roleCounts.student !== INITIAL_OPERATIONS_GATE.students
        || roleCounts["teacher-poller"] !== INITIAL_OPERATIONS_GATE.teacherLivePollers
        || roleCounts["teacher-uploader"] !== INITIAL_OPERATIONS_GATE.teacherUploaders) {
        fail("workload_shape", "The measured workload did not match the required launch profile");
    }
    if (evidence.vus.some((vu) => vu.activeStartedAtMs < evidence.timeline.rampStartedAtMs
        || vu.activeStartedAtMs > evidence.timeline.steadyStartedAtMs
        || vu.activeEndedAtMs < evidence.timeline.steadyEndedAtMs)) {
        fail("vu_overlap", "All 100 virtual users were not active throughout the steady window");
    }
    const rampBuckets = new Map();
    for (const vu of evidence.vus) {
        const bucket = Math.floor((vu.activeStartedAtMs - evidence.timeline.rampStartedAtMs) / 1_000);
        rampBuckets.set(bucket, (rampBuckets.get(bucket) ?? 0) + 1);
    }
    if ([...rampBuckets.values()].some((count) => count > INITIAL_OPERATIONS_GATE.rampUsersPerSecond)) {
        fail("ramp_rate", "The virtual-user ramp exceeded five users per second");
    }
    if (evidence.timeline.steadyEndedAtMs - evidence.timeline.steadyStartedAtMs < INITIAL_OPERATIONS_GATE.steadyDurationMs) {
        fail("steady_duration", "The steady load window was shorter than three minutes");
    }
    for (const request of evidence.requests) {
        const vu = vuById.get(request.vuId);
        if (!vu || vu.actorId !== request.actorId || vu.role !== SCENARIO_ROLES[request.operation]
            || request.startedAtMs < evidence.timeline.steadyStartedAtMs
            || request.endedAtMs > evidence.timeline.steadyEndedAtMs) {
            fail("request_binding", "A raw request was not bound to the expected VU and steady window");
        }
        if (request.statusCode >= 500) fail("http_5xx", "One or more workload requests returned 5xx");
        if (!request.success || request.statusCode < 200 || request.statusCode >= 300) {
            fail("functional_failures", "One or more workload operations failed");
        }
        if (request.responseBuild !== expectedBuild) {
            fail("mixed_deployment", "A workload response came from a different application build");
        }
    }
    if (Object.entries(REQUIRED_SCENARIOS).some(([operation, count]) => requestsByOperation.get(operation).length < count)
        || Object.entries(EXACT_SCENARIOS).some(([operation, count]) => requestsByOperation.get(operation).length !== count)) {
        fail("workload_shape", "The measured workload did not match the required launch profile");
    }
    if (metrics.studentReadP95Ms >= INITIAL_OPERATIONS_GATE.gatewayReadP95Ms) {
        fail("student_read_p95", "Student gateway read p95 exceeded the launch budget");
    }
    if (metrics.teacherLiveReadP95Ms >= INITIAL_OPERATIONS_GATE.gatewayReadP95Ms) {
        fail("teacher_live_read_p95", "Teacher live gateway read p95 exceeded the launch budget");
    }
    if (metrics.teacherUploadReadP95Ms >= INITIAL_OPERATIONS_GATE.gatewayReadP95Ms) {
        fail("teacher_upload_read_p95", "Teacher uploader gateway read p95 exceeded the launch budget");
    }
    if (metrics.gatewayReadP95Ms >= INITIAL_OPERATIONS_GATE.gatewayReadP95Ms) {
        fail("gateway_read_p95", "Gateway read p95 exceeded the launch budget");
    }
    if (metrics.submitRpcP95Ms >= INITIAL_OPERATIONS_GATE.submitRpcP95Ms) {
        fail("submit_rpc_p95", "Submit RPC p95 exceeded the launch budget");
    }
    if (metrics.submitEndToEndP99Ms >= INITIAL_OPERATIONS_GATE.submitEndToEndP99Ms) {
        fail("submit_end_to_end_p99", "Submit end-to-end p99 exceeded the backend timeout budget");
    }
    if (metrics.maximumResponseBytes >= INITIAL_OPERATIONS_GATE.maximumResponseBytes) {
        fail("response_size", "A list response exceeded the launch payload budget");
    }
    const submissionBarrierWindowMs = Math.max(...submitRequests.map((request) => request.startedAtMs))
        - Math.min(...submitRequests.map((request) => request.startedAtMs));
    if (submissionBarrierWindowMs > 1_000) {
        fail("submission_barrier", "The 80 primary submissions were not released within one second");
    }
    if (Math.max(...submitRequests.map((request) => request.startedAtMs))
        >= Math.min(...submitRequests.map((request) => request.endedAtMs))) {
        fail("submission_overlap", "The 80 primary submission intervals did not overlap");
    }

    const cadenceReady = (operation, actors, intervalMs, minimumPerActor, endForActor) => actors.every((actorId) => {
        const records = requestsByOperation.get(operation)
            .filter((request) => request.actorId === actorId)
            .sort((left, right) => left.startedAtMs - right.startedAtMs);
        const samples = records.map((request) => request.startedAtMs);
        const toleranceMs = Math.min(1_000, Math.floor(intervalMs * 0.2));
        const expectedEndMs = endForActor?.(actorId) ?? evidence.timeline.steadyEndedAtMs;
        if (samples.length < minimumPerActor
            || samples[0] > evidence.timeline.steadyStartedAtMs + intervalMs + toleranceMs
            || samples.at(-1) < expectedEndMs - intervalMs - toleranceMs) return false;
        if (!samples.slice(1).every((value, index) => value - samples[index] <= intervalMs + toleranceMs)) return false;
        return operation !== "checkpoint" || records.slice(1)
            .every((record, index) => record.revision > records[index].revision);
    });
    const studentActors = evidence.vus.filter((vu) => vu.role === "student").map((vu) => vu.actorId);
    const pollerActors = evidence.vus.filter((vu) => vu.role === "teacher-poller").map((vu) => vu.actorId);
    const successfulSubmissionByActor = new Map(submitRequests
        .filter((request) => request.success)
        .map((request) => [request.actorId, request]));
    if (["checkpoint", "heartbeat"].some((operation) => requestsByOperation.get(operation)
        .some((request) => {
            const submission = successfulSubmissionByActor.get(request.actorId);
            return submission && request.startedAtMs > submission.endedAtMs;
        }))) {
        fail("post_submit_lease_traffic", "Checkpoint or heartbeat traffic started after a successful submission");
    }
    const submissionStartForActor = (actorId) => successfulSubmissionByActor.get(actorId)?.startedAtMs;
    if (!cadenceReady("checkpoint", studentActors, INITIAL_OPERATIONS_GATE.checkpointIntervalMs, 11, submissionStartForActor)
        || !cadenceReady("heartbeat", studentActors, INITIAL_OPERATIONS_GATE.heartbeatIntervalMs, 3, submissionStartForActor)
        || !cadenceReady("teacher-live-read", pollerActors, INITIAL_OPERATIONS_GATE.teacherPollIntervalMs, 59)) {
        fail("steady_cadence", "Autosave or heartbeat cadence was not sustained until submission, or live polling was not sustained for three minutes");
    }
    const studentReadActors = new Set(requestsByOperation.get("student-read").map((request) => request.actorId));
    const uploaderActors = evidence.vus.filter((vu) => vu.role === "teacher-uploader").map((vu) => vu.actorId);
    const uploaderReadActors = new Set(requestsByOperation.get("teacher-upload-read").map((request) => request.actorId));
    if (studentReadActors.size !== studentActors.length
        || studentActors.some((actorId) => !studentReadActors.has(actorId))
        || uploaderReadActors.size !== uploaderActors.length
        || uploaderActors.some((actorId) => !uploaderReadActors.has(actorId))) {
        fail("read_actor_coverage", "Steady read requests did not cover each required actor exactly once");
    }
    const studentReads = requestsByOperation.get("student-read");
    if (Math.max(...studentReads.map((request) => request.startedAtMs))
        >= Math.min(...studentReads.map((request) => request.endedAtMs))) {
        fail("concurrent_read_overlap", "The bounded student read intervals did not overlap");
    }

    const attemptIds = new Set();
    const primaryByKey = new Map();
    for (const submission of submitRequests) {
        if (!validIdentifier(submission.idempotencyKey)
            || !submission.idempotencyKey.startsWith(`${evidence.runId}:submission:`)
            || !validIdentifier(submission.attemptId)
            || !validSha(submission.receiptHash)
            || primaryByKey.has(submission.idempotencyKey)) {
            fail("submission_evidence", "Submission or replay proof is malformed");
            continue;
        }
        if (attemptIds.has(submission.attemptId)) fail("duplicate_attempt", "Primary submissions created a duplicate attempt");
        attemptIds.add(submission.attemptId);
        primaryByKey.set(submission.idempotencyKey, submission);
    }
    for (const replay of requestsByOperation.get("student-submit-replay")) {
        const primary = primaryByKey.get(replay.idempotencyKey);
        if (!primary || replay.actorId !== primary.actorId || replay.attemptId !== primary.attemptId
            || replay.receiptHash !== primary.receiptHash) {
            fail("idempotency_mismatch", "A replay did not resolve to the canonical primary receipt");
        }
    }
    const replayKeys = new Set(requestsByOperation.get("student-submit-replay")
        .map((replay) => replay.idempotencyKey));
    if (replayKeys.size !== primaryByKey.size
        || [...primaryByKey.keys()].some((key) => !replayKeys.has(key))) {
        fail("idempotency_coverage", "Replays did not cover every primary idempotency key exactly once");
    }
    const replayRequests = requestsByOperation.get("student-submit-replay");
    if (replayRequests.some((replay) => replay.startedAtMs <= primaryByKey.get(replay.idempotencyKey)?.endedAtMs)
        || Math.max(...replayRequests.map((request) => request.startedAtMs))
            >= Math.min(...replayRequests.map((request) => request.endedAtMs))) {
        fail("idempotency_coverage", "Replays were not a distinct concurrent phase after primary completion");
    }
    const submitActors = new Set(submitRequests.map((request) => request.actorId));
    const replayActors = new Set(requestsByOperation.get("student-submit-replay").map((request) => request.actorId));
    if (submitActors.size !== INITIAL_OPERATIONS_GATE.students
        || replayActors.size !== INITIAL_OPERATIONS_GATE.students
        || studentActors.some((actorId) => !submitActors.has(actorId) || !replayActors.has(actorId))) {
        fail("submission_actor_coverage", "Every student VU did not submit and replay exactly once");
    }
    if (submitRequests.length !== INITIAL_OPERATIONS_GATE.concurrentSubmissions
        || attemptIds.size !== INITIAL_OPERATIONS_GATE.concurrentSubmissions) {
        fail("duplicate_attempt", "The load run did not produce exactly 80 canonical attempts");
    }

    const uploadRequests = requestsByOperation.get("teacher-max-pdf-upload");
    const uploadBarrierWindowMs = Math.max(...uploadRequests.map((request) => request.startedAtMs))
        - Math.min(...uploadRequests.map((request) => request.startedAtMs));
    if (uploadBarrierWindowMs > 1_000) fail("upload_barrier", "The ten maximum-size uploads were not concurrent");
    if (Math.max(...uploadRequests.map((request) => request.startedAtMs))
        >= Math.min(...uploadRequests.map((request) => request.endedAtMs))) {
        fail("upload_overlap", "The ten maximum-size upload intervals did not overlap");
    }
    const uploadActors = new Set();
    const uploadObjectPaths = new Set();
    for (const request of uploadRequests) {
        const upload = request.upload;
        if (!plainObject(upload)
            || uploadActors.has(request.actorId)
            || upload.declaredBytes !== INITIAL_OPERATIONS_GATE.maxPdfBytes
            || upload.storedBytes !== INITIAL_OPERATIONS_GATE.maxPdfBytes
            || upload.directToStorage !== true
            || upload.finalized !== true
            || !validSha(upload.contentSha256)
            || !validIdentifier(upload.objectPath)
            || !new RegExp(
                `^organizations/${expectedFixture.organizationId}/exams/${expectedFixture.examId}/problem/asset_[a-f0-9]{32}\\.pdf$`,
            ).test(upload.objectPath)
            || upload.objectPath.includes("..")) {
            fail("direct_upload", "Maximum-size uploads were not distinct, direct, and complete");
        }
        uploadActors.add(request.actorId);
        uploadObjectPaths.add(upload?.objectPath);
    }
    if (uploadActors.size !== uploaderActors.length
        || uploaderActors.some((actorId) => !uploadActors.has(actorId))) {
        fail("direct_upload", "Every uploader actor did not complete exactly one upload");
    }
    if (uploadRequests.length !== INITIAL_OPERATIONS_GATE.concurrentMaxPdfUploads
        || uploadObjectPaths.size !== INITIAL_OPERATIONS_GATE.concurrentMaxPdfUploads) {
        fail("direct_upload", "The load run did not complete ten maximum-size uploads");
    }
    const storageByRequest = new Map(evidence.storage.map((record) => [record.requestEventId, record]));
    if (evidence.storage.length !== uploadRequests.length || storageByRequest.size !== uploadRequests.length) {
        fail("direct_upload", "Storage readback evidence did not match the upload requests");
    }
    for (const request of uploadRequests) {
        const record = storageByRequest.get(request.eventId);
        if (!record || record.actorId !== request.actorId || record.objectPath !== request.upload?.objectPath
            || record.expectedBytes !== request.upload?.declaredBytes
            || record.observedBytes !== request.upload?.storedBytes
            || record.expectedSha256 !== request.upload?.contentSha256
            || record.readbackSha256 !== record.expectedSha256
            || record.finalized !== true) {
            fail("direct_upload", "Storage readback did not prove the uploaded object content");
        }
    }
    const uploadStartedAtMs = Math.min(...uploadRequests.map((request) => request.startedAtMs));
    const uploadEndedAtMs = Math.max(...uploadRequests.map((request) => request.endedAtMs));
    if (pollerActors.some((actorId) => !requestsByOperation.get("teacher-live-read")
        .some((request) => request.actorId === actorId && request.endedAtMs < uploadStartedAtMs)
        || !requestsByOperation.get("teacher-live-read")
            .some((request) => request.actorId === actorId && request.startedAtMs > uploadEndedAtMs))) {
        fail("poll_upload_overlap", "Teacher polling did not continue throughout the upload barrier");
    }

    const requestByEventId = new Map(evidence.requests.map((request) => [request.eventId, request]));
    const propagationSourceActors = new Set();
    let livePropagationMaximumMs = 0;
    for (const sample of evidence.livePropagation) {
        const source = requestByEventId.get(sample.sourceEventId);
        const observed = requestByEventId.get(sample.observedEventId);
        const observedRevision = observed?.observedRevisions?.[source?.actorId];
        if (!source || !observed || source.operation !== "checkpoint" || observed.operation !== "teacher-live-read"
            || observed.endedAtMs < source.endedAtMs
            || !Number.isSafeInteger(observedRevision)
            || observedRevision < source.revision) {
            fail("live_propagation_evidence", "Live propagation evidence was not linked to raw requests");
            continue;
        }
        propagationSourceActors.add(source.actorId);
        livePropagationMaximumMs = Math.max(livePropagationMaximumMs, observed.endedAtMs - source.endedAtMs);
    }
    if (evidence.livePropagation.length !== INITIAL_OPERATIONS_GATE.students
        || propagationSourceActors.size !== INITIAL_OPERATIONS_GATE.students) {
        fail("live_propagation_evidence", "Live propagation evidence did not cover every submitting student");
    }
    if (livePropagationMaximumMs > INITIAL_OPERATIONS_GATE.livePropagationMs) {
        fail("live_propagation", "Teacher live state propagation exceeded six seconds");
    }
    if (evidence.database.instrumentation !== "pg_stat_statements"
        || evidence.database.databaseProjectRefHash !== expectedDatabaseProjectRefHash
        || evidence.database.statsResetAtMs > evidence.database.windowStartedAtMs
        || evidence.database.windowStartedAtMs > evidence.timeline.rampStartedAtMs
        || evidence.database.windowEndedAtMs < evidence.timeline.steadyEndedAtMs) {
        fail("database_instrumentation", "Database query instrumentation was not active");
    }
    if (metrics.maximumQueryMs > INITIAL_OPERATIONS_GATE.maximumQueryMs) {
        fail("query_latency", "A database query exceeded 500 ms");
    }
    if (evidence.database.countersAfter.deadlocks !== evidence.database.countersBefore.deadlocks) {
        fail("deadlock", "A database deadlock occurred");
    }
    if (evidence.database.countersAfter.lockTimeouts !== evidence.database.countersBefore.lockTimeouts) {
        fail("lock_timeout", "A database lock timeout occurred");
    }
    const inventoryByKey = new Map(evidence.database.attemptInventory.map((attempt) => [attempt.idempotencyKey, attempt]));
    if (evidence.database.attemptInventory.length !== primaryByKey.size
        || inventoryByKey.size !== primaryByKey.size
        || [...primaryByKey.entries()].some(([key, primary]) => {
            const stored = inventoryByKey.get(key);
            return !stored || stored.attemptId !== primary.attemptId || stored.receiptHash !== primary.receiptHash;
        })) {
        fail("database_attempt_inventory", "Database canonical attempts did not match the submitted receipts");
    }
    const requestInstances = new Set(evidence.requests.map((request) => request.serverInstanceId));
    const memoryInstanceIds = new Set(evidence.memory.samples.map((sample) => sample.serverInstanceId));
    if (requestInstances.size !== memoryInstanceIds.size
        || [...requestInstances].some((instanceId) => !memoryInstanceIds.has(instanceId))
        || evidence.memory.samples.some((sample) => sample.build !== expectedBuild)) {
        fail("memory_instrumentation", "RSS samples did not cover every serving application instance and build");
    }
    if (evidence.timeline.cooldownEndedAtMs - evidence.timeline.steadyEndedAtMs < INITIAL_OPERATIONS_GATE.cooldownDurationMs
        || memoryWindows.some((window) => window.peakRssBytes < window.baseline.rssBytes
            || window.peakRssBytes < window.postCooldown.rssBytes)) {
        fail("memory_instrumentation", "Server RSS cooldown evidence is incomplete");
    }
    if (memoryWindows.some((window) => Math.max(0, window.postCooldown.rssBytes - window.baseline.rssBytes) > Math.max(
        INITIAL_OPERATIONS_GATE.rssResidualFloorBytes,
        Math.floor(window.baseline.rssBytes * INITIAL_OPERATIONS_GATE.rssResidualRatio),
    ))) fail("rss_residual", "Application RSS did not return to the launch envelope");

    return { status: failures.length === 0 ? "passed" : "failed", failures, metrics };
}

export function buildInitialOperationsWorkload(runId) {
    const normalizedRunId = clean(runId).toLowerCase();
    const fixture = buildInitialOperationsFixtureScope(normalizedRunId);
    const suffix = fixture.organizationId.slice("teacher_".length);
    const students = Array.from({ length: INITIAL_OPERATIONS_GATE.students }, (_, index) => {
        const number = String(index + 1).padStart(3, "0");
        const actorId = `student_${suffix}_${number}`;
        return Object.freeze({
            phase: "steady",
            operation: "student-read",
            vuId: actorId,
            actorId,
            requestId: `${normalizedRunId}:student-read:${number}`,
            submitCandidate: index < INITIAL_OPERATIONS_GATE.concurrentSubmissions,
        });
    });
    const teachers = Array.from({ length: INITIAL_OPERATIONS_GATE.teacherLivePollers }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        const actorId = `poller_${suffix}_${number}`;
        return Object.freeze({
            phase: "steady",
            operation: "teacher-live-read",
            vuId: actorId,
            actorId,
            requestId: `${normalizedRunId}:teacher-live-read:${number}`,
        });
    });
    const uploaders = Array.from({ length: INITIAL_OPERATIONS_GATE.teacherUploaders }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        const actorId = `uploader_${suffix}_${number}`;
        return Object.freeze({
            phase: "steady",
            operation: "teacher-upload-read",
            vuId: actorId,
            actorId,
            requestId: `${normalizedRunId}:teacher-upload-read:${number}`,
        });
    });
    const submissions = students
        .filter((student) => student.submitCandidate)
        .map((student, index) => {
            const number = String(index + 1).padStart(3, "0");
            return Object.freeze({
                phase: "submission-barrier",
                operation: "student-submit",
                vuId: student.vuId,
                actorId: student.actorId,
                requestId: `${normalizedRunId}:submission-primary:${number}`,
                idempotencyKey: `${normalizedRunId}:submission:${number}`,
            });
        });
    const submissionReplays = submissions.map((submission, index) => Object.freeze({
        ...submission,
        phase: "submission-replay",
        operation: "student-submit-replay",
        requestId: `${normalizedRunId}:submission-replay:${String(index + 1).padStart(3, "0")}`,
    }));
    const uploads = uploaders.slice(0, INITIAL_OPERATIONS_GATE.concurrentMaxPdfUploads).map((teacher, index) => {
        const number = String(index + 1).padStart(2, "0");
        return Object.freeze({
            phase: "upload-barrier",
            operation: "teacher-max-pdf-upload",
            vuId: teacher.vuId,
            actorId: teacher.actorId,
            requestId: `${normalizedRunId}:upload:${number}`,
            byteSize: INITIAL_OPERATIONS_GATE.maxPdfBytes,
            organizationId: fixture.organizationId,
            examId: fixture.examId,
            idempotencyKey: `${normalizedRunId}:upload:${number}`,
        });
    });
    return Object.freeze({
        fixture,
        steady: Object.freeze([...students, ...teachers, ...uploaders]),
        submissions: Object.freeze(submissions),
        submissionReplays: Object.freeze(submissionReplays),
        uploads: Object.freeze(uploads),
        cadence: Object.freeze({
            checkpoint: Object.freeze({
                actors: INITIAL_OPERATIONS_GATE.students,
                intervalMs: INITIAL_OPERATIONS_GATE.checkpointIntervalMs,
                minimumRequests: INITIAL_OPERATIONS_GATE.students * (
                    Math.floor(INITIAL_OPERATIONS_GATE.steadyDurationMs / INITIAL_OPERATIONS_GATE.checkpointIntervalMs) - 1
                ),
            }),
            heartbeat: Object.freeze({
                actors: INITIAL_OPERATIONS_GATE.students,
                intervalMs: INITIAL_OPERATIONS_GATE.heartbeatIntervalMs,
                minimumRequests: INITIAL_OPERATIONS_GATE.students * (
                    Math.floor(INITIAL_OPERATIONS_GATE.steadyDurationMs / INITIAL_OPERATIONS_GATE.heartbeatIntervalMs) - 1
                ),
            }),
            teacherLiveRead: Object.freeze({
                actors: INITIAL_OPERATIONS_GATE.teacherLivePollers,
                intervalMs: INITIAL_OPERATIONS_GATE.teacherPollIntervalMs,
                minimumRequests: INITIAL_OPERATIONS_GATE.teacherLivePollers * (
                    Math.floor(INITIAL_OPERATIONS_GATE.steadyDurationMs / INITIAL_OPERATIONS_GATE.teacherPollIntervalMs) - 1
                ),
            }),
        }),
    });
}
