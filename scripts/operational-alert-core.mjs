import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

export const OPERATIONAL_ALERT_SCHEMA_VERSION = 1;
export const OPERATIONAL_ALERT_MAX_RESPONSE_BYTES = 32 * 1024;

const EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const BUILD_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CREDENTIAL_NAMES = [
    "OMR_ALERT_SINK_TOKEN",
    "OMR_ALERT_RECEIPT_TOKEN",
    "OMR_ALERT_ACK_TOKEN",
    "OMR_ALERT_RESOLVE_TOKEN",
];

const DEFAULT_DEPS = {
    fetch: globalThis.fetch,
    now: () => new Date(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    generateEventId: () => `evt_${randomBytes(16).toString("hex")}`,
    timeoutSignal: (milliseconds) => AbortSignal.timeout(milliseconds),
    fs: { chmod, lstat, writeFile },
};

export class OperationalAlertError extends Error {
    constructor(code) {
        super("Synthetic alert exercise is unverified");
        this.name = "OperationalAlertError";
        this.code = code;
    }
}

function fail(code) {
    throw new OperationalAlertError(code);
}

function boundedInteger(value, minimum, maximum) {
    if (!/^[1-9]\d*$/.test(value ?? "")) fail("invalid_configuration");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        fail("invalid_configuration");
    }
    return parsed;
}

function isLocalHostname(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
        host === "localhost"
        || host === "0.0.0.0"
        || host === "::"
        || host === "::1"
        || host.endsWith(".localhost")
        || host.endsWith(".local")
    ) return true;

    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const octets = ipv4.slice(1).map(Number);
        if (octets.some((octet) => octet > 255)) return true;
        return octets[0] === 10
            || octets[0] === 127
            || octets[0] === 0
            || (octets[0] === 169 && octets[1] === 254)
            || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
            || (octets[0] === 192 && octets[1] === 168)
            || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
    }
    return host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb");
}

function isReservedHostname(hostname) {
    const host = hostname.toLowerCase();
    return host.endsWith(".test")
        || host.endsWith(".invalid")
        || host.endsWith(".example")
        || ["example.com", "example.net", "example.org"].some(
            (reserved) => host === reserved || host.endsWith(`.${reserved}`),
        );
}

function productionEndpoint(value) {
    let url;
    try {
        url = new URL(value);
    } catch {
        fail("invalid_configuration");
    }
    if (
        url.protocol !== "https:"
        || !url.hostname.includes(".")
        || isLocalHostname(url.hostname)
        || isReservedHostname(url.hostname)
        || url.username
        || url.password
        || url.hash
    ) fail("invalid_configuration");
    return url;
}

function credential(value) {
    if (
        typeof value !== "string"
        || value.length < 32
        || value.length > 512
        || /\s/.test(value)
    ) fail("invalid_configuration");
    return value;
}

export function parseOperationalAlertInput(argv, env) {
    if (!Array.isArray(argv) || argv.length !== 2 || argv[0] !== "--output" || typeof argv[1] !== "string") {
        fail("invalid_configuration");
    }
    if (!BUILD_SHA_PATTERN.test(env.OMR_BUILD_SHA ?? "")) fail("invalid_configuration");

    const tokens = CREDENTIAL_NAMES.map((name) => credential(env[name]));
    if (new Set(tokens).size !== tokens.length) fail("invalid_configuration");

    const config = {
        outputPath: argv[1],
        buildSha: env.OMR_BUILD_SHA,
        pollIntervalMs: boundedInteger(env.OMR_ALERT_POLL_INTERVAL_MS, 250, 5_000),
        deadlineMs: boundedInteger(env.OMR_ALERT_DEADLINE_MS, 1_000, 120_000),
        requestTimeoutMs: boundedInteger(env.OMR_ALERT_REQUEST_TIMEOUT_MS, 1_000, 10_000),
        endpoints: {
            sink: productionEndpoint(env.OMR_ALERT_SINK_URL),
            receipt: productionEndpoint(env.OMR_ALERT_RECEIPT_URL),
            acknowledge: productionEndpoint(env.OMR_ALERT_ACK_URL),
            resolve: productionEndpoint(env.OMR_ALERT_RESOLVE_URL),
        },
        tokens: {
            sink: tokens[0],
            receipt: tokens[1],
            acknowledge: tokens[2],
            resolve: tokens[3],
        },
    };
    if (config.deadlineMs < config.pollIntervalMs) fail("invalid_configuration");
    return config;
}

function dependencies(overrides = {}) {
    return {
        ...DEFAULT_DEPS,
        ...overrides,
        fs: { ...DEFAULT_DEPS.fs, ...overrides.fs },
    };
}

async function assertSafeOutput(outputPath, fs) {
    if (
        typeof outputPath !== "string"
        || !isAbsolute(outputPath)
        || normalize(outputPath) !== outputPath
        || outputPath.endsWith("/")
    ) fail("unsafe_output");

    const parentPath = dirname(outputPath);
    let parent;
    try {
        parent = await fs.lstat(parentPath);
    } catch {
        fail("unsafe_output");
    }
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0) {
        fail("unsafe_output");
    }
    try {
        await fs.lstat(outputPath);
        fail("unsafe_output");
    } catch (error) {
        if (error instanceof OperationalAlertError) throw error;
        if (!error || error.code !== "ENOENT") fail("unsafe_output");
    }
}

function exactObject(value, keys, code) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
    return value;
}

function timestamp(value, code) {
    if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) fail(code);
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
    return { value, milliseconds };
}

async function boundedResponseText(response) {
    const declaredLength = response.headers.get("content-length");
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > OPERATIONAL_ALERT_MAX_RESPONSE_BYTES)) {
        fail("response_too_large");
    }
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > OPERATIONAL_ALERT_MAX_RESPONSE_BYTES) {
            await reader.cancel();
            fail("response_too_large");
        }
        chunks.push(value);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

async function exactJson(response, keys, code) {
    let parsed;
    try {
        parsed = JSON.parse(await boundedResponseText(response));
    } catch (error) {
        if (error instanceof OperationalAlertError) throw error;
        fail(code);
    }
    return exactObject(parsed, keys, code);
}

async function request(config, deps, endpoint, token, eventId, init, timeoutMs = config.requestTimeoutMs) {
    let response;
    try {
        response = await deps.fetch(endpoint, {
            ...init,
            redirect: "error",
            signal: deps.timeoutSignal(timeoutMs),
            headers: {
                authorization: `Bearer ${token}`,
                "x-omr-event-id": eventId,
                accept: "application/json",
                ...(init.body ? { "content-type": "application/json" } : {}),
            },
        });
    } catch {
        fail("request_failed");
    }
    if (response.status >= 300 && response.status < 400) fail("redirect_rejected");
    return response;
}

function requireEventId(payload, eventId, code) {
    if (payload.eventId !== eventId) fail(code);
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    }
    return value;
}

function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

async function writeEvidence(outputPath, evidence, fs) {
    try {
        await fs.writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx", mode: 0o600, encoding: "utf8" });
        await fs.chmod(outputPath, 0o600);
        const written = await fs.lstat(outputPath);
        if (!written.isFile() || written.isSymbolicLink() || (written.mode & 0o777) !== 0o600) fail("unsafe_output");
    } catch (error) {
        if (error instanceof OperationalAlertError) throw error;
        fail("unsafe_output");
    }
}

export async function runOperationalAlertExercise(input, overrides = {}) {
    const deps = dependencies(overrides);
    const config = parseOperationalAlertInput(input.argv, input.env);
    await assertSafeOutput(config.outputPath, deps.fs);

    const eventId = deps.generateEventId();
    if (!EVENT_ID_PATTERN.test(eventId)) fail("invalid_event_id");
    const now = deps.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("invalid_clock");
    const emittedAt = now.toISOString();
    const emittedMs = now.getTime();

    const emitResponse = await request(config, deps, config.endpoints.sink, config.tokens.sink, eventId, {
        method: "POST",
        body: JSON.stringify({
            eventId,
            event: "omr.synthetic_alert",
            severity: "critical",
            buildSha: config.buildSha,
            emittedAt,
            correlation: eventId,
        }),
    });
    if (![200, 201, 202, 204].includes(emitResponse.status)) fail("emit_rejected");
    await boundedResponseText(emitResponse);

    const receiptStartedMs = deps.now().getTime();
    const maximumPollAttempts = Math.ceil(config.deadlineMs / config.pollIntervalMs);
    let receipt;
    for (let attempt = 0; attempt < maximumPollAttempts; attempt += 1) {
        const elapsedMs = deps.now().getTime() - receiptStartedMs;
        if (elapsedMs >= config.deadlineMs) fail("receipt_deadline");
        const remainingMs = Math.max(1, config.deadlineMs - elapsedMs);
        const response = await request(
            config,
            deps,
            config.endpoints.receipt,
            config.tokens.receipt,
            eventId,
            { method: "GET" },
            Math.min(config.requestTimeoutMs, remainingMs),
        );
        if ([202, 204, 404].includes(response.status)) {
            await boundedResponseText(response);
            await deps.sleep(config.pollIntervalMs);
            continue;
        }
        if (response.status !== 200) fail("receipt_rejected");
        receipt = await exactJson(response, ["eventId", "sinkReceivedAt", "alertReceivedAt"], "invalid_receipt");
        break;
    }
    if (!receipt) fail("receipt_deadline");
    requireEventId(receipt, eventId, "invalid_receipt");
    const sinkReceivedAt = timestamp(receipt.sinkReceivedAt, "invalid_receipt");
    const alertReceivedAt = timestamp(receipt.alertReceivedAt, "invalid_receipt");
    if (sinkReceivedAt.milliseconds < emittedMs || alertReceivedAt.milliseconds < sinkReceivedAt.milliseconds) {
        fail("invalid_receipt_order");
    }

    const acknowledgeResponse = await request(config, deps, config.endpoints.acknowledge, config.tokens.acknowledge, eventId, {
        method: "POST",
        body: JSON.stringify({ eventId }),
    });
    if (acknowledgeResponse.status !== 200) fail("acknowledgement_rejected");
    const acknowledgement = await exactJson(acknowledgeResponse, ["eventId", "acknowledgedAt"], "invalid_acknowledgement");
    requireEventId(acknowledgement, eventId, "invalid_acknowledgement");
    const acknowledgedAt = timestamp(acknowledgement.acknowledgedAt, "invalid_acknowledgement");
    if (acknowledgedAt.milliseconds < alertReceivedAt.milliseconds) fail("invalid_acknowledgement_order");

    const resolveResponse = await request(config, deps, config.endpoints.resolve, config.tokens.resolve, eventId, {
        method: "POST",
        body: JSON.stringify({ eventId }),
    });
    if (resolveResponse.status !== 200) fail("resolution_rejected");
    const resolution = await exactJson(resolveResponse, ["eventId", "resolvedAt"], "invalid_resolution");
    requireEventId(resolution, eventId, "invalid_resolution");
    const resolvedAt = timestamp(resolution.resolvedAt, "invalid_resolution");
    if (resolvedAt.milliseconds < acknowledgedAt.milliseconds) fail("invalid_resolution_order");

    const unsignedEvidence = {
        status: "verified",
        schemaVersion: OPERATIONAL_ALERT_SCHEMA_VERSION,
        buildSha: config.buildSha,
        eventId,
        emittedAt,
        sinkReceivedAt: sinkReceivedAt.value,
        alertReceivedAt: alertReceivedAt.value,
        acknowledgedAt: acknowledgedAt.value,
        resolvedAt: resolvedAt.value,
        endpointOriginHashes: {
            sink: sha256(config.endpoints.sink.origin),
            receipt: sha256(config.endpoints.receipt.origin),
            acknowledge: sha256(config.endpoints.acknowledge.origin),
            resolve: sha256(config.endpoints.resolve.origin),
        },
    };
    const evidence = {
        ...unsignedEvidence,
        integrity: `sha256:${sha256(JSON.stringify(canonicalize(unsignedEvidence)))}`,
    };
    await writeEvidence(config.outputPath, evidence, deps.fs);
    return evidence;
}

export async function runOperationalAlertCli({ argv, env, deps, stderr = console.error }) {
    try {
        await runOperationalAlertExercise({ argv, env }, deps);
        return 0;
    } catch {
        stderr("unverified: synthetic alert exercise failed");
        return 1;
    }
}
