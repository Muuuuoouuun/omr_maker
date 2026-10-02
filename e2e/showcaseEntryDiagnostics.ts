import type { ConsoleMessage, Frame, Page, Request, Response } from "@playwright/test";

const MAX_EVENTS = 500;
const SNAPSHOT_TIMEOUT_MS = 750;
const STAGES = [
    "before-goto", "home-loaded", "button-enabled", "clicked", "dashboard-url",
    "overview-visible", "network-idle",
] as const;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"] as const;
const RESOURCE_TYPES = [
    "document", "stylesheet", "image", "media", "font", "script", "texttrack",
    "xhr", "fetch", "eventsource", "websocket", "manifest", "other",
] as const;
const ERROR_NAMES = [
    "Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "URIError",
    "EvalError", "AggregateError", "TimeoutError", "AbortError",
] as const;

type Route = "home" | "teacher-dashboard" | "next-static" | "next-hmr" | "other-local" | "external";
type RequestCategory = "home-post" | "dashboard-rsc" | "dashboard" | "mockup-overview-chunk"
    | "teacher-dashboard-chunk" | "next-other-chunk" | "next-hmr" | "other";
type RuntimeCategory = "chunk-load" | "hydration" | "network" | "other-runtime";
export type ShowcaseEntryStage = typeof STAGES[number];
type RequestFields = {
    requestId: number;
    route: Route;
    category: RequestCategory;
    method: typeof METHODS[number] | "OTHER";
    resourceType: typeof RESOURCE_TYPES[number];
};
type Event = { elapsedMs: number } & (
    | { type: "stage"; stage: typeof STAGES[number] | "other-stage" }
    | ({ type: "request" } & RequestFields)
    | ({ type: "response"; status: number | null; durationMs: number | null } & RequestFields)
    | ({ type: "request-finished"; durationMs: number | null } & RequestFields)
    | ({ type: "request-failed"; durationMs: number | null; failure: "aborted" | "timeout" | "connection" | "other" } & RequestFields)
    | { type: "navigation"; route: Route }
    | { type: "console"; level: "warning" | "error"; category: RuntimeCategory }
    | { type: "page-error"; name: typeof ERROR_NAMES[number] | "OtherError"; category: RuntimeCategory }
);

type ReadinessSnapshot = {
    dashboardRoute: boolean;
    showcaseFlag: boolean;
    overviewPresent: boolean;
    overviewVisible: boolean;
    demoButtonPresent: boolean;
    demoButtonEnabled: boolean;
    demoButtonVisible: boolean;
    errorAlertPresent: boolean;
    readyState: "loading" | "interactive" | "complete" | "unknown";
    serviceWorkerSupported: boolean;
    serviceWorkerControlled: boolean;
    performance: {
        resourceCount: number | null;
        sampledResourceCount: number | null;
        totalResourceDurationMs: number | null;
        maxResourceDurationMs: number | null;
        domContentLoadedMs: number | null;
        loadMs: number | null;
        responseStartMs: number | null;
    };
};

export type ShowcaseEntryDiagnosticsReport = {
    version: 1;
    outcome: "passed" | "failed";
    durationMs: number;
    eventLimit: 500;
    droppedEvents: number;
    observerErrors: number;
    network: {
        trackedRequests: number;
        responses: number;
        finished: number;
        failed: number;
        pendingRequests: number;
        pendingWithResponse: number;
        pendingByCategory: { category: RequestCategory; count: number; withResponseCount: number }[];
    };
    events: Event[];
    snapshotStatus: "captured" | "timeout" | "unavailable";
    snapshot: ReadinessSnapshot | null;
};

function allowListed<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function safeNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.round(Math.min(value, 1_000_000_000)) : null;
}

function parseURL(value: string): URL | null {
    try {
        const url = new URL(value);
        return url.protocol === "http:" || url.protocol === "https:" ? url : null;
    } catch {
        return null;
    }
}

function routeFor(url: URL | null, appOrigin: string | null): Route {
    if (!url) return "external";
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!loopback && url.origin !== appOrigin) return "external";
    if (url.pathname === "/") return "home";
    if (url.pathname === "/teacher/dashboard" || url.pathname === "/teacher/dashboard/") return "teacher-dashboard";
    if (url.pathname === "/_next/webpack-hmr" || url.pathname.startsWith("/_next/webpack-hmr/")) return "next-hmr";
    if (url.pathname.startsWith("/_next/static/")) return "next-static";
    return "other-local";
}

function categoryFor(url: URL | null, route: Route, method: RequestFields["method"]): RequestCategory {
    if (route === "home" && method === "POST") return "home-post";
    if (route === "teacher-dashboard") return url?.searchParams.has("_rsc") ? "dashboard-rsc" : "dashboard";
    if (route === "next-hmr") return "next-hmr";
    if (route === "next-static") {
        const path = url?.pathname.toLowerCase() || "";
        if (/mockup[-_]?overview/.test(path)) return "mockup-overview-chunk";
        if (/teacher[-_/]dashboard/.test(path)) return "teacher-dashboard-chunk";
        return "next-other-chunk";
    }
    return "other";
}

// Text is inspected transiently for a fixed category, never retained or emitted.
function runtimeCategory(value: unknown): RuntimeCategory {
    const text = typeof value === "string" ? value.slice(0, 4_000).toLowerCase() : "";
    if (/chunkloaderror|loading chunk|chunk load|failed to fetch dynamically imported module|importing a module script failed/.test(text)) return "chunk-load";
    if (/hydration|hydrating|server rendered html/.test(text)) return "hydration";
    if (/failed to fetch|networkerror|network error|err_connection|load failed/.test(text)) return "network";
    return "other-runtime";
}

function failureCategory(value: unknown): "aborted" | "timeout" | "connection" | "other" {
    const text = typeof value === "string" ? value.slice(0, 4_000).toLowerCase() : "";
    if (/abort|cancel/.test(text)) return "aborted";
    if (/timeout|timed.?out/.test(text)) return "timeout";
    if (/connection|net::err_|network|dns|name_not_resolved/.test(text)) return "connection";
    return "other";
}

function sanitizeSnapshot(value: unknown): ReadinessSnapshot {
    const source = value && typeof value === "object" ? value as Partial<ReadinessSnapshot> : {};
    const performance = source.performance && typeof source.performance === "object" ? source.performance : {} as Partial<ReadinessSnapshot["performance"]>;
    return {
        dashboardRoute: source.dashboardRoute === true,
        showcaseFlag: source.showcaseFlag === true,
        overviewPresent: source.overviewPresent === true,
        overviewVisible: source.overviewVisible === true,
        demoButtonPresent: source.demoButtonPresent === true,
        demoButtonEnabled: source.demoButtonEnabled === true,
        demoButtonVisible: source.demoButtonVisible === true,
        errorAlertPresent: source.errorAlertPresent === true,
        readyState: allowListed(source.readyState, ["loading", "interactive", "complete", "unknown"], "unknown"),
        serviceWorkerSupported: source.serviceWorkerSupported === true,
        serviceWorkerControlled: source.serviceWorkerControlled === true,
        performance: {
            resourceCount: safeNumber(performance.resourceCount),
            sampledResourceCount: safeNumber(performance.sampledResourceCount),
            totalResourceDurationMs: safeNumber(performance.totalResourceDurationMs),
            maxResourceDurationMs: safeNumber(performance.maxResourceDurationMs),
            domContentLoadedMs: safeNumber(performance.domContentLoadedMs),
            loadMs: safeNumber(performance.loadMs),
            responseStartMs: safeNumber(performance.responseStartMs),
        },
    };
}

async function readinessSnapshot(page: Page): Promise<Pick<ShowcaseEntryDiagnosticsReport, "snapshot" | "snapshotStatus">> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            page.evaluate(() => {
                const visible = (element: Element | null): boolean => {
                    if (!element) return false;
                    const style = getComputedStyle(element);
                    const rect = element.getBoundingClientRect();
                    return style.display !== "none" && style.visibility !== "hidden"
                        && style.visibility !== "collapse" && rect.width > 0 && rect.height > 0;
                };
                const overview = document.querySelector('[aria-label="데모 계정 대시보드 개요"]');
                const button = document.querySelector<HTMLButtonElement>("button.mockup-login-button");
                const resources = performance.getEntriesByType("resource");
                const sampledResources = resources.slice(0, 500);
                const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
                return {
                    dashboardRoute: location.pathname === "/teacher/dashboard" || location.pathname === "/teacher/dashboard/",
                    showcaseFlag: new URLSearchParams(location.search).get("showcase") === "1",
                    overviewPresent: overview !== null,
                    overviewVisible: visible(overview),
                    demoButtonPresent: button !== null,
                    demoButtonEnabled: button !== null && !button.disabled && button.getAttribute("aria-disabled") !== "true",
                    demoButtonVisible: visible(button),
                    errorAlertPresent: document.querySelector('[role="alert"]') !== null,
                    readyState: document.readyState,
                    serviceWorkerSupported: "serviceWorker" in navigator,
                    serviceWorkerControlled: "serviceWorker" in navigator && navigator.serviceWorker.controller !== null,
                    performance: {
                        resourceCount: resources.length,
                        sampledResourceCount: sampledResources.length,
                        totalResourceDurationMs: sampledResources.reduce((total, entry) => total + Math.max(0, entry.duration), 0),
                        maxResourceDurationMs: sampledResources.reduce((max, entry) => Math.max(max, entry.duration), 0),
                        domContentLoadedMs: navigation?.domContentLoadedEventEnd ?? null,
                        loadMs: navigation?.loadEventEnd ?? null,
                        responseStartMs: navigation?.responseStart ?? null,
                    },
                };
            }).then(value => ({ snapshot: sanitizeSnapshot(value), snapshotStatus: "captured" as const })),
            new Promise<{ snapshot: null; snapshotStatus: "timeout" }>(resolve => {
                timer = setTimeout(() => resolve({ snapshot: null, snapshotStatus: "timeout" }), SNAPSHOT_TIMEOUT_MS);
            }),
        ]);
        return result;
    } catch {
        return { snapshot: null, snapshotStatus: "unavailable" };
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** First-attempt diagnostics only: no retries, tracing, credentials, or raw payloads. */
export function startShowcaseEntryDiagnostics(page: Page): {
    stage(name: ShowcaseEntryStage): void;
    finish(outcome: "passed" | "failed"): Promise<ShowcaseEntryDiagnosticsReport>;
} {
    const startedAt = performance.now();
    const events: Event[] = [];
    type RequestData = { fields: RequestFields; startedMs: number | null; state: "pending" | "responded" | "finished" | "failed" };
    const requests = new WeakMap<Request, RequestData>();
    const pendingByCategory = new Map<RequestCategory, { count: number; withResponseCount: number }>();
    let appOrigin: string | null = null;
    let lastElapsedMs = 0;
    let requestId = 0;
    let responses = 0;
    let finished = 0;
    let failed = 0;
    let pendingRequests = 0;
    let pendingWithResponse = 0;
    let droppedEvents = 0;
    let observerErrors = 0;
    let active = true;
    let finishPromise: Promise<ShowcaseEntryDiagnosticsReport> | undefined;
    const elapsed = () => {
        lastElapsedMs = Math.max(lastElapsedMs, safeNumber(performance.now() - startedAt) ?? lastElapsedMs);
        return lastElapsedMs;
    };
    const record = (event: Event) => {
        if (!active) return;
        if (events.length < MAX_EVENTS) events.push(event);
        else droppedEvents += 1;
    };
    const guard = <T>(callback: (value: T) => void) => (value: T) => {
        if (!active) return;
        try { callback(value); } catch { observerErrors += 1; }
    };
    try { appOrigin = parseURL(page.url())?.origin ?? null; } catch { observerErrors += 1; }
    const requestData = (request: Request, observedStart = false): RequestData => {
        const existing = requests.get(request);
        if (existing) return existing;
        const url = parseURL(request.url());
        if (!appOrigin && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
            appOrigin = url?.origin ?? null;
        }
        const method = allowListed(request.method(), [...METHODS, "OTHER"], "OTHER");
        const route = routeFor(url, appOrigin);
        const data: RequestData = {
            fields: {
                requestId: ++requestId,
                route,
                category: categoryFor(url, route, method),
                method,
                resourceType: allowListed(request.resourceType(), RESOURCE_TYPES, "other"),
            },
            startedMs: observedStart ? elapsed() : null,
            state: "pending",
        };
        requests.set(request, data);
        pendingRequests += 1;
        const counts = pendingByCategory.get(data.fields.category) ?? { count: 0, withResponseCount: 0 };
        counts.count += 1;
        pendingByCategory.set(data.fields.category, counts);
        return data;
    };
    const duration = (data: RequestData) => data.startedMs === null ? null : Math.max(0, elapsed() - data.startedMs);
    const completed = (data: RequestData, state: "finished" | "failed") => {
        if (data.state === "finished" || data.state === "failed") return;
        const counts = pendingByCategory.get(data.fields.category)!;
        pendingRequests -= 1;
        counts.count -= 1;
        if (data.state === "responded") {
            pendingWithResponse -= 1;
            counts.withResponseCount -= 1;
        }
        data.state = state;
        if (state === "finished") finished += 1;
        else failed += 1;
    };
    const onRequest = guard((request: Request) => {
        record({ type: "request", elapsedMs: elapsed(), ...requestData(request, true).fields });
    });
    const onResponse = guard((response: Response) => {
        const data = requestData(response.request());
        const status = response.status();
        if (data.state === "pending") {
            data.state = "responded";
            responses += 1;
            pendingWithResponse += 1;
            pendingByCategory.get(data.fields.category)!.withResponseCount += 1;
        }
        record({ type: "response", elapsedMs: elapsed(), ...data.fields,
            status: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
            durationMs: duration(data),
        });
    });
    const onFinished = guard((request: Request) => {
        const data = requestData(request);
        completed(data, "finished");
        record({ type: "request-finished", elapsedMs: elapsed(), ...data.fields, durationMs: duration(data) });
    });
    const onFailed = guard((request: Request) => {
        const data = requestData(request);
        const failure = failureCategory(request.failure()?.errorText);
        completed(data, "failed");
        record({ type: "request-failed", elapsedMs: elapsed(), ...data.fields,
            durationMs: duration(data), failure,
        });
    });
    const onNavigation = guard((frame: Frame) => {
        if (frame !== page.mainFrame()) return;
        record({ type: "navigation", elapsedMs: elapsed(), route: routeFor(parseURL(frame.url()), appOrigin) });
    });
    const onConsole = guard((message: ConsoleMessage) => {
        const level = message.type();
        if (level !== "warning" && level !== "error") return;
        record({ type: "console", elapsedMs: elapsed(), level, category: runtimeCategory(message.text()) });
    });
    const onPageError = guard((error: Error) => {
        record({ type: "page-error", elapsedMs: elapsed(),
            name: allowListed(error.name, [...ERROR_NAMES, "OtherError"], "OtherError"),
            category: runtimeCategory(error.message),
        });
    });
    // Keep literal event names so Playwright's event-specific overloads stay checked.
    const listeners = [
        { on: () => page.on("request", onRequest), off: () => page.off("request", onRequest) },
        { on: () => page.on("response", onResponse), off: () => page.off("response", onResponse) },
        { on: () => page.on("requestfinished", onFinished), off: () => page.off("requestfinished", onFinished) },
        { on: () => page.on("requestfailed", onFailed), off: () => page.off("requestfailed", onFailed) },
        { on: () => page.on("framenavigated", onNavigation), off: () => page.off("framenavigated", onNavigation) },
        { on: () => page.on("console", onConsole), off: () => page.off("console", onConsole) },
        { on: () => page.on("pageerror", onPageError), off: () => page.off("pageerror", onPageError) },
    ];
    for (const listener of listeners) {
        try { listener.on(); } catch { observerErrors += 1; }
    }
    return {
        stage(name) {
            record({ type: "stage", elapsedMs: elapsed(), stage: allowListed(name, [...STAGES, "other-stage"], "other-stage") });
        },
        finish(outcome) {
            if (finishPromise) return finishPromise;
            active = false;
            const durationMs = elapsed();
            finishPromise = (async () => {
                let snapshot: Pick<ShowcaseEntryDiagnosticsReport, "snapshot" | "snapshotStatus">;
                try {
                    snapshot = await readinessSnapshot(page);
                } finally {
                    // A closed page or faulty observer must never mask the entry failure.
                    for (const listener of listeners) {
                        try { listener.off(); } catch { observerErrors += 1; }
                    }
                }
                return { version: 1, outcome: outcome === "passed" ? "passed" : "failed", durationMs, eventLimit: MAX_EVENTS,
                    droppedEvents, observerErrors, events,
                    network: { trackedRequests: requestId, responses, finished, failed, pendingRequests, pendingWithResponse,
                        pendingByCategory: [...pendingByCategory.entries()]
                            .filter(([, counts]) => counts.count > 0)
                            .map(([category, counts]) => ({ category, ...counts })),
                    }, ...snapshot };
            })();
            return finishPromise;
        },
    };
}
