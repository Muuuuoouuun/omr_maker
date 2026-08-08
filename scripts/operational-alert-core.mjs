import { createHash, createHmac, randomBytes } from "node:crypto";
import { resolve4, resolve6 } from "node:dns/promises";
import { lstat, link, open, realpath, unlink } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { basename, dirname, isAbsolute, normalize, parse, sep } from "node:path";

export const OPERATIONAL_ALERT_SCHEMA_VERSION = 1;
export const OPERATIONAL_ALERT_MAX_RESPONSE_BYTES = 32 * 1024;
export const OPERATIONAL_ALERT_MAX_ENDPOINT_URL_LENGTH = 2048;
export const OPERATIONAL_ALERT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const OPERATIONAL_ALERT_HMAC_DOMAIN = "omr.synthetic-alert-evidence:v1";

const EVENT_ID_PATTERN = /^evt_[a-f0-9]{32}$/;
const BUILD_SHA_PATTERN = /^[a-f0-9]{40}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CREDENTIAL_NAMES = [
    "OMR_ALERT_SINK_TOKEN",
    "OMR_ALERT_RECEIPT_TOKEN",
    "OMR_ALERT_ACK_TOKEN",
    "OMR_ALERT_RESOLVE_TOKEN",
    "OMR_ALERT_EVIDENCE_HMAC_SECRET",
];

export function createHttpsTransport({
    requestImpl = httpsRequest,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
} = {}) {
    return ({ url, address, family, method, headers, body, timeoutMs }) => new Promise((resolve, reject) => {
        let settled = false;
        let timer;
        let total = 0;
        const chunks = [];
        const finishReject = () => {
            if (settled) return;
            settled = true;
            if (timer !== undefined) clearTimer(timer);
            reject(new Error("transport failure"));
        };
        const tlsHostname = url.hostname.replace(/^\[|\]$/g, "");
        const request = requestImpl({
            protocol: "https:",
            hostname: tlsHostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers,
            servername: isIP(tlsHostname) ? undefined : tlsHostname,
            agent: false,
            family,
            autoSelectFamily: false,
            maxHeaderSize: 16 * 1024,
            lookup: (_hostname, options, callback) => options?.all
                ? callback(null, [{ address, family }])
                : callback(null, address, family),
        }, (response) => {
            response.on("data", (chunk) => {
                total += chunk.length;
                if (total > OPERATIONAL_ALERT_MAX_RESPONSE_BYTES) {
                    request.destroy();
                    finishReject();
                    return;
                }
                chunks.push(chunk);
            });
            response.on("end", () => {
                if (settled) return;
                let result;
                try {
                    result = new Response(total === 0 ? null : Buffer.concat(chunks), {
                        status: response.statusCode ?? 500,
                        headers: response.headers,
                    });
                } catch {
                    finishReject();
                    return;
                }
                settled = true;
                clearTimer(timer);
                resolve(result);
            });
            response.on("error", finishReject);
        });
        timer = setTimer(() => {
            request.destroy();
            finishReject();
        }, timeoutMs);
        request.on("error", finishReject);
        if (body) request.write(body);
        request.end();
    });
}

export const defaultHttpsTransport = createHttpsTransport();

export async function resolveAllAddresses(hostname, {
    resolveIpv4 = resolve4,
    resolveIpv6 = resolve6,
} = {}) {
    const [ipv4, ipv6] = await Promise.allSettled([resolveIpv4(hostname), resolveIpv6(hostname)]);
    return [
        ...(ipv4.status === "fulfilled" ? ipv4.value.map((address) => ({ address, family: 4 })) : []),
        ...(ipv6.status === "fulfilled" ? ipv6.value.map((address) => ({ address, family: 6 })) : []),
    ];
}

const DEFAULT_DEPS = {
    transport: defaultHttpsTransport,
    resolveAll: resolveAllAddresses,
    now: () => new Date(),
    monotonicNow: () => performance.now(),
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    generateEventId: () => `evt_${randomBytes(16).toString("hex")}`,
    generateTempName: () => randomBytes(16).toString("hex"),
    currentUid: () => process.getuid?.(),
    fs: { lstat, link, open, realpath, unlink },
};

export class OperationalAlertError extends Error {
    constructor(code) {
        super("Synthetic alert exercise is unverified");
        this.name = "OperationalAlertError";
        this.code = code;
    }
}

const SAFE_FAILURE_CODES = new Set([
    "invalid_configuration", "invalid_endpoint", "unsafe_output", "invalid_event_id", "invalid_clock",
    "request_failed", "redirect_rejected", "response_too_large", "emit_rejected", "receipt_rejected",
    "receipt_deadline", "invalid_receipt", "invalid_receipt_order", "acknowledgement_rejected",
    "invalid_acknowledgement", "invalid_acknowledgement_order", "resolution_rejected", "invalid_resolution",
    "invalid_resolution_order",
]);

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
    const host = hostname.toLowerCase();
    if (
        host === "localhost"
        || host.endsWith(".localhost")
        || host.endsWith(".local")
        || host.endsWith(".internal")
        || host.endsWith(".home")
    ) return true;
    return false;
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

function ipv4Number(address) {
    const octets = address.split(".").map(Number);
    return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function ipv4InCidr(address, base, prefix) {
    const bits = 32 - prefix;
    return (ipv4Number(address) >>> bits) === (ipv4Number(base) >>> bits);
}

function isGlobalIpv4(address) {
    if (isIP(address) !== 4) return false;
    return ![
        ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
        ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
        ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
        ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
    ].some(([base, prefix]) => ipv4InCidr(address, base, prefix));
}

function ipv6BigInt(address) {
    if (address.includes("%")) return null;
    let normalized = address.toLowerCase();
    const embedded = normalized.match(/(\d+\.\d+\.\d+\.\d+)$/);
    if (embedded) {
        if (!isGlobalIpv4(embedded[1])) return null;
        const number = ipv4Number(embedded[1]);
        normalized = normalized.slice(0, -embedded[1].length)
            + `${(number >>> 16).toString(16)}:${(number & 0xffff).toString(16)}`;
    }
    const halves = normalized.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const fill = halves.length === 2 ? 8 - left.length - right.length : 0;
    const groups = [...left, ...Array.from({ length: fill }, () => "0"), ...right];
    if (groups.length !== 8 || groups.some((group) => !/^[a-f0-9]{1,4}$/.test(group))) return null;
    return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6InCidr(value, base, prefix) {
    return (value >> BigInt(128 - prefix)) === (base >> BigInt(128 - prefix));
}

function isGlobalIpv6(address) {
    if (isIP(address) !== 6) return false;
    const value = ipv6BigInt(address);
    if (value === null) return false;
    const base = (text) => ipv6BigInt(text);
    const globalBase = base("2000::");
    if (globalBase === null || !ipv6InCidr(value, globalBase, 3)) return false;
    return ![
        ["2001:db8::", 32], ["2001:10::", 28], ["2001::", 23], ["2002::", 16], ["3fff::", 20],
    ].some(([network, prefix]) => {
        const parsed = base(network);
        return parsed !== null && ipv6InCidr(value, parsed, prefix);
    });
}

function isGlobalAddress(address) {
    const family = isIP(address);
    return family === 4 ? isGlobalIpv4(address) : family === 6 ? isGlobalIpv6(address) : false;
}

function productionEndpoint(value) {
    if (typeof value !== "string" || value.length > OPERATIONAL_ALERT_MAX_ENDPOINT_URL_LENGTH) {
        fail("invalid_configuration");
    }
    let url;
    try {
        url = new URL(value);
    } catch {
        fail("invalid_configuration");
    }
    let hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);
    if (!hostname || hostname.endsWith(".") || isLocalHostname(hostname) || isReservedHostname(hostname)) {
        fail("invalid_configuration");
    }
    if (isIP(hostname) && !isGlobalAddress(hostname)) fail("invalid_configuration");
    url.hostname = isIP(hostname) === 6 ? `[${hostname}]` : hostname;
    if (
        url.protocol !== "https:"
        || (!isIP(hostname) && !hostname.includes("."))
        || url.username
        || url.password
        || url.hash
        || url.href.length > OPERATIONAL_ALERT_MAX_ENDPOINT_URL_LENGTH
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
        evidenceHmacSecret: tokens[4],
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

async function resolveEndpoint(url, deps) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const literalFamily = isIP(hostname);
    if (literalFamily) return { url, address: hostname, family: literalFamily };
    let records;
    try {
        records = await deps.resolveAll(hostname);
    } catch {
        fail("invalid_endpoint");
    }
    if (!Array.isArray(records) || records.length === 0) fail("invalid_endpoint");
    const vetted = records.map((record) => {
        if (
            !record
            || typeof record.address !== "string"
            || (record.family !== 4 && record.family !== 6)
            || isIP(record.address) !== record.family
            || !isGlobalAddress(record.address)
        ) fail("invalid_endpoint");
        return { address: record.address, family: record.family };
    });
    return { url, ...vetted[0] };
}

async function assertSafeOutput(outputPath, deps) {
    const fs = deps.fs;
    if (
        typeof outputPath !== "string"
        || !isAbsolute(outputPath)
        || normalize(outputPath) !== outputPath
        || outputPath.endsWith("/")
    ) fail("unsafe_output");

    const parentPath = dirname(outputPath);
    const uid = deps.currentUid();
    if (!Number.isInteger(uid) || uid < 0) fail("unsafe_output");
    let parent;
    try {
        const root = parse(parentPath).root;
        const rootStats = await fs.lstat(root);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || (rootStats.mode & 0o022) !== 0) fail("unsafe_output");
        let current = root;
        const segments = parentPath.slice(root.length).split(sep).filter(Boolean);
        for (const segment of segments) {
            current = current === root ? `${root}${segment}` : `${current}${sep}${segment}`;
            const stats = await fs.lstat(current);
            if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0) fail("unsafe_output");
            if (current === parentPath) parent = stats;
        }
        const canonicalParent = await fs.realpath(parentPath);
        if (canonicalParent !== parentPath) fail("unsafe_output");
    } catch {
        fail("unsafe_output");
    }
    if (!parent || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
        fail("unsafe_output");
    }
    try {
        await fs.lstat(outputPath);
        fail("unsafe_output");
    } catch (error) {
        if (error instanceof OperationalAlertError) throw error;
        if (!error || error.code !== "ENOENT") fail("unsafe_output");
    }
    return { parentPath, dev: parent.dev, ino: parent.ino, realpath: parentPath, uid };
}

function exactObject(value, keys, code) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
    return value;
}

function timestamp(value, code, observedAtMs) {
    if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) fail(code);
    const milliseconds = Date.parse(value);
    if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) fail(code);
    if (milliseconds > observedAtMs + OPERATIONAL_ALERT_MAX_CLOCK_SKEW_MS) fail(code);
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
        response = await deps.transport({
            url: endpoint.url,
            address: endpoint.address,
            family: endpoint.family,
            method: init.method,
            body: init.body,
            timeoutMs,
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
    const observedAt = deps.now();
    if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) fail("invalid_clock");
    return { response, observedAtMs: observedAt.getTime() };
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

async function sameParentBoundary(boundary, deps) {
    try {
        const stats = await deps.fs.lstat(boundary.parentPath);
        return stats.isDirectory()
            && !stats.isSymbolicLink()
            && stats.dev === boundary.dev
            && stats.ino === boundary.ino
            && stats.uid === boundary.uid
            && (stats.mode & 0o777) === 0o700
            && await deps.fs.realpath(boundary.parentPath) === boundary.realpath;
    } catch {
        return false;
    }
}

async function writeEvidence(outputPath, evidence, deps, boundary) {
    const fs = deps.fs;
    const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
    const temporaryId = deps.generateTempName();
    if (!/^[a-f0-9]{32}$/.test(temporaryId)) fail("unsafe_output");
    const temporaryPath = `${boundary.parentPath}${sep}.${basename(outputPath)}.${temporaryId}.tmp`;
    let handle;
    let directoryHandle;
    let temporaryCreated = false;
    let temporaryPresent = false;
    let finalLinked = false;
    let closed = false;
    let ownedStats;
    let writtenStats;
    try {
        handle = await fs.open(temporaryPath, "wx", 0o600);
        temporaryCreated = true;
        temporaryPresent = true;
        if (
            typeof handle.chmod !== "function"
            || typeof handle.writeFile !== "function"
            || typeof handle.stat !== "function"
        ) fail("unsafe_output");
        ownedStats = await handle.stat();
        if (
            !ownedStats.isFile()
            || (ownedStats.mode & 0o777) !== 0o600
            || ownedStats.size !== 0
            || ownedStats.uid !== boundary.uid
        ) fail("unsafe_output");
        await handle.chmod(0o600);
        await handle.writeFile(serialized, { encoding: "utf8" });
        if (typeof handle.sync === "function") await handle.sync();
        writtenStats = await handle.stat();
        if (
            !writtenStats.isFile()
            || writtenStats.dev !== ownedStats.dev
            || writtenStats.ino !== ownedStats.ino
            || (writtenStats.mode & 0o777) !== 0o600
            || writtenStats.size !== Buffer.byteLength(serialized, "utf8")
            || writtenStats.uid !== boundary.uid
        ) fail("unsafe_output");
        if (typeof handle.close === "function") {
            await handle.close();
            closed = true;
        }
        if (!await sameParentBoundary(boundary, deps)) fail("unsafe_output");
        await fs.link(temporaryPath, outputPath);
        finalLinked = true;
        const published = await fs.lstat(outputPath);
        if (
            !published.isFile()
            || published.isSymbolicLink()
            || published.dev !== ownedStats.dev
            || published.ino !== ownedStats.ino
            || (published.mode & 0o777) !== 0o600
            || published.size !== writtenStats.size
        ) fail("unsafe_output");
        await fs.unlink(temporaryPath);
        temporaryPresent = false;
        directoryHandle = await fs.open(boundary.parentPath, "r");
        if (typeof directoryHandle.sync === "function") await directoryHandle.sync();
        if (typeof directoryHandle.close === "function") await directoryHandle.close();
        directoryHandle = undefined;
    } catch {
        if (temporaryCreated && !ownedStats && handle && typeof handle.stat === "function") {
            try {
                ownedStats = await handle.stat();
            } catch {
                // Cleanup remains fail closed if inode identity cannot be recovered.
            }
        }
        if (handle && !closed && typeof handle.close === "function") {
            try {
                await handle.close();
            } catch {
                // Cleanup is best effort; the result remains unverified.
            }
        }
        if (directoryHandle && typeof directoryHandle.close === "function") {
            try {
                await directoryHandle.close();
            } catch {
                // Cleanup is best effort.
            }
        }
        if (finalLinked && ownedStats) {
            try {
                const finalStats = await fs.lstat(outputPath);
                if (finalStats.dev === ownedStats.dev && finalStats.ino === ownedStats.ino) {
                    await fs.unlink(outputPath);
                }
            } catch {
                // Cleanup is best effort and inode-bound.
            }
        }
        if (temporaryCreated && temporaryPresent && ownedStats) {
            try {
                const tempStats = await fs.lstat(temporaryPath);
                if (tempStats.dev === ownedStats.dev && tempStats.ino === ownedStats.ino) {
                    await fs.unlink(temporaryPath);
                }
            } catch {
                // Cleanup is best effort; never touches an unowned path.
            }
        }
        fail("unsafe_output");
    }
}

export async function runOperationalAlertExercise(input, overrides = {}) {
    const deps = dependencies(overrides);
    const config = parseOperationalAlertInput(input.argv, input.env);
    const outputBoundary = await assertSafeOutput(config.outputPath, deps);
    const endpoints = {
        sink: await resolveEndpoint(config.endpoints.sink, deps),
        receipt: await resolveEndpoint(config.endpoints.receipt, deps),
        acknowledge: await resolveEndpoint(config.endpoints.acknowledge, deps),
        resolve: await resolveEndpoint(config.endpoints.resolve, deps),
    };

    const eventId = deps.generateEventId();
    if (!EVENT_ID_PATTERN.test(eventId)) fail("invalid_event_id");
    const now = deps.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("invalid_clock");
    const emittedAt = now.toISOString();
    const emittedMs = now.getTime();

    const { response: emitResponse } = await request(config, deps, endpoints.sink, config.tokens.sink, eventId, {
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

    const receiptStartedMs = deps.monotonicNow();
    const maximumPollAttempts = Math.ceil(config.deadlineMs / config.pollIntervalMs);
    let receipt;
    for (let attempt = 0; attempt < maximumPollAttempts; attempt += 1) {
        const elapsedMs = deps.monotonicNow() - receiptStartedMs;
        if (elapsedMs >= config.deadlineMs) fail("receipt_deadline");
        const remainingMs = Math.max(1, config.deadlineMs - elapsedMs);
        const receiptResult = await request(
            config,
            deps,
            endpoints.receipt,
            config.tokens.receipt,
            eventId,
            { method: "GET" },
            Math.min(config.requestTimeoutMs, remainingMs),
        );
        const { response } = receiptResult;
        if ([202, 204, 404].includes(response.status)) {
            await boundedResponseText(response);
            const remainingAfterResponseMs = config.deadlineMs - (deps.monotonicNow() - receiptStartedMs);
            if (remainingAfterResponseMs <= 0) fail("receipt_deadline");
            await deps.sleep(Math.min(config.pollIntervalMs, remainingAfterResponseMs));
            continue;
        }
        if (response.status !== 200) fail("receipt_rejected");
        receipt = {
            payload: await exactJson(response, ["eventId", "sinkReceivedAt", "alertReceivedAt"], "invalid_receipt"),
            observedAtMs: receiptResult.observedAtMs,
        };
        break;
    }
    if (!receipt) fail("receipt_deadline");
    requireEventId(receipt.payload, eventId, "invalid_receipt");
    const sinkReceivedAt = timestamp(receipt.payload.sinkReceivedAt, "invalid_receipt", receipt.observedAtMs);
    const alertReceivedAt = timestamp(receipt.payload.alertReceivedAt, "invalid_receipt", receipt.observedAtMs);
    if (sinkReceivedAt.milliseconds < emittedMs || alertReceivedAt.milliseconds < sinkReceivedAt.milliseconds) {
        fail("invalid_receipt_order");
    }

    const acknowledgeResult = await request(config, deps, endpoints.acknowledge, config.tokens.acknowledge, eventId, {
        method: "POST",
        body: JSON.stringify({ eventId }),
    });
    if (acknowledgeResult.response.status !== 200) fail("acknowledgement_rejected");
    const acknowledgement = await exactJson(acknowledgeResult.response, ["eventId", "acknowledgedAt"], "invalid_acknowledgement");
    requireEventId(acknowledgement, eventId, "invalid_acknowledgement");
    const acknowledgedAt = timestamp(acknowledgement.acknowledgedAt, "invalid_acknowledgement", acknowledgeResult.observedAtMs);
    if (acknowledgedAt.milliseconds < alertReceivedAt.milliseconds) fail("invalid_acknowledgement_order");

    const resolveResult = await request(config, deps, endpoints.resolve, config.tokens.resolve, eventId, {
        method: "POST",
        body: JSON.stringify({ eventId }),
    });
    if (resolveResult.response.status !== 200) fail("resolution_rejected");
    const resolution = await exactJson(resolveResult.response, ["eventId", "resolvedAt"], "invalid_resolution");
    requireEventId(resolution, eventId, "invalid_resolution");
    const resolvedAt = timestamp(resolution.resolvedAt, "invalid_resolution", resolveResult.observedAtMs);
    if (resolvedAt.milliseconds < acknowledgedAt.milliseconds) fail("invalid_resolution_order");

    const verifiedAtDate = deps.now();
    if (!(verifiedAtDate instanceof Date) || !Number.isFinite(verifiedAtDate.getTime())) fail("invalid_clock");
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
        verifiedAt: verifiedAtDate.toISOString(),
        endpointOriginHashes: {
            sink: sha256(config.endpoints.sink.origin),
            receipt: sha256(config.endpoints.receipt.origin),
            acknowledge: sha256(config.endpoints.acknowledge.origin),
            resolve: sha256(config.endpoints.resolve.origin),
        },
    };
    const integrity = `sha256:${sha256(JSON.stringify(canonicalize(unsignedEvidence)))}`;
    const signedEvidence = { ...unsignedEvidence, integrity };
    const evidence = {
        ...signedEvidence,
        attestation: `hmac-sha256:${createHmac("sha256", config.evidenceHmacSecret)
            .update(`${OPERATIONAL_ALERT_HMAC_DOMAIN}\0${JSON.stringify(canonicalize(signedEvidence))}`, "utf8")
            .digest("hex")}`,
    };
    await writeEvidence(config.outputPath, evidence, deps, outputBoundary);
    return evidence;
}

export async function runOperationalAlertCli({ argv, env, deps, stderr = console.error }) {
    try {
        await runOperationalAlertExercise({ argv, env }, deps);
        return 0;
    } catch (error) {
        const code = error instanceof OperationalAlertError && SAFE_FAILURE_CODES.has(error.code)
            ? error.code
            : "internal_failure";
        stderr(`unverified: ${code}`);
        return 1;
    }
}
