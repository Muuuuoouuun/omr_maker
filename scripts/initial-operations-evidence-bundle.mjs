import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { evaluateInitialOperationsEvidence } from "./initial-operations-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const MANIFEST_MAX_BYTES = 64 * 1024;
const ARTIFACTS = Object.freeze({
    preflight: { relativePath: "preflight.json", maximumBytes: 64 * 1024, format: "json" },
    driver: { relativePath: "driver.ndjson", maximumBytes: 32 * 1024 * 1024, format: "ndjson" },
    database: { relativePath: "database.ndjson", maximumBytes: 8 * 1024 * 1024, format: "ndjson" },
    rss: { relativePath: "rss.ndjson", maximumBytes: 8 * 1024 * 1024, format: "ndjson" },
    storage: { relativePath: "storage.ndjson", maximumBytes: 2 * 1024 * 1024, format: "ndjson" },
});

function unverified() {
    return {
        status: "unverified",
        failures: [{ code: "invalid_evidence_bundle", message: "Raw evidence bundle is missing or invalid" }],
        metrics: {},
    };
}

function parseNdjson(content) {
    if (!content.endsWith("\n")) throw new Error("NDJSON is truncated");
    const lines = content.slice(0, -1).split("\n");
    if (lines.length === 0 || lines.some((line) => !line.trim())) throw new Error("NDJSON contains an empty record");
    return lines.map(parseStrictJson);
}

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function timestampMs(value) {
    const parsed = Date.parse(clean(value));
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Evidence timestamp is invalid");
    return parsed;
}

function nonnegativeInteger(value) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Evidence counter is invalid");
    return value;
}

function normalizeDatabaseEvidence(input, identity) {
    if (!Array.isArray(input) || input.length !== 2) throw new Error("Database evidence is incomplete");
    const before = input.find((record) => record?.phase === "before");
    const after = input.find((record) => record?.phase === "after");
    if (!before || !after || before.status !== "ok" || after.status !== "ok"
        || before.kind !== "databaseWindow" || after.kind !== "databaseWindow"
        || before.instrumentation !== "pg_stat_statements" || after.instrumentation !== before.instrumentation
        || clean(before.statsResetAt) !== clean(after.statsResetAt)
        || !before.counters || !after.counters
        || !Array.isArray(after.rows) || after.rows.length === 0
        || !Array.isArray(after.attemptInventory)) {
        throw new Error("Database evidence is invalid");
    }
    const window = {
        kind: "databaseWindow",
        runId: identity.runId,
        databaseProjectRefHash: identity.databaseProjectRefHash,
        instrumentation: before.instrumentation,
        statsResetAtMs: timestampMs(before.statsResetAt),
        windowStartedAtMs: timestampMs(before.capturedAt),
        windowEndedAtMs: timestampMs(after.capturedAt),
        countersBefore: {
            deadlocks: nonnegativeInteger(before.counters.deadlocks),
            lockTimeouts: nonnegativeInteger(before.counters.lockTimeouts),
        },
        countersAfter: {
            deadlocks: nonnegativeInteger(after.counters.deadlocks),
            lockTimeouts: nonnegativeInteger(after.counters.lockTimeouts),
        },
        attemptInventory: after.attemptInventory.map((record) => ({
            idempotencyKey: clean(record?.idempotencyKey),
            attemptId: clean(record?.attemptId),
            receiptHash: clean(record?.receiptHash).toLowerCase(),
        })),
    };
    if (window.windowEndedAtMs < window.windowStartedAtMs) throw new Error("Database evidence window is invalid");
    if (!Array.isArray(before.rows) || before.rows.length === 0) {
        throw new Error("Database baseline query evidence is invalid");
    }
    const beforeByPath = new Map(before.rows.map(record => [clean(record?.workloadPath), record]));
    const rows = after.rows.map((record) => {
        const workloadPath = clean(record?.workloadPath);
        const baseline = beforeByPath.get(workloadPath);
        const callsBefore = nonnegativeInteger(baseline?.calls);
        const callsAfter = nonnegativeInteger(record?.calls);
        return {
            kind: "query",
            runId: identity.runId,
            workloadPath,
            fingerprint: clean(record?.fingerprint),
            callsBefore,
            callsAfter,
            callsDelta: callsAfter - callsBefore,
            maximumExecutionMs: Number(record?.maximumExecutionMs),
        };
    });
    if (beforeByPath.size !== rows.length || rows.some((record) => !record.workloadPath
        || !record.fingerprint || record.callsDelta < 0
        || !Number.isFinite(record.maximumExecutionMs) || record.maximumExecutionMs < 0)) {
        throw new Error("Database query evidence is invalid");
    }
    return [window, ...rows];
}

function normalizeRssEvidence(input, runId) {
    if (!Array.isArray(input) || input.length < 3) throw new Error("RSS evidence is incomplete");
    const records = input.map((record) => ({
        kind: "rss",
        source: clean(record?.source),
        runId: clean(record?.runId),
        serverInstanceId: clean(record?.serverInstanceId),
        build: clean(record?.build).toLowerCase(),
        capturedAtMs: nonnegativeInteger(record?.capturedAtMs),
        rssBytes: nonnegativeInteger(record?.rssBytes),
    }));
    if (records.some((record) => record.source !== "server" || record.runId !== runId
        || !record.serverInstanceId || !/^[a-f0-9]{40}$/.test(record.build) || record.rssBytes < 1)) {
        throw new Error("RSS evidence is invalid");
    }
    return records;
}

function artifactDescriptor(kind, relativePath, buffer, recordCount) {
    return {
        kind,
        relativePath,
        bytes: buffer.byteLength,
        recordCount,
        sha256: createHash("sha256").update(buffer).digest("hex"),
    };
}

export function initialOperationsRunSucceeded(loadResult, evaluation) {
    return loadResult?.status === "collected"
        && loadResult?.code === "evaluation_required"
        && loadResult?.cleanupVerified === true
        && evaluation?.status === "passed"
        && Array.isArray(evaluation.failures)
        && evaluation.failures.length === 0;
}

export async function serializeInitialOperationsEvidenceBundle(directory, input) {
    if (!isAbsolute(directory) || !input || typeof input !== "object"
        || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(clean(input.runId))
        || !/^[a-f0-9]{32,128}$/.test(clean(input.runChallenge))
        || !/^[a-f0-9]{64}$/.test(clean(input.databaseProjectRefHash))) {
        throw new Error("Evidence bundle identity is invalid");
    }
    const canonicalDirectory = await realpath(resolve(directory));
    const directoryStats = await lstat(canonicalDirectory);
    if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
        throw new Error("Evidence bundle directory is invalid");
    }
    const preflightBuffer = await readFile(join(canonicalDirectory, "preflight.json"));
    const driverBuffer = await readFile(join(canonicalDirectory, "driver.ndjson"));
    const storageBuffer = await readFile(join(canonicalDirectory, "storage.ndjson"));
    const preflight = parseStrictJson(UTF8_DECODER.decode(preflightBuffer));
    const driverRecords = parseNdjson(UTF8_DECODER.decode(driverBuffer));
    const storageRecords = parseNdjson(UTF8_DECODER.decode(storageBuffer));
    if (!preflight?.target || preflight.target.databaseProjectRefHash !== input.databaseProjectRefHash
        || driverRecords.some((record) => record?.runId !== input.runId)
        || storageRecords.some((record) => record?.runId !== input.runId)) {
        throw new Error("Evidence bundle provenance is invalid");
    }
    const databaseRecords = normalizeDatabaseEvidence(input.databaseEvidence, {
        runId: input.runId,
        databaseProjectRefHash: input.databaseProjectRefHash,
    });
    const rssRecords = normalizeRssEvidence(input.rssEvidence, input.runId);
    const databaseContent = `${databaseRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    const rssContent = `${rssRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(join(canonicalDirectory, "database.ndjson"), databaseContent, {
        encoding: "utf8", mode: 0o600, flag: "wx",
    });
    await writeFile(join(canonicalDirectory, "rss.ndjson"), rssContent, {
        encoding: "utf8", mode: 0o600, flag: "wx",
    });
    const databaseBuffer = Buffer.from(databaseContent, "utf8");
    const rssBuffer = Buffer.from(rssContent, "utf8");
    const createdAt = clean(input.createdAt) || new Date().toISOString();
    if (!Number.isFinite(Date.parse(createdAt))) throw new Error("Evidence bundle timestamp is invalid");
    const manifest = {
        schemaVersion: 2,
        runId: input.runId,
        runChallenge: input.runChallenge,
        fixture: "initial-ops-100",
        target: preflight.target,
        createdAt,
        closed: true,
        artifacts: [
            artifactDescriptor("preflight", "preflight.json", preflightBuffer, 1),
            artifactDescriptor("driver", "driver.ndjson", driverBuffer, driverRecords.length),
            artifactDescriptor("database", "database.ndjson", databaseBuffer, databaseRecords.length),
            artifactDescriptor("rss", "rss.ndjson", rssBuffer, rssRecords.length),
            artifactDescriptor("storage", "storage.ndjson", storageBuffer, storageRecords.length),
        ],
    };
    await writeFile(join(canonicalDirectory, "manifest.json"), `${JSON.stringify(manifest)}\n`, {
        encoding: "utf8", mode: 0o600, flag: "wx",
    });
    return manifest;
}

async function readRegularFile(path, maximumBytes, seenInodes) {
    const stats = await lstat(path);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > maximumBytes) {
        throw new Error("Evidence artifact is not a bounded regular file");
    }
    const inodeKey = `${stats.dev}:${stats.ino}`;
    if (seenInodes.has(inodeKey)) throw new Error("Evidence artifacts share an inode");
    seenInodes.add(inodeKey);
    const buffer = await readFile(path);
    if (buffer.byteLength !== stats.size) throw new Error("Evidence artifact changed while reading");
    return buffer;
}

function reconstructEvidence(preflight, driver, database, rss, storage) {
    const runRecords = driver.filter((record) => record?.kind === "run");
    const databaseWindows = database.filter((record) => record?.kind === "databaseWindow");
    const lifecycle = driver.filter((record) => record?.kind === "lifecycle");
    if (runRecords.length !== 1 || databaseWindows.length !== 1
        || driver.some((record) => !["lifecycle", "run", "vu", "request", "livePropagation"].includes(record?.kind))
        || database.some((record) => !["databaseWindow", "query"].includes(record?.kind))
        || rss.some((record) => record?.kind !== "rss")
        || storage.some((record) => record?.kind !== "storage")) {
        throw new Error("Evidence record union is invalid");
    }
    const run = runRecords[0];
    const fixtureSuffix = createHash("sha256").update(run.runId).digest("hex").slice(0, 16);
    const expectedOrganizationId = `teacher_${fixtureSuffix}`;
    const expectedExamId = `initial_ops_exam_${fixtureSuffix}`;
    if (lifecycle.length !== 3
        || lifecycle.map((record) => record.event).join("\n") !== [
            "external-state-attested", "fixture-created", "cleanup-verified",
        ].join("\n")
        || lifecycle[1].organizationId !== expectedOrganizationId
        || lifecycle[1].examId !== expectedExamId
        || lifecycle[2].organizationId !== expectedOrganizationId
        || lifecycle[2].examId !== expectedExamId
        || driver[0] !== lifecycle[0]
        || driver[1] !== lifecycle[1]
        || driver.indexOf(lifecycle[1]) > driver.indexOf(run)
        || driver.at(-1) !== lifecycle[2]) {
        throw new Error("Evidence lifecycle is invalid");
    }
    const databaseWindow = databaseWindows[0];
    const rssSources = new Set(rss.map((record) => record.source));
    if (rssSources.size !== 1) throw new Error("RSS source is inconsistent");
    return {
        schemaVersion: run.schemaVersion,
        runId: run.runId,
        target: preflight.target,
        probes: preflight.probes,
        timeline: run.timeline,
        vus: driver.filter((record) => record.kind === "vu"),
        requests: driver.filter((record) => record.kind === "request"),
        livePropagation: driver.filter((record) => record.kind === "livePropagation"),
        storage,
        database: {
            instrumentation: databaseWindow.instrumentation,
            runId: databaseWindow.runId,
            databaseProjectRefHash: databaseWindow.databaseProjectRefHash,
            statsResetAtMs: databaseWindow.statsResetAtMs,
            windowStartedAtMs: databaseWindow.windowStartedAtMs,
            windowEndedAtMs: databaseWindow.windowEndedAtMs,
            countersBefore: databaseWindow.countersBefore,
            countersAfter: databaseWindow.countersAfter,
            attemptInventory: databaseWindow.attemptInventory,
            rows: database.filter((record) => record.kind === "query"),
        },
        memory: {
            source: rss[0]?.source,
            samples: rss.map((record) => ({
                runId: record.runId,
                serverInstanceId: record.serverInstanceId,
                build: record.build,
                capturedAtMs: record.capturedAtMs,
                rssBytes: record.rssBytes,
            })),
        },
    };
}

export async function evaluateInitialOperationsEvidenceBundle(directory, expectations = {}) {
    try {
        if (!isAbsolute(directory)) return unverified();
        const resolvedDirectory = resolve(directory);
        const directoryStats = await lstat(resolvedDirectory);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) return unverified();
        const canonicalDirectory = await realpath(resolvedDirectory);

        const seenInodes = new Set();
        const manifestBuffer = await readRegularFile(
            join(canonicalDirectory, "manifest.json"),
            MANIFEST_MAX_BYTES,
            seenInodes,
        );
        const manifest = parseStrictJson(UTF8_DECODER.decode(manifestBuffer));
        if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
            || manifest.schemaVersion !== 2
            || manifest.closed !== true
            || manifest.fixture !== "initial-ops-100"
            || !/^[a-z0-9][a-z0-9-]{7,63}$/.test(manifest.runId)
            || !/^[a-f0-9]{32,}$/.test(manifest.runChallenge)
            || !Number.isFinite(Date.parse(manifest.createdAt))
            || !Array.isArray(manifest.artifacts)
            || manifest.artifacts.length !== Object.keys(ARTIFACTS).length) return unverified();

        const descriptors = new Map(manifest.artifacts.map((artifact) => [artifact?.kind, artifact]));
        if (descriptors.size !== manifest.artifacts.length) return unverified();
        const parsed = {};
        for (const [kind, contract] of Object.entries(ARTIFACTS)) {
            const descriptor = descriptors.get(kind);
            if (!descriptor || descriptor.relativePath !== contract.relativePath
                || !Number.isSafeInteger(descriptor.bytes) || descriptor.bytes < 1
                || !Number.isSafeInteger(descriptor.recordCount) || descriptor.recordCount < 1
                || typeof descriptor.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) {
                return unverified();
            }
            const buffer = await readRegularFile(
                join(canonicalDirectory, contract.relativePath),
                contract.maximumBytes,
                seenInodes,
            );
            if (buffer.byteLength !== descriptor.bytes
                || createHash("sha256").update(buffer).digest("hex") !== descriptor.sha256) return unverified();
            const content = UTF8_DECODER.decode(buffer);
            const records = contract.format === "ndjson" ? parseNdjson(content) : [parseStrictJson(content)];
            if (records.length !== descriptor.recordCount) return unverified();
            parsed[kind] = contract.format === "json" ? records[0] : records;
        }
        const evidence = reconstructEvidence(
            parsed.preflight,
            parsed.driver,
            parsed.database,
            parsed.rss,
            parsed.storage,
        );
        if (evidence.runId !== manifest.runId
            || !isDeepStrictEqual(evidence.target, manifest.target)) return unverified();
        return evaluateInitialOperationsEvidence(evidence, expectations);
    } catch {
        return unverified();
    }
}
