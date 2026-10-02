// @vitest-environment jsdom

import { EventEmitter } from "node:events";
import type { Frame, Page, Request, Response } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startShowcaseEntryDiagnostics, type ShowcaseEntryStage } from "../../e2e/showcaseEntryDiagnostics";

const CANARY = "credential-canary-password-bearer-token-private@example.test";
const EVENTS = ["request", "response", "requestfinished", "requestfailed", "framenavigated", "console", "pageerror"];

function snapshot() {
    return {
        dashboardRoute: true, showcaseFlag: true,
        overviewPresent: true, overviewVisible: true,
        demoButtonPresent: false, demoButtonEnabled: false, demoButtonVisible: false,
        inputDelivered: { pointerDown: null, pointerUp: null, touchStart: null, touchEnd: null, click: null },
        focusedTeacherIdentifier: false,
        errorAlertPresent: false, readyState: "complete",
        serviceWorkerSupported: true, serviceWorkerControlled: false,
        performance: { resourceCount: 3, sampledResourceCount: 3,
            totalResourceDurationMs: 52, maxResourceDurationMs: 34,
            domContentLoadedMs: 15, loadMs: 58, responseStartMs: 7 },
    };
}

function mockPage() {
    const emitter = new EventEmitter();
    const frame = { url: vi.fn(() => `http://localhost:3003/teacher/dashboard?showcase=1&password=${CANARY}#${CANARY}`) };
    const page = Object.assign(emitter, {
        url: vi.fn(() => "http://localhost:3003/"),
        mainFrame: vi.fn(() => frame as unknown as Frame),
        evaluate: vi.fn<(callback: () => unknown) => Promise<unknown>>().mockResolvedValue(snapshot()),
        context: vi.fn(() => { throw new Error("Diagnostics must not inspect auth context"); }),
    });
    return { page, frame, playwrightPage: page as unknown as Page };
}

function mockRequest(url: string, options: { method?: string; resourceType?: string; failure?: string; frame?: Frame; navigation?: boolean } = {}) {
    const request = {
        url: vi.fn(() => url),
        method: vi.fn(() => options.method ?? "GET"),
        resourceType: vi.fn(() => options.resourceType ?? "fetch"),
        isNavigationRequest: vi.fn(() => options.navigation ?? false),
        frame: vi.fn(() => options.frame),
        failure: vi.fn(() => ({ errorText: options.failure ?? CANARY })),
        postData: vi.fn(() => CANARY),
        postDataJSON: vi.fn(() => ({ password: CANARY })),
        headers: vi.fn(() => ({ authorization: CANARY, cookie: CANARY })),
        allHeaders: vi.fn(async () => ({ authorization: CANARY })),
    };
    return { request, playwrightRequest: request as unknown as Request };
}

function response(request: Request, status = 200) {
    return {
        request: () => request, status: () => status,
        url: vi.fn(() => CANARY), body: vi.fn(async () => Buffer.from(CANARY)),
        text: vi.fn(async () => CANARY), headers: vi.fn(() => ({ authorization: CANARY })),
    } as unknown as Response;
}

function consoleMessage(level: string, text = CANARY) {
    return { type: () => level, text: vi.fn(() => text), args: vi.fn(() => [CANARY]),
        location: vi.fn(() => ({ url: CANARY, lineNumber: 1, columnNumber: 1 })) };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    document.body.innerHTML = "";
});

describe("showcase entry diagnostics", () => {
    it("retains only boolean native-delivery flags and never arbitrary event or focus payloads", async () => {
        const { page, playwrightPage } = mockPage();
        page.evaluate.mockResolvedValue({ ...snapshot(), focusedTeacherIdentifier: CANARY,
            inputDelivered: { pointerDown: true, pointerUp: false, touchStart: CANARY, touchEnd: 1, click: true, rawEvent: CANARY },
        });
        const report = await startShowcaseEntryDiagnostics(playwrightPage).finish("failed");
        expect(report.snapshot?.inputDelivered).toEqual({
            pointerDown: true, pointerUp: false, touchStart: null, touchEnd: null, click: true,
        });
        expect(report.snapshot?.focusedTeacherIdentifier).toBe(false);
        expect(JSON.stringify(report)).not.toContain(CANARY);
    });

    it("reads fixed native-delivery indicators without exposing the focused input value", async () => {
        const { page, playwrightPage } = mockPage();
        document.body.innerHTML = '<input id="teacher-identifier"><button class="mockup-login-button" data-omr-diagnostic-pointerdown="1" data-omr-diagnostic-pointerup="1" data-omr-diagnostic-touchstart="1" data-omr-diagnostic-touchend="1" data-omr-diagnostic-click="0"></button>';
        const input = document.getElementById("teacher-identifier") as HTMLInputElement;
        input.value = CANARY;
        input.focus();
        page.evaluate.mockImplementation(async callback => callback());
        const report = await startShowcaseEntryDiagnostics(playwrightPage).finish("failed");
        expect(report.snapshot?.inputDelivered).toEqual({
            pointerDown: true, pointerUp: true, touchStart: true, touchEnd: true, click: false,
        });
        expect(report.snapshot?.focusedTeacherIdentifier).toBe(true);
        expect(JSON.stringify(report)).not.toContain(CANARY);
    });

    it("records a compact successful first-attempt timeline and cleans up every listener", async () => {
        const { page, playwrightPage } = mockPage();
        let now = 100;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        diagnostics.stage("before-goto");
        const { playwrightRequest } = mockRequest("http://localhost:3003/?role=teacher", { resourceType: "document" });
        now = 105;
        page.emit("request", playwrightRequest);
        now = 130;
        page.emit("response", response(playwrightRequest));
        now = 142;
        page.emit("requestfinished", playwrightRequest);
        diagnostics.stage("overview-visible");
        now = 150;
        const report = await diagnostics.finish("passed");

        expect(report.outcome).toBe("passed");
        expect(report.durationMs).toBe(50);
        expect(report.events.map(event => event.elapsedMs)).toEqual([0, 5, 30, 42, 42]);
        expect(report.events[2]).toMatchObject({ type: "response", requestId: 1, status: 200, durationMs: 25 });
        expect(report.events[3]).toMatchObject({ type: "request-finished", requestId: 1, durationMs: 37 });
        expect(report.snapshotStatus).toBe("captured");
        expect(report.snapshot).toEqual(snapshot());
        expect(page.evaluate).toHaveBeenCalledTimes(1);
        expect(page.context).not.toHaveBeenCalled();
        EVENTS.forEach(event => expect(page.listenerCount(event)).toBe(0));
        diagnostics.stage("clicked");
        page.emit("request", playwrightRequest);
        expect(report.events).toHaveLength(5);
        expect(await diagnostics.finish("failed")).toBe(report);
    });

    it("never emits hostile URL, payload, header, console, error-name, stage or snapshot strings", async () => {
        const { page, frame, playwrightPage } = mockPage();
        page.evaluate.mockResolvedValue({ ...snapshot(), readyState: CANARY, url: CANARY, storage: CANARY,
            performance: { ...snapshot().performance, resourceCount: CANARY, name: CANARY } });
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        diagnostics.stage(CANARY as ShowcaseEntryStage);
        const { request, playwrightRequest } = mockRequest(`http://user:${CANARY}@localhost:3003/${CANARY}?password=${CANARY}#${CANARY}`, {
            method: CANARY, resourceType: CANARY,
        });
        page.emit("request", playwrightRequest);
        const hostileResponse = response(playwrightRequest, 599);
        page.emit("response", hostileResponse);
        page.emit("requestfailed", playwrightRequest);
        page.emit("framenavigated", frame);
        const message = consoleMessage("error", `ChunkLoadError: ${CANARY}`);
        page.emit("console", message);
        const error = { name: CANARY, message: `Hydration failed ${CANARY}`,
            get stack(): string { throw new Error("Never inspect a stack"); } };
        page.emit("pageerror", error);
        const report = await diagnostics.finish("failed");

        expect(JSON.stringify(report)).not.toContain(CANARY);
        expect(report.events).toContainEqual(expect.objectContaining({ type: "stage", stage: "other-stage" }));
        expect(report.events).toContainEqual(expect.objectContaining({ method: "OTHER", resourceType: "other", route: "other-local" }));
        expect(report.events).toContainEqual(expect.objectContaining({ type: "console", category: "chunk-load" }));
        expect(report.events).toContainEqual(expect.objectContaining({ type: "page-error", name: "OtherError", category: "hydration" }));
        expect(report.snapshot?.readyState).toBe("unknown");
        expect(report.snapshot?.performance.resourceCount).toBeNull();
        [request.postData, request.postDataJSON, request.headers, request.allHeaders,
            hostileResponse.body, hostileResponse.text, hostileResponse.headers, hostileResponse.url,
            message.args, message.location].forEach(method => expect(method).not.toHaveBeenCalled());
    });

    it("distinguishes action-like POST, RSC, known lazy chunks, HMR and external requests without filenames", async () => {
        const { page, playwrightPage } = mockPage();
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        const cases = [
            ["/?role=teacher", "POST", "home", "home-post"],
            [`/teacher/dashboard?showcase=1&_rsc=${CANARY}`, "GET", "teacher-dashboard", "dashboard-rsc"],
            ["/teacher/dashboard", "GET", "teacher-dashboard", "dashboard"],
            [`/_next/static/chunks/_app-pages-browser_src_components_dashboard_MockupOverview_tsx-${CANARY}.js`, "GET", "next-static", "mockup-overview-chunk"],
            [`/_next/static/chunks/app/teacher/dashboard/page-${CANARY}.js`, "GET", "next-static", "teacher-dashboard-chunk"],
            [`/_next/static/chunks/${CANARY}.js`, "GET", "next-static", "next-other-chunk"],
            [`/_next/webpack-hmr?${CANARY}`, "GET", "next-hmr", "next-hmr"],
            [`/${CANARY}`, "GET", "other-local", "other"],
        ];
        for (const [path, method] of cases) page.emit("request", mockRequest(`http://localhost:3003${path}`, { method }).playwrightRequest);
        page.emit("request", mockRequest(`https://external.example/teacher/dashboard?${CANARY}`).playwrightRequest);
        const report = await diagnostics.finish("failed");
        expect(report.events.map(event => "route" in event ? [event.route, "category" in event ? event.category : ""] : [])).toEqual([
            ...cases.map(([, , route, category]) => [route, category]), ["external", "other"],
        ]);
        expect(JSON.stringify(report)).not.toContain(CANARY);
    });

    it("recognizes a remote app's first main-frame request and ignores subframe navigation", async () => {
        const { page, frame, playwrightPage } = mockPage();
        page.url.mockReturnValue("about:blank");
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        const url = "https://preview.example/?role=teacher";
        page.emit("request", mockRequest(url, { navigation: true, frame: frame as unknown as Frame }).playwrightRequest);
        frame.url.mockReturnValue(`https://preview.example/teacher/dashboard?showcase=1&${CANARY}`);
        page.emit("framenavigated", { url: () => `https://external.example/${CANARY}` });
        page.emit("framenavigated", frame);
        const report = await diagnostics.finish("passed");
        expect(report.events).toHaveLength(2);
        expect(report.events[0]).toMatchObject({ route: "home" });
        expect(report.events[1]).toMatchObject({ type: "navigation", route: "teacher-dashboard" });
    });

    it("categorizes failures and runtime errors, ignores lower-level console output", async () => {
        const { page, playwrightPage } = mockPage();
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        const failures = ["net::ERR_ABORTED", "Request timed out", "net::ERR_CONNECTION_RESET", CANARY];
        for (const failure of failures) page.emit("requestfailed", mockRequest(`http://localhost:3003/${CANARY}`, { failure }).playwrightRequest);
        const ignored = consoleMessage("log");
        page.emit("console", ignored);
        page.emit("console", consoleMessage("warning", `NetworkError ${CANARY}`));
        page.emit("console", consoleMessage("error", CANARY));
        page.emit("pageerror", new TypeError(CANARY));
        const report = await diagnostics.finish("failed");
        expect(report.events.filter(event => event.type === "request-failed").map(event => event.failure)).toEqual(["aborted", "timeout", "connection", "other"]);
        expect(report.events.filter(event => event.type === "console").map(event => event.category)).toEqual(["network", "other-runtime"]);
        expect(report.events.at(-1)).toMatchObject({ type: "page-error", name: "TypeError" });
        expect(ignored.text).not.toHaveBeenCalled();
        expect(JSON.stringify(report)).not.toContain(CANARY);
    });

    it("distinguishes pending requests with and without response headers, even after truncation", async () => {
        const { page, playwrightPage } = mockPage();
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        const pendingChunk = mockRequest("http://localhost:3003/_next/static/chunks/MockupOverview.js").playwrightRequest;
        const pendingRsc = mockRequest(`http://localhost:3003/teacher/dashboard?_rsc=${CANARY}`).playwrightRequest;
        const done = mockRequest("http://localhost:3003/").playwrightRequest;
        for (let index = 0; index < 500; index++) diagnostics.stage("clicked");
        for (const request of [pendingChunk, pendingRsc, done]) page.emit("request", request);
        page.emit("response", response(pendingChunk));
        page.emit("response", response(done));
        page.emit("requestfinished", done);
        const report = await diagnostics.finish("failed");
        expect(report.network).toEqual({ trackedRequests: 3, responses: 2, finished: 1, failed: 0,
            pendingRequests: 2, pendingWithResponse: 1,
            pendingByCategory: [
                { category: "mockup-overview-chunk", count: 1, withResponseCount: 1 },
                { category: "dashboard-rsc", count: 1, withResponseCount: 0 },
            ] });
        expect(report.events).toHaveLength(500);
        expect(report.droppedEvents).toBe(6);
        expect(JSON.stringify(report)).not.toContain(CANARY);
    });

    it("bounds events at 500, counts truncation and keeps elapsed timestamps nonnegative and monotonic", async () => {
        const { page, playwrightPage } = mockPage();
        let now = 100;
        vi.spyOn(performance, "now").mockImplementation(() => now);
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        for (let index = 0; index < 515; index++) {
            now = index % 2 ? 90 : 100 + index;
            diagnostics.stage("clicked");
        }
        const report = await diagnostics.finish("failed");
        expect(report.events).toHaveLength(500);
        expect(report.droppedEvents).toBe(15);
        expect(report.eventLimit).toBe(500);
        expect(report.events.every((event, index) => event.elapsedMs >= 0
            && (index === 0 || event.elapsedMs >= report.events[index - 1].elapsedMs))).toBe(true);
        EVENTS.forEach(event => expect(page.listenerCount(event)).toBe(0));
    });

    it("does not mask failure when snapshot rejects or event getters throw", async () => {
        const { page, playwrightPage } = mockPage();
        page.evaluate.mockRejectedValue(new Error(CANARY));
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        page.emit("request", { url: () => { throw new Error(CANARY); } });
        const report = await diagnostics.finish("failed");
        expect(report).toMatchObject({ outcome: "failed", observerErrors: 1, snapshotStatus: "unavailable", snapshot: null });
        expect(JSON.stringify(report)).not.toContain(CANARY);
        EVENTS.forEach(event => expect(page.listenerCount(event)).toBe(0));
    });

    it("finishes within the bounded snapshot timeout and ignores events during or after finalization", async () => {
        vi.useFakeTimers();
        const { page, playwrightPage } = mockPage();
        let resolveSnapshot: (value: unknown) => void = () => {};
        page.evaluate.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve; }));
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        const pending = diagnostics.finish("failed");
        expect(diagnostics.finish("passed")).toBe(pending);
        page.emit("console", consoleMessage("error", CANARY));
        await vi.advanceTimersByTimeAsync(749);
        expect(page.listenerCount("request")).toBe(1);
        await vi.advanceTimersByTimeAsync(1);
        const report = await pending;
        expect(report).toMatchObject({ snapshotStatus: "timeout", snapshot: null, events: [] });
        EVENTS.forEach(event => expect(page.listenerCount(event)).toBe(0));
        expect(vi.getTimerCount()).toBe(0);
        resolveSnapshot({ raw: CANARY });
        await Promise.resolve();
        expect(report.snapshot).toBeNull();
        expect(JSON.stringify(report)).not.toContain(CANARY);
    });

    it("extracts DOM and performance readiness as booleans and aggregates without reading stored credentials", async () => {
        const { page, playwrightPage } = mockPage();
        history.replaceState(null, "", `/teacher/dashboard?showcase=1&password=${CANARY}`);
        document.body.innerHTML = `<section aria-label="데모 계정 대시보드 개요">${CANARY}</section><button class="mockup-login-button" disabled>${CANARY}</button><p role="alert">${CANARY}</p><input value="${CANARY}">`;
        vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ width: 20, height: 10 } as DOMRect);
        const cookieGetter = vi.spyOn(document, "cookie", "get").mockImplementation(() => { throw new Error(CANARY); });
        const storageGetter = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error(CANARY); });
        const scriptURLGetter = vi.fn(() => { throw new Error(CANARY); });
        Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { controller: { get scriptURL() { return scriptURLGetter(); } } } });
        const entryNameGetter = vi.fn(() => { throw new Error(CANARY); });
        const entry = (duration: number, entryType = "resource") => ({
            duration, get name(): string { return entryNameGetter(); },
            entryType, startTime: 0, toJSON: () => ({}),
            domContentLoadedEventEnd: 11, loadEventEnd: 20, responseStart: 3,
        });
        vi.spyOn(performance, "getEntriesByType").mockImplementation(type => type === "resource"
            ? [entry(5), entry(8)]
            : [entry(20, "navigation")]);
        page.evaluate.mockImplementation(async callback => callback());
        const diagnostics = startShowcaseEntryDiagnostics(playwrightPage);
        const report = await diagnostics.finish("passed");

        expect(report.snapshot).toMatchObject({ dashboardRoute: true, showcaseFlag: true,
            overviewPresent: true, overviewVisible: true, demoButtonPresent: true,
            demoButtonEnabled: false, demoButtonVisible: true, errorAlertPresent: true,
            serviceWorkerSupported: true, serviceWorkerControlled: true,
            performance: { resourceCount: 2, sampledResourceCount: 2, totalResourceDurationMs: 13,
                maxResourceDurationMs: 8, domContentLoadedMs: 11, loadMs: 20, responseStartMs: 3 } });
        [cookieGetter, storageGetter, scriptURLGetter, entryNameGetter].forEach(method => expect(method).not.toHaveBeenCalled());
        expect(JSON.stringify(report)).not.toContain(CANARY);
        delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
    });
});
