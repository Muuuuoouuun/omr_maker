import { spawn } from "node:child_process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices } from "@playwright/test";

const port = Number(process.env.PWA_SMOKE_PORT || 3004);
const externalBaseUrl = process.env.PWA_SMOKE_BASE_URL?.replace(/\/$/, "");
const baseUrl = externalBaseUrl || `http://localhost:${port}`;
const ownsServer = !externalBaseUrl;
const expectedCachePrefix = "omr-maker-v14";
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

function expectedHandoffOriginReport() {
    return externalBaseUrl ? "handoff-origin=pass:공유 가능" : "handoff-origin=warn:로컬 전용";
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
    const nextCliPath = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
    const child = spawn(process.execPath, [nextCliPath, "start", "-p", String(port)], {
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
            appleStartupImages: [...document.querySelectorAll('link[rel="apple-touch-startup-image"]')]
                .map(link => ({
                    href: link.getAttribute("href") || "",
                    media: link.getAttribute("media") || "",
                })),
            manifest,
            manifestHref,
            mobileCapable: [...document.querySelectorAll('meta[name="mobile-web-app-capable"]')]
                .map(meta => meta.getAttribute("content")),
            title: document.title,
            viewport: document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "",
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

async function collectImageState(page, imageSpecs = requiredImageSpecs) {
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
    }, imageSpecs);
}

async function collectCacheState(page) {
    return page.evaluate(async expectedCachePrefix => {
        const keys = await caches.keys();
        return {
            cachedHome: Boolean(await caches.match("/")),
            cachedLogo: Boolean(await caches.match("/logo.png")),
            cachedMobileSolve: Boolean(await caches.match("/solve/mobile-pwa-smoke-exam")),
            cachedOffline: Boolean(await caches.match("/offline.html")),
            cachedPwaCheck: Boolean(await caches.match("/pwa-check")),
            cacheKeys: keys,
            expectedCacheKeys: keys.filter(key => key.startsWith(expectedCachePrefix)),
        };
    }, expectedCachePrefix);
}

async function seedOfflineSolveExam(page) {
    await page.evaluate(() => {
        const exam = {
            id: "mobile-pwa-smoke-exam",
            title: "모바일 오프라인 시험",
            createdAt: "2026-06-22T00:00:00.000Z",
            durationMin: 20,
            questions: [
                { id: 1, number: 1, answer: 2, choices: 4, score: 50 },
                { id: 2, number: 2, answer: 4, choices: 4, score: 50 },
            ],
            updatedAt: "2026-06-22T00:00:00.000Z",
            accessConfig: { type: "public" },
        };
        const studentSession = {
            groupId: "mobile-pwa-smoke-group",
            groupName: "모바일반",
            identityType: "temporary",
            isGuest: false,
            name: "모바일학생",
            studentId: "mobile-pwa-smoke-student",
            createdAt: "2026-06-22T00:00:00.000Z",
        };
        const sessionPayload = JSON.stringify(studentSession);
        localStorage.setItem("omr_exam_mobile-pwa-smoke-exam", JSON.stringify(exam));
        localStorage.setItem("omr_student_session_backup", sessionPayload);
        sessionStorage.setItem("omr_student_session", sessionPayload);
        localStorage.setItem("omr_solve_panel_mobile-pwa-smoke-exam_mobile-pwa-smoke-student", "expanded");
    });
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
        assert(metadata.viewport.includes("interactive-widget=resizes-content"), "Viewport must ask mobile keyboards to resize app content", metadata);
        assert(metadata.appleIcon === "/apple-touch-icon.png", "Apple touch icon is missing or incorrect", metadata);
        assert(metadata.mobileCapable.every(value => value === "yes") && metadata.mobileCapable.length > 0, "Android mobile app metadata is missing", metadata);
        assert(metadata.appleCapable.every(value => value === "yes") && metadata.appleCapable.length > 0, "iOS web app metadata is missing", metadata);
        assert(metadata.appleStartupImages.length >= 12, "iOS startup image links are missing", metadata.appleStartupImages);
        assert(metadata.appleStartupImages.every(image => image.href.startsWith("/startup/")), "iOS startup images must be served from /startup", metadata.appleStartupImages);
        assert(
            metadata.appleStartupImages.some(image => image.media.includes("device-width: 393px") && image.media.includes("orientation: portrait"))
                && metadata.appleStartupImages.some(image => image.media.includes("device-width: 834px") && image.media.includes("orientation: landscape")),
            "iOS startup images must include modern iPhone portrait and iPad landscape media queries",
            metadata.appleStartupImages,
        );
        assert(metadata.manifest?.name === "OMR Maker", "Manifest name is incorrect", metadata.manifest);
        assert(metadata.manifest?.short_name === "OMR Maker", "Manifest short_name is incorrect", metadata.manifest);
        assert(metadata.manifest?.id === "/", "Manifest id is incorrect", metadata.manifest);
        assert(metadata.manifest?.start_url === "/", "Manifest start_url is incorrect", metadata.manifest);
        assert(metadata.manifest?.scope === "/", "Manifest scope is incorrect", metadata.manifest);
        assert(metadata.manifest?.lang === "ko", "Manifest lang is incorrect", metadata.manifest);
        assert(metadata.manifest?.display === "standalone", "Manifest display must be standalone", metadata.manifest);
        assert(metadata.manifest?.display_override?.includes("standalone"), "Manifest display_override should include standalone", metadata.manifest);
        assert(metadata.manifest?.launch_handler?.client_mode?.includes("navigate-existing"), "Manifest launch handler should reuse the installed app window", metadata.manifest);
        assert(metadata.manifest?.launch_handler?.client_mode?.includes("auto"), "Manifest launch handler should keep a browser fallback", metadata.manifest);
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
        const startupImageSpecs = metadata.appleStartupImages.map(image => {
            const pathname = new URL(image.href, baseUrl).pathname;
            const match = pathname.match(/-(\d+)x(\d+)-(?:portrait|landscape)\.png$/);
            assert(match, "iOS startup image filename must include rendered dimensions", image);

            return {
                height: Number(match[2]),
                src: pathname,
                width: Number(match[1]),
            };
        });
        const startupImageState = await collectImageState(page, startupImageSpecs);
        imageState.forEach(image => {
            assert(image.loaded, "PWA image asset failed to load", image);
            assert(
                image.actualWidth === image.width && image.actualHeight === image.height,
                "PWA image dimensions do not match their manifest/install contract",
                image,
            );
        });
        startupImageState.forEach(image => {
            assert(image.loaded, "iOS startup image asset failed to load", image);
            assert(
                image.actualWidth === image.width && image.actualHeight === image.height,
                "iOS startup image dimensions do not match their media contract",
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
            installProofGuide: document.querySelector('[data-testid="pwa-install-proof-guide"]')?.textContent || "",
            proofVerifier: document.querySelector('[data-testid="pwa-proof-verifier"]')?.textContent || "",
            report: document.querySelector('[data-testid="pwa-device-report"]')?.textContent || "",
            verdict: document.querySelector('[data-testid="pwa-device-verdict"]')?.textContent || "",
        }));
        assert(!onlineDeviceCheckState.hasHorizontalOverflow, "Online PWA device check has horizontal overflow", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.handoffUrl.includes("/pwa-check"), "PWA device check handoff URL is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("OMR Maker PWA device check"), "PWA device check report is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("checkedAtEpoch="), "PWA device check freshness timestamp is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("displayEvidence="), "PWA device check display evidence is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("installedDisplay=no"), "PWA device check installed display proof flag is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("proofStatus=pending"), "PWA device check proof status is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("launch-proof="), "PWA device check launch proof is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes(expectedHandoffOriginReport()), "PWA device check handoff URL readiness is incorrect", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("service-worker=pass:제어 중"), "PWA device check service worker control proof is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("controller=yes"), "PWA device check service worker controller evidence is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("offline-cache=pass:준비"), "PWA device check offline cache readiness is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("storage=pass:사용 가능"), "PWA device check storage readiness is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("indexedDB ok"), "PWA device check IndexedDB readiness is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("runtime-performance="), "PWA device check runtime performance proof is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("budget=3000/5000ms"), "PWA device check runtime performance budget evidence is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("viewport-height=pass:동기화"), "PWA device check viewport height sync is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.report.includes("keyboard-safe-area=pass:준비"), "PWA device check keyboard safe area is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.installProofGuide.includes("실기기 설치 확인"), "PWA install proof guide is missing", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.installProofGuide.includes("Android") && onlineDeviceCheckState.installProofGuide.includes("iOS"), "PWA install proof guide must cover Android and iOS", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.installProofGuide.includes("standalone") && onlineDeviceCheckState.installProofGuide.includes("fullscreen"), "PWA install proof guide must name installed display modes", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.proofVerifier.includes("Android") && onlineDeviceCheckState.proofVerifier.includes("iOS"), "PWA proof verifier must collect Android and iOS reports", onlineDeviceCheckState);
        assert(onlineDeviceCheckState.proofVerifier.includes("자동 저장") && onlineDeviceCheckState.proofVerifier.includes("입력 지우기"), "PWA proof verifier must persist and clear collected reports", onlineDeviceCheckState);

        await seedOfflineSolveExam(page);
        await page.goto("/solve/mobile-pwa-smoke-exam", { waitUntil: "networkidle" });
        await page.locator(".solve-omr-scroll .omr-cardview-title").getByText("모바일 오프라인 시험").waitFor({ state: "visible", timeout: 10_000 });
        await page.getByRole("button", { name: "문제 1번 보기 2" }).click();
        await page.waitForFunction(() => {
            const draft = JSON.parse(localStorage.getItem("omr_draft_mobile-pwa-smoke-exam_mobile-pwa-smoke-student") || "{}");
            return draft.answers?.["1"] === 2;
        }, null, { timeout: 10_000 });
        const onlineSolveState = await page.evaluate(() => ({
            draftAnswer: JSON.parse(localStorage.getItem("omr_draft_mobile-pwa-smoke-exam_mobile-pwa-smoke-student") || "{}").answers?.["1"],
            hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            markedAnswers: [...document.querySelectorAll(".q-bubble.marked")].map(item => item.getAttribute("aria-label")),
            title: document.querySelector(".solve-omr-scroll .omr-cardview-title")?.textContent || "",
            url: window.location.href,
        }));
        assert(onlineSolveState.title.includes("모바일 오프라인 시험"), "Online mobile solve route did not render", onlineSolveState);
        assert(onlineSolveState.draftAnswer === 2, "Online mobile solve draft was not saved before offline test", onlineSolveState);
        assert(onlineSolveState.markedAnswers.includes("문제 1번 보기 2"), "Online mobile solve answer mark is missing", onlineSolveState);
        assert(!onlineSolveState.hasHorizontalOverflow, "Online mobile solve route has horizontal overflow", onlineSolveState);

        const cacheState = await collectCacheState(page);
        assert(cacheState.expectedCacheKeys.length >= 1, "Expected PWA cache was not created", cacheState);
        assert(
            cacheState.cachedHome && cacheState.cachedOffline && cacheState.cachedLogo && cacheState.cachedPwaCheck && cacheState.cachedMobileSolve,
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
            installProofGuide: document.querySelector('[data-testid="pwa-install-proof-guide"]')?.textContent || "",
            proofVerifier: document.querySelector('[data-testid="pwa-proof-verifier"]')?.textContent || "",
            report: document.querySelector('[data-testid="pwa-device-report"]')?.textContent || "",
            url: window.location.href,
            verdict: document.querySelector('[data-testid="pwa-device-verdict"]')?.textContent || "",
        }));
        assert(!offlineDeviceCheckState.hasHorizontalOverflow, "Offline PWA device check has horizontal overflow", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("OMR Maker PWA device check"), "Offline PWA device check report is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("checkedAtEpoch="), "Offline PWA device check freshness timestamp is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("displayEvidence="), "Offline PWA device check display evidence is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("installedDisplay=no"), "Offline PWA device check installed display proof flag is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("proofStatus=pending"), "Offline PWA device check proof status is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("launch-proof="), "Offline PWA device check launch proof is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes(expectedHandoffOriginReport()), "Offline PWA device check handoff URL readiness is incorrect", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("service-worker=pass:제어 중"), "Offline PWA device check service worker control proof is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("controller=yes"), "Offline PWA device check service worker controller evidence is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("offline-cache=pass:준비"), "Offline PWA device check offline cache readiness is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("storage=pass:사용 가능"), "Offline PWA device check storage readiness is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("indexedDB ok"), "Offline PWA device check IndexedDB readiness is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("runtime-performance="), "Offline PWA device check runtime performance proof is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("budget=3000/5000ms"), "Offline PWA device check runtime performance budget evidence is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("viewport-height=pass:동기화"), "Offline PWA device check viewport height sync is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.report.includes("keyboard-safe-area=pass:준비"), "Offline PWA device check keyboard safe area is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.installProofGuide.includes("실기기 설치 확인"), "Offline PWA install proof guide is missing", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.installProofGuide.includes("Android") && offlineDeviceCheckState.installProofGuide.includes("iOS"), "Offline PWA install proof guide must cover Android and iOS", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.installProofGuide.includes("standalone") && offlineDeviceCheckState.installProofGuide.includes("fullscreen"), "Offline PWA install proof guide must name installed display modes", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.proofVerifier.includes("Android") && offlineDeviceCheckState.proofVerifier.includes("iOS"), "Offline PWA proof verifier must collect Android and iOS reports", offlineDeviceCheckState);
        assert(offlineDeviceCheckState.proofVerifier.includes("자동 저장") && offlineDeviceCheckState.proofVerifier.includes("입력 지우기"), "Offline PWA proof verifier must persist and clear collected reports", offlineDeviceCheckState);

        await page.goto("/solve/mobile-pwa-smoke-exam", { waitUntil: "domcontentloaded", timeout: 15_000 });
        await page.locator(".solve-omr-scroll .omr-cardview-title").getByText("모바일 오프라인 시험").waitFor({ state: "visible", timeout: 10_000 });
        const offlineSolveState = await page.evaluate(() => ({
            hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
            markedAnswers: [...document.querySelectorAll(".q-bubble.marked")].map(item => item.getAttribute("aria-label")),
            title: document.querySelector(".solve-omr-scroll .omr-cardview-title")?.textContent || "",
            url: window.location.href,
        }));
        assert(offlineSolveState.title.includes("모바일 오프라인 시험"), "Offline mobile solve route did not render from cache", offlineSolveState);
        assert(offlineSolveState.markedAnswers.includes("문제 1번 보기 2"), "Offline mobile solve route did not restore the draft answer", offlineSolveState);
        assert(!offlineSolveState.hasHorizontalOverflow, "Offline mobile solve route has horizontal overflow", offlineSolveState);

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
                launchHandler: metadata.manifest.launch_handler?.client_mode || [],
                startupImages: metadata.appleStartupImages.length,
                screenshots: metadata.manifest.screenshots?.length || 0,
                icons: metadata.manifest.icons?.length || 0,
                shortcuts: metadata.manifest.shortcuts?.length || 0,
            },
            offlineDeviceCheckState,
            offlineFallbackState,
            offlineSolveState,
            offlineState,
            onlineDeviceCheckState,
            onlineSolveState,
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
