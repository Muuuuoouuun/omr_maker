import { parseStrictJson } from "./strict-json.mjs";

const HEALTH_TIMEOUT_MS = 5_000;
const HEALTH_RESPONSE_BYTES = 4 * 1024;
const UNAUTHORIZED_READINESS_TIMEOUT_MS = 5_000;
const UNAUTHORIZED_READINESS_RESPONSE_BYTES = 1024;
const READINESS_TIMEOUT_MS = 12_000;
const READINESS_RESPONSE_BYTES = 16 * 1024;
const STATIC_ASSET_TIMEOUT_MS = 5_000;
const STATIC_HTML_RESPONSE_BYTES = 256 * 1024;
const MAX_HEALTH_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

async function readWithAbort(reader, signal) {
    if (signal.aborted) throw new DOMException("Preflight timed out", "TimeoutError");
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const onAbort = () => rejectAbort(new DOMException("Preflight timed out", "TimeoutError"));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        return await Promise.race([reader.read(), aborted]);
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

async function readBoundedJson(response, maximumBytes, signal) {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
        if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
            throw new Error("Initial-operations preflight response is invalid");
        }
        const declaredBytes = Number(contentLength);
        if (!Number.isSafeInteger(declaredBytes) || declaredBytes > maximumBytes) {
            throw new Error("Initial-operations preflight response is invalid");
        }
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
        throw new Error("Initial-operations preflight response is invalid");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Initial-operations preflight response is invalid");
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
        while (true) {
            const chunk = await readWithAbort(reader, signal);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maximumBytes) {
                void reader.cancel().catch(() => undefined);
                throw new Error("Initial-operations preflight response is invalid");
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
    let body;
    try {
        body = parseStrictJson(text);
    } catch {
        throw new Error("Initial-operations preflight response is invalid");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new Error("Initial-operations preflight response is invalid");
    }
    return body;
}

async function readBoundedText(response, maximumBytes, signal, expectedContentType) {
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null) {
        if (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) > maximumBytes) {
            throw new Error("Initial-operations static asset response is invalid");
        }
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith(expectedContentType)) {
        throw new Error("Initial-operations static asset response is invalid");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Initial-operations static asset response is invalid");
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    try {
        while (true) {
            const chunk = await readWithAbort(reader, signal);
            if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > maximumBytes) {
                void reader.cancel().catch(() => undefined);
                throw new Error("Initial-operations static asset response is invalid");
            }
            text += decoder.decode(chunk.value, { stream: true });
        }
        return text + decoder.decode();
    } catch (error) {
        void reader.cancel().catch(() => undefined);
        throw error;
    } finally {
        reader.releaseLock();
    }
}

export async function probeStaticAssetCompression(config, fetchImpl = fetch, timeoutMs = STATIC_ASSET_TIMEOUT_MS) {
    if (!config || typeof config !== "object" || typeof fetchImpl !== "function") {
        throw new Error("Initial-operations static asset compression probe failed");
    }
    const controller = new AbortController();
    const boundedTimeoutMs = Math.max(100, Math.min(10_000, Math.trunc(timeoutMs)));
    const timer = setTimeout(() => controller.abort(new DOMException("Preflight timed out", "TimeoutError")), boundedTimeoutMs);
    try {
        const pageUrl = new URL("/", `${config.baseUrl}/`);
        const page = await fetchImpl(pageUrl, {
            method: "GET",
            headers: { accept: "text/html", "user-agent": "omr-maker-initial-operations/1" },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
        });
        if (page.status !== 200 || page.redirected || page.url !== pageUrl.toString()) {
            throw new Error("Initial-operations static asset response is invalid");
        }
        const html = await readBoundedText(page, STATIC_HTML_RESPONSE_BYTES, controller.signal, "text/html");
        const match = /\bsrc=["'](?<path>\/_next\/static\/chunks\/[a-zA-Z0-9_./-]+\.js)(?:\?[^"']*)?["']/.exec(html);
        const assetPath = match?.groups?.path || "";
        if (!assetPath || assetPath.split("/").includes("..")) {
            throw new Error("Initial-operations static asset response is invalid");
        }
        const assetUrl = new URL(assetPath, pageUrl);
        const asset = await fetchImpl(assetUrl, {
            method: "GET",
            headers: {
                accept: "application/javascript",
                "accept-encoding": "br, gzip",
                "user-agent": "omr-maker-initial-operations/1",
            },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
        });
        const encoding = clean(asset.headers.get("content-encoding")).toLowerCase();
        const cacheDirectives = clean(asset.headers.get("cache-control")).toLowerCase()
            .split(",").map(value => value.trim());
        const contentType = clean(asset.headers.get("content-type")).toLowerCase();
        if (
            asset.status !== 200
            || asset.redirected
            || asset.url !== assetUrl.toString()
            || !contentType.startsWith("application/javascript")
            || !["br", "gzip"].includes(encoding)
            || !cacheDirectives.includes("immutable")
        ) throw new Error("Initial-operations static asset response is invalid");
        void asset.body?.cancel().catch(() => undefined);
        return { statusCode: asset.status, encoding, cachePolicy: "immutable" };
    } catch {
        throw new Error("Initial-operations static asset compression probe failed");
    } finally {
        clearTimeout(timer);
    }
}

async function requestProbe(config, path, token, options, fetchImpl) {
    const controller = new AbortController();
    const timeoutMs = Math.max(100, Math.trunc(options.timeoutMs));
    const timer = setTimeout(() => controller.abort(new DOMException("Preflight timed out", "TimeoutError")), timeoutMs);
    const url = new URL(path, `${config.baseUrl}/`);
    try {
        const response = await fetchImpl(url, {
            method: "GET",
            headers: {
                accept: "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                "user-agent": "omr-maker-initial-operations/1",
            },
            cache: "no-store",
            credentials: "omit",
            redirect: "error",
            signal: controller.signal,
        });
        if (response.redirected || response.url !== url.toString()) {
            throw new Error("Initial-operations preflight target changed");
        }
        if (!response.headers.get("cache-control")?.toLowerCase().split(",").map((value) => value.trim()).includes("no-store")) {
            throw new Error("Initial-operations preflight cache policy is invalid");
        }
        return {
            statusCode: response.status,
            body: await readBoundedJson(response, options.maximumBytes, controller.signal),
            headers: response.headers,
        };
    } catch {
        throw new Error("Initial-operations preflight request failed");
    } finally {
        clearTimeout(timer);
    }
}

function securityHeaders(headers) {
    return Object.fromEntries([
        "content-security-policy",
        "strict-transport-security",
        "x-content-type-options",
        "x-frame-options",
        "referrer-policy",
        "permissions-policy",
    ].map((name) => [name, clean(headers.get(name))]));
}

function assertSecurityHeaders(headers) {
    const cspDirectives = headers["content-security-policy"].split(";").map((directive) => {
        const [name, ...values] = directive.trim().split(/\s+/);
        return [name, values];
    }).filter(([name]) => name);
    const hstsDirectives = headers["strict-transport-security"].split(";").map((directive) => {
        const [name, value = ""] = directive.trim().split("=");
        return [name.toLowerCase(), value];
    }).filter(([name]) => name);
    const csp = new Map(cspDirectives);
    const hsts = new Map(hstsDirectives);
    if (
        csp.size !== cspDirectives.length
        || hsts.size !== hstsDirectives.length
        || !csp.get("default-src")?.includes("'self'")
        || !csp.get("frame-ancestors")?.includes("'none'")
        || hsts.get("max-age") !== "31536000"
        || headers["x-content-type-options"] !== "nosniff"
        || headers["x-frame-options"] !== "DENY"
        || headers["referrer-policy"] !== "strict-origin-when-cross-origin"
        || !headers["permissions-policy"].split(",").map((value) => value.trim()).includes("payment=()")
    ) throw new Error("Initial-operations preflight security headers are invalid");
}

export async function runInitialOperationsPreflight(config, overrides = {}) {
    if (!config || typeof config !== "object") throw new Error("Initial-operations preflight config is invalid");
    const fetchImpl = overrides.fetchImpl ?? fetch;
    const assetCompressionProbe = overrides.assetCompressionProbe ?? probeStaticAssetCompression;
    const staticAssetCompressionPromise = assetCompressionProbe(
        config,
        fetchImpl,
        overrides.staticAssetTimeoutMs ?? STATIC_ASSET_TIMEOUT_MS,
    ).catch(() => null);
    const health = await requestProbe(config, "/api/healthz", "", {
        timeoutMs: overrides.healthTimeoutMs ?? HEALTH_TIMEOUT_MS,
        maximumBytes: overrides.healthMaximumBytes ?? HEALTH_RESPONSE_BYTES,
    }, fetchImpl);
    const readinessUnauthorized = await requestProbe(config, "/api/readyz", "", {
        timeoutMs: overrides.unauthorizedReadinessTimeoutMs ?? UNAUTHORIZED_READINESS_TIMEOUT_MS,
        maximumBytes: overrides.unauthorizedReadinessMaximumBytes ?? UNAUTHORIZED_READINESS_RESPONSE_BYTES,
    }, fetchImpl);
    const readiness = await requestProbe(
        config,
        "/api/readyz",
        config.readinessToken,
        {
            timeoutMs: overrides.readinessTimeoutMs ?? READINESS_TIMEOUT_MS,
            maximumBytes: overrides.readinessMaximumBytes ?? READINESS_RESPONSE_BYTES,
        },
        fetchImpl,
    );
    const headers = securityHeaders(health.headers);
    assertSecurityHeaders(headers);
    const staticAssetCompression = await staticAssetCompressionPromise;
    const healthTimestamp = Date.parse(health.body.timestamp);
    const now = overrides.now?.() ?? Date.now();
    if (
        health.statusCode !== 200
        || health.body.status !== "alive"
        || health.body.build !== config.expectedBuild
        || !Number.isFinite(healthTimestamp)
        || Math.abs(now - healthTimestamp) > MAX_HEALTH_CLOCK_SKEW_MS
        || readinessUnauthorized.statusCode !== 401
        || readinessUnauthorized.body.status !== "unauthorized"
        || Object.keys(readinessUnauthorized.body).length !== 1
        || !staticAssetCompression
        || readiness.statusCode !== 200
        || readiness.body.status !== "ready"
        || readiness.body.database !== "ready"
        || readiness.body.observability !== "ready"
        || readiness.body.configuration !== "ready"
        || readiness.body.version !== "202608060029"
        || readiness.body.environment !== "staging"
        || readiness.body.build !== config.expectedBuild
        || readiness.body.databaseProjectRefHash !== config.stagingProjectRefHash
    ) throw new Error("Initial-operations preflight evidence did not match the isolated staging candidate");
    return {
        observedAt: new Date(now).toISOString(),
        health: { statusCode: health.statusCode, ...health.body },
        readinessUnauthorized: { statusCode: readinessUnauthorized.statusCode },
        readiness: { statusCode: readiness.statusCode, ...readiness.body },
        securityHeaders: headers,
        staticAssetCompression,
    };
}
