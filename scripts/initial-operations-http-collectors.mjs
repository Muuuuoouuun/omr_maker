import { createHash } from "node:crypto";

const MAX_PROVIDER_BYTES = 1024 * 1024;

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

async function boundedJson(response) {
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^(?:0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_PROVIDER_BYTES)) {
        throw new Error("Provider response exceeds bounded limit");
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new Error("Provider response is invalid");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Provider response is invalid");
    const chunks = [];
    let bytes = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > MAX_PROVIDER_BYTES) throw new Error("Provider response exceeds bounded limit");
            chunks.push(part.value);
        }
    } finally {
        reader.releaseLock();
    }
    let value;
    try {
        value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(
            chunks.map((chunk) => Buffer.from(chunk)),
            bytes,
        )));
    } catch {
        throw new Error("Provider response is invalid");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Provider response is invalid");
    }
    return value;
}

export async function createInitialOperationsCollectors(identity, overrides = {}) {
    const runId = clean(identity?.runId).toLowerCase();
    const runChallenge = clean(identity?.runChallenge).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{7,63}$/.test(runId) || !/^[a-f0-9]{32,128}$/.test(runChallenge)) {
        throw new Error("Collector identity is invalid");
    }
    const actorId = `collector_${createHash("sha256").update(runId).digest("hex").slice(0, 16)}`;
    const fetchImpl = overrides.fetchImpl ?? fetch;
    const intervalMs = Number.isSafeInteger(overrides.intervalMs) && overrides.intervalMs >= 1
        ? overrides.intervalMs
        : 5_000;
    const timeoutMs = Number.isSafeInteger(overrides.timeoutMs) && overrides.timeoutMs >= 1
        ? Math.min(overrides.timeoutMs, 120_000)
        : 15_000;
    let sequence = 0;
    const request = async (input, path) => {
        const config = input?.config;
        const baseUrl = new URL(clean(config?.baseUrl));
        if (baseUrl.protocol !== "https:" || baseUrl.username || baseUrl.password || baseUrl.port
            || baseUrl.pathname !== "/" || baseUrl.search || baseUrl.hash
            || !/^[a-f0-9]{40}$/.test(clean(config?.expectedBuild))
            || clean(config?.loadToken).length < 32) throw new Error("Provider config is invalid");
        const url = new URL(path, `${baseUrl.origin}/`);
        sequence += 1;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        let response;
        try {
            response = await fetchImpl(url, {
                method: "GET",
                headers: {
                    accept: "application/json",
                    authorization: `Bearer ${config.loadToken}`,
                    "cache-control": "no-store",
                    "x-omr-run-id": runId,
                    "x-omr-run-challenge": runChallenge,
                    "x-omr-expected-build": config.expectedBuild,
                    "x-omr-request-id": `${runId}:collector:${String(sequence).padStart(6, "0")}`,
                    "x-omr-actor-id": actorId,
                },
                cache: "no-store",
                credentials: "omit",
                redirect: "error",
                signal: controller.signal,
            });
        } finally {
            clearTimeout(timer);
        }
        if (response.redirected || response.url !== url.toString() || response.status !== 200
            || response.headers.get("x-omr-build") !== config.expectedBuild
            || !clean(response.headers.get("x-omr-instance-id"))
            || !response.headers.get("cache-control")?.toLowerCase().split(",")
                .map((value) => value.trim()).includes("no-store")) {
            throw new Error("Provider response provenance is invalid");
        }
        return {
            body: await boundedJson(response),
            responseBuild: response.headers.get("x-omr-build"),
            serverInstanceId: clean(response.headers.get("x-omr-instance-id")),
        };
    };

    const databaseRecords = [];
    const database = {
        async start(input) {
            databaseRecords.push((await request(input, "/api/internal/initial-operations/metrics/database?phase=before")).body);
        },
        async stop(input) {
            databaseRecords.push((await request(input, "/api/internal/initial-operations/metrics/database?phase=after")).body);
            return [...databaseRecords];
        },
    };

    const rssRecords = [];
    let timer;
    let pending = Promise.resolve();
    let rssInput;
    let rssFailed = false;
    const captureRss = () => {
        const attempt = pending.then(async () => {
            const observed = await request(rssInput, "/api/internal/initial-operations/operations/instance-rss-read");
            const sample = observed.body;
            if (sample.kind !== "rss" || sample.source !== "server" || sample.runId !== runId
                || sample.serverInstanceId !== observed.serverInstanceId
                || sample.build !== observed.responseBuild) {
                throw new Error("Provider RSS response is invalid");
            }
            rssRecords.push(sample);
        }).catch(() => {
            rssFailed = true;
            if (timer) clearInterval(timer);
            throw new Error("Provider RSS collection failed");
        });
        pending = attempt.catch(() => undefined);
        return attempt;
    };
    const rss = {
        async start(input) {
            rssInput = input;
            await captureRss();
            timer = setInterval(() => { void captureRss().catch(() => undefined); }, intervalMs);
        },
        async stop(input) {
            if (timer) clearInterval(timer);
            rssInput = input;
            await pending;
            if (rssFailed) throw new Error("Provider RSS collection failed");
            await captureRss();
            return [...rssRecords];
        },
    };
    return Object.freeze({ database, rss });
}
