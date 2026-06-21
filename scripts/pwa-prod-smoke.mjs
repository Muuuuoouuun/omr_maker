import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices } from "@playwright/test";

const port = Number(process.env.PWA_SMOKE_PORT || 3004);
const externalBaseUrl = process.env.PWA_SMOKE_BASE_URL?.replace(/\/$/, "");
const baseUrl = externalBaseUrl || `http://localhost:${port}`;
const ownsServer = !externalBaseUrl;
const expectedCachePrefix = "omr-maker-v8";
const requiredHttpResources = [
    { contentType: "text/html", pathname: "/pwa-check" },
    { contentType: "application/manifest+json", pathname: "/manifest.webmanifest" },
    { contentType: "application/javascript", pathname: "/sw.js" },
    { contentType: "image/png", pathname: "/apple-touch-icon.png" },
    { contentType: "image/png", pathname: "/icons/icon-192.png" },
    { contentType: "image/png", pathname: "/icons/icon-512.png" },
    { contentType: "image/png", pathname: "/icons/maskable-icon-512.png" },
    { contentType: "image/jpeg", pathname: "/screenshots/omr-mobile-home.jpg" },
    { contentType: "image/jpeg", pathname: "/screenshots/omr-wide-home.jpg" },
    { contentType: "text/html", pathname: "/offline.html" },
];
const requiredImageSpecs = [
    { height: 180, src: "/apple-touch-icon.png", width: 180 },
    { height: 192, src: "/icons/icon-192.png", width: 192 },
    { height: 512, src: "/icons/icon-512.png", width: 512 },
    { height: 512, src: "/icons/maskable-icon-512.png", width: 512 },
    { height: 844, src: "/screenshots/omr-mobile-home.jpg", width: 379 },
    { height: 720, src: "/screenshots/omr-wide-home.jpg", width: 1269 },
];

function assert(condition, message, details) {
    if (!condition) {
        const suffix = details ? `\n${JSON.stringify(details, null, 2)}` : "";
        throw new Error(`${message}${suffix}`);
    }
}

function isLocalhostUrl(url) {
    const parsed = new URL(url);
    return parsed.hostname === "localhost"
        || parsed.hostname === "127.0.0.1"
        || parsed.hostname === "::1"
        || parsed.hostname.endsWith(".localhost");
}

function assertDeployableOrigin(url) {
    const parsed = new URL(url);
    if (isLocalhostUrl(url)) return;
    assert(parsed.protocol === "https:", "External PWA smoke URLs must use HTTPS for installability", {
        protocol: parsed.protocol,
        url,
    });
}

function isExpectedOfflineBrowserProblem(problem) {
    return /ERR_INTERNET_DISCONNECTED/i.test(problem);
}

async function waitForHttp(url, timeoutMs = 30_000) {
    const startedAt = Date.now();
    let lastError;

    while (Date.now() - startedAt < timeoutMs) {
        try {
            const response = await fetch(url, { cache: "no-store" });
            if (response.ok) return;
            lastError = new Error(`HTTP ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await delay(250);
    }

    throw new Error(`Timed out waiting for ${url}: ${lastError?.message || "unknown error"}`);
}

async function fetchResourceInfo(pathname) {
    const url = new URL(pathname, baseUrl);
    const response = await fetch(url, { cache: "no-store" });
    return {
        cacheControl: response.headers.get("cache-control") || "",
        contentLength: response.headers.get("content-length") || "",
        contentType: response.headers.get("content-type") || "",
        ok: response.ok,
        pathname,
        status: response.status,
        url: url.href,
    };
}

async function collectResourceState() {
    const resources = await Promise.all(requiredHttpResources.map(resource => fetchResourceInfo(resource.pathname)));
    resources.forEach(resource => {
        const expected = requiredHttpResources.find(item => item.pathname === resource.pathname);
        assert(resource.ok, "PWA resource did not return HTTP 2xx", resource);
        assert(
            resource.contentType.toLowerCase().includes(expected.contentType),
            "PWA resource content-type is incorrect",
            { expectedContentType: expected.contentType, ...resource },
        );
    });

    const serviceWorker = resources.find(resource => resource.pathname === "/sw.js");
    assert(
        /no-cache|no-store|max-age=0/i.test(serviceWorker.cacheControl),
        "Service worker must not be served with a long-lived cache policy",
        serviceWorker,
    );

    return resources;
}

function startNextServer() {
    const child = spawn("npm", ["run", "start", "--", "-p", String(port)], {
        env: { ...process.env, PORT: String(port) },
        stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", chunk => process.stdout.write(`[pwa-server] ${chunk}`));
    child.stderr.on("data", chunk => process.stderr.write(`[pwa-server] ${chunk}`));

    return child;
}

async function closeServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill("SIGTERM");

    await Promise.race([
        new Promise(resolve => child.once("exit", resolve)),
        delay(5_000).then(() => {
            if (child.exitCode === null) child.kill("SIGKILL");
        }),
    ]);
}

async function waitForServiceWorker(page) {
    return page.evaluate(async () => {
        if (!("serviceWorker" in navigator)) {
            return { supported: false };
        }

        const timeoutAt = Date.now() + 15_000;
        let registration = await navigator.serviceWorker.getRegistration("/sw.js");
        while (!registration && Date.now() < timeoutAt) {
            await new Promise(resolve => setTimeout(resolve, 100));
            registration = await navigator.serviceWorker.getRegistration("/sw.js");
        }

        if (!registration) return { supported: true, registered: false };

        await Promise.race([
            navigator.serviceWorker.ready,
            new Promise(resolve => setTimeout(resolve, 10_000)),
        ]);

        const current = await navigator.serviceWorker.getRegistration("/sw.js");
        return {
            activeState: current?.active?.state || null,
            controller: Boolean(navigator.serviceWorker.controller),
            installingState: current?.installing?.state || null,
            registered: Boolean(current),
            scope: current?.scope || null,
            scriptURL: current?.active?.scriptURL || current?.waiting?.scriptURL || current?.installing?.scriptURL || null,
            supported: true,
            waitingState: current?.waiting?.state || null,
        };
    });
}

async function collectPwaMetadata(page) {
    return page.evaluate(async () => {
        const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute("href") || null;
        const manifestUrl = manifestHref ? new URL(manifestHref, window.location.href).href : null;
        const manifest = manifestUrl ? await fetch(manifestUrl).then(response => response.json()) : null;

        return {
            appleCapable: [...document.querySelectorAll('meta[name="apple-mobile-web-app-capable"]')]
                .map(meta => meta.getAttribute("content")),
            appleIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") || null,
            manifest,
            manifestHref,
            mobileCapable: [...document.querySelectorAll('meta[name="mobile-web-app-capable"]')]
                .map(meta => meta.getAttribute("content")),
            title: document.title,
        };
    });
}

async function collectOriginState(page) {
    return page.evaluate(() => ({
        host: window.location.host,
        isSecureContext: window.isSecureContext,
        origin: window.location.origin,
        protocol: window.location.protocol,
    }));
}

async function collectImageState(page) {
    return page.evaluate(async requiredImageSpecs => {
        function loadImage(spec) {
            return new Promise(resolve => {
                const image = new Image();
                image.onload = () => resolve({
                    ...spec,
                    actualHeight: image.naturalHeight,
                    actualWidth: image.naturalWidth,
                    loaded: true,
                });
                image.onerror = () => resolve({
                    ...spec,
                    actualHeight: 0,
                    actualWidth: 0,
                    loaded: false,
                });
                image.src = spec.src;
            });
        }

        return Promise.all(requiredImageSpecs.map(loadImage));
    }, requiredImageSpecs);
}

async function collectCacheState(page) {
    return page.evaluate(async expectedCachePrefix => {
        const keys = await caches.keys();
        return {
            cachedHome: Boolean(await caches.match("/")),
            cachedLogo: Boolean(await caches.match("/logo.png")),
            cachedOffline: Boolean(await caches.match("/offline.html")),
            cachedPwaCheck: Boolean(await caches.match("/pwa-check")),
            cacheKeys: keys,
            expectedCacheKeys: keys.filter(key => key.startsWith(expectedCachePrefix)),
        };
    }, expectedCachePrefix);
}

async function collectChromiumInstallabilityState(context, page) {
    const session = await context.newCDPSession(page);

    try {
        await session.send("Page.enable");
        const manifest = await session.send("Page.getAppManifest");
        const installability = await session.send("Page.getInstallabilityErrors");

        return {
            hasManifestData: Boolean(manifest.data),
            installabilityErrors: installability.installabilityErrors || [],
            manifestErrors: manifest.errors || [],
            manifestUrl: manifest.url || "",
        };
    } finally {
        await session.detach().catch(() => undefined);
    }
}

async function runSmoke() {
    assertDeployableOrigin(baseUrl);

    let server;
    if (ownsServer) {
        server = startNextServer();
        await waitForHttp(baseUrl);
    } else {
        await waitForHttp(baseUrl);
    }

    const browser = await chromium.launch();
    const context = await browser.newContext({
        ...devices["Pixel 5"],
        baseURL: baseUrl,
    });
    const page = await context.newPage();
    let smokePhase = "online";
    const onlineConsoleProblems = [];
    const offlineConsoleProblems = [];
    page.on("console", message => {
        if (message.type() === "error" || message.type() === "warning") {
            const problem = `${message.type()}: ${message.text()}`;
            if (smokePhase === "offline") {
                offlineConsoleProblems.push(problem);
            } else {
                onlineConsoleProblems.push(problem);
            }
        }
    });

    try {
        await page.goto("/", { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "OMR Maker" }).waitFor({ state: "visible", timeout: 10_000 });

        const originState = await collectOriginState(page);
        assert(originState.isSecureContext, "PWA page must run in a secure context", originState);

        const resourceState = await collectResourceState();

        const metadata = await collectPwaMetadata(page);
        assert(metadata.manifestHref === "/manifest.webmanifest", "Manifest link is missing or incorrect", metadata);
        assert(metadata.appleIcon === "/apple-touch-icon.png", "Apple touch icon is missing or incorrect", metadata);
        assert(metadata.mobileCapable.every(value => value === "yes") && metadata.mobileCapable.length > 0, "Android mobile app metadata is missing", metadata);
        assert(metadata.appleCapable.every(value => value === "yes") && metadata.appleCapable.length > 0, "iOS web app metadata is missing", metadata);
        assert(metadata.manifest?.name === "OMR Maker", "Manifest name is incorrect", metadata.manifest);
        assert(metadata.manifest?.short_name === "OMR Maker", "Manifest short_name is incorrect", metadata.manifest);
        assert(metadata.manifest?.id === "/", "Manifest id is incorrect", metadata.manifest);
        assert(metadata.manifest?.start_url === "/", "Manifest start_url is incorrect", metadata.manifest);
        assert(metadata.manifest?.scope === "/", "Manifest scope is incorrect", metadata.manifest);
        assert(metadata.manifest?.lang === "ko", "Manifest lang is incorrect", metadata.manifest);
        assert(metadata.manifest?.display === "standalone", "Manifest display must be standalone", metadata.manifest);
        assert(metadata.manifest?.display_override?.includes("standalone"), "Manifest display_override should include standalone", metadata.manifest);
        assert(metadata.manifest?.categories?.includes("education"), "Manifest should be categorized for education", metadata.manifest);
        assert(metadata.manifest?.shortcuts?.length >= 4, "Manifest shortcuts are missing", metadata.manifest);
        assert(
            ["/create", "/teacher/dashboard", "/?role=student", "/pwa-check"]
                .every(url => metadata.manifest.shortcuts.some(shortcut => shortcut.url === url)),
            "Manifest shortcuts must include core app and device-check entries",
            metadata.manifest,
        );
        assert(metadata.manifest?.icons?.some(icon => icon.purpose === "maskable"), "Manifest must include a maskable icon", metadata.manifest);
        assert(metadata.manifest?.icons?.some(icon => icon.sizes === "192x192"), "Manifest must include a 192x192 icon", metadata.manifest);
        assert(metadata.manifest?.icons?.some(icon => icon.sizes === "512x512"), "Manifest must include a 512x512 icon", metadata.manifest);
        assert(metadata.manifest?.screenshots?.length >= 2, "Manifest must include install preview screenshots", metadata.manifest);
        assert(
            metadata.manifest?.screenshots?.some(screenshot => screenshot.form_factor === "narrow")
                && metadata.manifest?.screenshots?.some(screenshot => screenshot.form_factor === "wide"),
            "Manifest screenshots must include narrow and wide form factors",
            metadata.manifest,
        );

        const imageState = await collectImageState(page);
        imageState.forEach(image => {
            assert(image.loaded, "PWA image asset failed to load", image);
            assert(
                image.actualWidth === image.width && image.actualHeight === image.height,
                "PWA image dimensions do not match their manifest/install contract",
                image,
            );
        });

        let serviceWorker = await waitForServiceWorker(page);
        assert(serviceWorker.supported && serviceWorker.registered, "Service worker did not register", serviceWorker);
        assert(serviceWorker.scriptURL?.endsWith("/sw.js"), "Service worker script URL is incorrect", serviceWorker);

        await page.reload({ waitUntil: "networkidle" });
        await page.waitForFunction(() => navigator.serviceWorker?.controller, null, { timeout: 10_000 });
        serviceWorker = await waitForServiceWorker(page);
        assert(serviceWorker.controller, "Service worker did not control the app after reload", serviceWorker);

        const chromiumInstallabilityState = await collectChromiumInstallabilityState(context, page);
        assert(chromiumInstallabilityState.hasManifestData, "Chromium could not read the web app manifest", chromiumInstallabilityState);
        assert(chromiumInstallabilityState.manifestUrl.endsWith("/manifest.webmanifest"), "Chromium manifest URL is incorrect", chromiumInstallabilityState);
        assert(chromiumInstallabilityState.manifestErrors.length === 0, "Chromium reported web app manifest errors", chromiumInstallabilityState);
        assert(chromiumInstallabilityState.installabilityErrors.length === 0, "Chromium reported PWA installability errors", chromiumInstallabilityState);

        await page.goto("/pwa-check", { waitUntil: "networkidle" });
        await page.getByRole("heading", { name: "PWA 디바이스 체크" }).waitFor({ state: "visible", timeout: 10_000 });
        await page.getByTestId("pwa-device-handoff-qr").waitFor({ state: "visible", timeout: 10_000 });
        await page.waitForFunction(() => (
            document.querySelector('[data-testid="pwa-device-report"]')?.textContent?.includes("OMR Maker PWA device check")
        ), null, { timeout: 10_000 });
        const onlineDeviceCheckState = await page.evaluate(() => ({
            handoffUrl: document.querySelector('[data-testid="pwa-device-handoff-url"]')?.textContent || "",
            hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            report: document.querySelector('[data-testid="pwa-device-report"]')?.textContent || "",
            verdict: document.querySelector('[data-testid="pwa-device-verdict"]')?.textContent || "",
        }));
        assert(!onlineDeviceCheckState.hasHorizontalOverflow, "Online PWA device check has horizontal overflow", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.handoffUrl.includes("/pwa-check"), "PWA device check handoff URL is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("OMR Maker PWA device check"), "PWA device check report is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("displayEvidence="), "PWA device check display evidence is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("launch-proof="), "PWA device check launch proof is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("viewport-height=pass:동기화"), "PWA device check viewport height sync is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("keyboard-safe-area=pass:준비"), "PWA device check keyboard safe area is missing", onlineDeviceCheckState);

        const cacheState = await collectCacheState(page);
        assert(cacheState.expectedCacheKeys.length >= 1, "Expected PWA cache was not created", cacheState);
        assert(
            cacheState.cachedHome && cacheState.cachedOffline && cacheState.cachedLogo && cacheState.cachedPwaCheck,
            "Critical app shell assets were not cached",
            cacheState,
        );

        smokePhase = "offline";
        await context.setOffline(true);
        await page.goto("/?role=student", { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.getByRole("heading", { name: "학습 시작" }).waitFor({ state: "visible", timeout: 10_000 });
        const offlineState = await page.evaluate(() => ({
            hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            title: document.title,
            url: window.location.href,
        }));
        assert(!offlineState.hasHorizontalOverflow, "Offline student shortcut has horizontal overflow", offlineState);

        await page.goto("/pwa-check", { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.getByRole("heading", { name: "PWA 디바이스 체크" }).waitFor({ state: "visible", timeout: 10_000 });
        await page.waitForFunction(() => (
            document.querySelector('[data-testid="pwa-device-report"]')?.textContent?.includes("OMR Maker PWA device check")
        ), null, { timeout: 10_000 });
        const offlineDeviceCheckState = await page.evaluate(() => ({
            hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            report: document.querySelector('[data-testid="pwa-device-report"]')?.textContent || "",
            url: window.location.href,
            verdict: document.querySelector('[data-testid="pwa-device-verdict"]')?.textContent || "",
        }));
        assert(!offlineDeviceCheckState.hasHorizontalOverflow, "Offline PWA device check has horizontal overflow", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("OMR Maker PWA device check"), "Offline PWA device check report is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("displayEvidence="), "Offline PWA device check display evidence is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("launch-proof="), "Offline PWA device check launch proof is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("viewport-height=pass:동기화"), "Offline PWA device check viewport height sync is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("keyboard-safe-area=pass:준비"), "Offline PWA device check keyboard safe area is missing", offlineDeviceCheckState);

        await page.goto("/offline.html", { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.getByRole("heading", { name: "오프라인 상태입니다" }).waitFor({ state: "visible", timeout: 10_000 });
        const offlineFallbackState = await page.evaluate(() => {
            const actions = [...document.querySelectorAll(".offline-action")].map(action => {
                const box = action.getBoundingClientRect();
                return {
                    height: Math.round(box.height),
                    href: action instanceof HTMLAnchorElement ? action.getAttribute("href") : null,
                    label: action.textContent?.trim() || "",
                    tagName: action.tagName.toLowerCase(),
                    width: Math.round(box.width),
                };
            });

            return {
                actionHrefs: actions.map(action => action.href).filter(Boolean),
                actionLabels: actions.map(action => action.label),
                actions,
                hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
                title: document.title,
                url: window.location.href,
            };
        });
        assert(offlineFallbackState.title === "OMR Maker 오프라인", "Offline fallback page title is incorrect", offlineFallbackState);
        assert(!offlineFallbackState.hasHorizontalOverflow, "Offline fallback page has horizontal overflow", offlineFallbackState);
        assert(offlineFallbackState.actionHrefs.includes("/"), "Offline fallback is missing a home return action", offlineFallbackState);
        assert(offlineFallbackState.actionHrefs.includes("/pwa-check"), "Offline fallback is missing a PWA device check action", offlineFallbackState);
        assert(offlineFallbackState.actionLabels.includes("다시 연결 시도"), "Offline fallback is missing a reconnect action", offlineFallbackState);
        assert(
            offlineFallbackState.actions.every(action => action.width >= 44 && action.height >= 44),
            "Offline fallback touch targets are too small",
            offlineFallbackState,
        );

        const unexpectedOfflineConsoleProblems = offlineConsoleProblems.filter(problem => !isExpectedOfflineBrowserProblem(problem));
        assert(onlineConsoleProblems.length === 0, "Online console warnings/errors were emitted during PWA smoke", onlineConsoleProblems);
        assert(
            unexpectedOfflineConsoleProblems.length === 0,
            "Unexpected offline console warnings/errors were emitted during PWA smoke",
            { offlineConsoleProblems, unexpectedOfflineConsoleProblems },
        );

        console.log(JSON.stringify({
            baseUrl,
            cacheState,
            imageState,
            installability: {
                chromiumInstallable: chromiumInstallabilityState.installabilityErrors.length === 0,
                externalUrl: Boolean(externalBaseUrl),
                httpsRequired: Boolean(externalBaseUrl),
                localOriginAllowed: ownsServer && isLocalhostUrl(baseUrl),
                secureContext: originState.isSecureContext,
            },
            chromiumInstallabilityState,
            metadata: {
                manifestDisplay: metadata.manifest.display,
                screenshots: metadata.manifest.screenshots?.length || 0,
                icons: metadata.manifest.icons?.length || 0,
                shortcuts: metadata.manifest.shortcuts?.length || 0,
            },
            offlineDeviceCheckState,
            offlineFallbackState,
            offlineState,
            onlineDeviceCheckState,
            offlineConsoleProblems,
            originState,
            resourceState,
            serviceWorker,
            status: "passed",
        }, null, 2));
    } finally {
        await context.setOffline(false).catch(() => undefined);
        await browser.close().catch(() => undefined);
        await closeServer(server);
    }
}

runSmoke().catch(async error => {
    console.error(error);
    process.exitCode = 1;
});
