import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import vm from "node:vm";
import { inflateSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import manifest from "@/app/manifest";
import { PWA_STARTUP_IMAGES } from "@/lib/pwaStartupImages";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function publicPathExists(assetPath: string): boolean {
    return existsSync(path.join(publicDir, assetPath.replace(/^\//, "")));
}

function getServiceWorkerAppShellAssets(): string[] {
    const sw = getServiceWorkerSource();
    const match = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
    if (!match) return [];

    return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]);
}

function getServiceWorkerSource(): string {
    return readFileSync(path.join(publicDir, "sw.js"), "utf8");
}

function getOfflinePageSource(): string {
    return readFileSync(path.join(publicDir, "offline.html"), "utf8");
}

function getPwaRegisterSource(): string {
    return readFileSync(path.join(rootDir, "src/components/PWARegister.tsx"), "utf8");
}

function getPwaSmokeSource(): string {
    return readFileSync(path.join(rootDir, "scripts/pwa-prod-smoke.mjs"), "utf8");
}

function getPwaProofSource(): string {
    return readFileSync(path.join(rootDir, "scripts/pwa-proof-verify.mjs"), "utf8");
}

function getPwaCheckPageSource(): string {
    return readFileSync(path.join(rootDir, "src/app/pwa-check/page.tsx"), "utf8");
}

function getRootLayoutSource(): string {
    return readFileSync(path.join(rootDir, "src/app/layout.tsx"), "utf8");
}

function readImageSize(assetPath: string): { width: number; height: number } {
    const buffer = readFileSync(path.join(publicDir, assetPath.replace(/^\//, "")));

    if (buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") {
        return {
            width: buffer.readUInt32BE(16),
            height: buffer.readUInt32BE(20),
        };
    }

    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
        let offset = 2;
        while (offset < buffer.length) {
            if (buffer[offset] !== 0xff) {
                offset += 1;
                continue;
            }

            const marker = buffer[offset + 1];
            const length = buffer.readUInt16BE(offset + 2);
            const isStartOfFrame = (
                (marker >= 0xc0 && marker <= 0xc3)
                || (marker >= 0xc5 && marker <= 0xc7)
                || (marker >= 0xc9 && marker <= 0xcb)
                || (marker >= 0xcd && marker <= 0xcf)
            );

            if (isStartOfFrame) {
                return {
                    width: buffer.readUInt16BE(offset + 7),
                    height: buffer.readUInt16BE(offset + 5),
                };
            }

            offset += 2 + length;
        }
    }

    throw new Error(`Unsupported image format: ${assetPath}`);
}

function paethPredictor(left: number, above: number, upperLeft: number): number {
    const estimate = left + above - upperLeft;
    const distanceLeft = Math.abs(estimate - left);
    const distanceAbove = Math.abs(estimate - above);
    const distanceUpperLeft = Math.abs(estimate - upperLeft);

    if (distanceLeft <= distanceAbove && distanceLeft <= distanceUpperLeft) return left;
    if (distanceAbove <= distanceUpperLeft) return above;
    return upperLeft;
}

function readAlphaStats(projectPath: string): { opaquePixels: number; partialPixels: number; transparentPixels: number } {
    const buffer = readFileSync(path.join(rootDir, projectPath));
    if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw new Error(`Unsupported alpha stats image format: ${projectPath}`);
    }

    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    let interlace = 0;
    const idatParts: Buffer[] = [];

    let offset = PNG_SIGNATURE.length;
    while (offset < buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString("ascii", offset + 4, offset + 8);
        const dataStart = offset + 8;
        const dataEnd = dataStart + length;

        if (type === "IHDR") {
            width = buffer.readUInt32BE(dataStart);
            height = buffer.readUInt32BE(dataStart + 4);
            bitDepth = buffer[dataStart + 8];
            colorType = buffer[dataStart + 9];
            interlace = buffer[dataStart + 12];
        }
        if (type === "IDAT") idatParts.push(buffer.subarray(dataStart, dataEnd));
        if (type === "IEND") break;

        offset = dataEnd + 4;
    }

    if (bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
        throw new Error(`Unsupported PNG alpha layout: ${projectPath}`);
    }

    const inflated = inflateSync(Buffer.concat(idatParts));
    const bytesPerPixel = 4;
    const rowByteLength = width * bytesPerPixel;
    let inflatedOffset = 0;
    let previousAlphaRow = new Uint8Array(width);
    let opaquePixels = 0;
    let transparentPixels = 0;

    for (let row = 0; row < height; row += 1) {
        const filter = inflated[inflatedOffset];
        const rowStart = inflatedOffset + 1;
        const currentAlphaRow = new Uint8Array(width);

        for (let column = 0; column < width; column += 1) {
            const rawAlpha = inflated[rowStart + column * bytesPerPixel + 3];
            const left = column > 0 ? currentAlphaRow[column - 1] : 0;
            const above = previousAlphaRow[column] || 0;
            const upperLeft = column > 0 ? previousAlphaRow[column - 1] : 0;
            let alpha: number;

            if (filter === 0) alpha = rawAlpha;
            else if (filter === 1) alpha = rawAlpha + left;
            else if (filter === 2) alpha = rawAlpha + above;
            else if (filter === 3) alpha = rawAlpha + Math.floor((left + above) / 2);
            else if (filter === 4) alpha = rawAlpha + paethPredictor(left, above, upperLeft);
            else throw new Error(`Unsupported PNG filter ${filter} in ${projectPath}`);

            alpha &= 0xff;
            currentAlphaRow[column] = alpha;
            if (alpha === 0) transparentPixels += 1;
            if (alpha === 255) opaquePixels += 1;
        }

        previousAlphaRow = currentAlphaRow;
        inflatedOffset = rowStart + rowByteLength;
    }

    const totalPixels = width * height;
    return {
        opaquePixels,
        partialPixels: totalPixels - opaquePixels - transparentPixels,
        transparentPixels,
    };
}

function manifestScreenshotPaths(): string[] {
    const currentManifest = manifest();
    return (currentManifest.screenshots || []).map(screenshot => screenshot.src);
}

function manifestScreenshotSpecs() {
    const currentManifest = manifest();
    return currentManifest.screenshots || [];
}

type SizedManifestAsset = { sizes: string; src: string };

function expectSizedManifestAsset(asset: { sizes?: string; src: string }): asserts asset is SizedManifestAsset {
    expect(asset.sizes).toMatch(/^\d+x\d+$/);
}

function assertImageSizeMatchesSpec(asset: { src: string; sizes: string }) {
    const [width, height] = asset.sizes.split("x").map(Number);

    return {
        actual: readImageSize(asset.src),
        expected: { width, height },
    };
}

function manifestIconPaths(): string[] {
    const currentManifest = manifest();
    const iconPaths = (currentManifest.icons || [])
        .map(icon => typeof icon === "string" ? icon : icon.src);
    const shortcutIconPaths = (currentManifest.shortcuts || [])
        .flatMap(shortcut => shortcut.icons || [])
        .map(icon => icon.src);

    return [...iconPaths, ...shortcutIconPaths];
}

function startupImagePaths(): string[] {
    return PWA_STARTUP_IMAGES.map(image => image.url);
}

function createServiceWorkerHarness() {
    const origin = "https://omr-maker.test";
    const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
    const stores = new Map<string, Map<string, Response>>();
    let networkFetch: (request: { url: string }) => Promise<Response> = async request => (
        new Response(`network:${new URL(request.url).pathname}`)
    );

    function toAbsoluteUrl(request: string | { url: string }): string {
        if (typeof request === "string") return new URL(request, origin).href;
        return request.url;
    }

    const caches = {
        open: async (name: string) => {
            if (!stores.has(name)) stores.set(name, new Map());
            const store = stores.get(name);
            if (!store) throw new Error(`Missing cache ${name}`);

            return {
                addAll: async (assets: string[]) => {
                    assets.forEach(asset => {
                        const url = new URL(asset, origin).href;
                        store.set(url, new Response(`cached:${asset}`));
                    });
                },
                put: async (request: { url: string }, response: Response) => {
                    store.set(request.url, response.clone());
                },
                keys: async () => [...store.keys()].map(url => ({ url })),
            };
        },
        keys: async () => [...stores.keys()],
        delete: async (name: string) => stores.delete(name),
        match: async (request: string | { url: string }) => {
            const url = toAbsoluteUrl(request);
            for (const store of stores.values()) {
                const match = store.get(url);
                if (match) return match.clone();
            }
            return undefined;
        },
    };

    const self = {
        location: { origin },
        clients: { claim: vi.fn(() => Promise.resolve()) },
        skipWaiting: vi.fn(() => Promise.resolve()),
        addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
            const current = listeners.get(type) || [];
            current.push(listener);
            listeners.set(type, current);
        },
    };

    vm.runInNewContext(getServiceWorkerSource(), {
        URL,
        Response,
        Set,
        Promise,
        console,
        caches,
        fetch: (request: { url: string }) => networkFetch(request),
        self,
    });

    async function dispatchInstall() {
        const waits: Array<Promise<unknown>> = [];
        listeners.get("install")?.forEach(listener => {
            listener({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
        });
        await Promise.all(waits);
    }

    async function dispatchActivate() {
        const waits: Array<Promise<unknown>> = [];
        listeners.get("activate")?.forEach(listener => {
            listener({ waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
        });
        await Promise.all(waits);
    }

    async function dispatchFetch(pathname: string, options: { mode?: string; method?: string } = {}) {
        const responses: Array<Promise<Response>> = [];
        const waits: Array<Promise<unknown>> = [];
        const request = {
            method: options.method || "GET",
            mode: options.mode || "same-origin",
            url: new URL(pathname, origin).href,
        };
        listeners.get("fetch")?.forEach(listener => {
            listener({
                request,
                respondWith: (promise: Promise<Response>) => responses.push(promise),
                waitUntil: (promise: Promise<unknown>) => waits.push(promise),
            });
        });

        if (responses.length === 0) return null;
        return responses[0].then(async response => {
            await Promise.all(waits);
            return response;
        });
    }

    async function dispatchMessage(data: unknown) {
        const waits: Array<Promise<unknown>> = [];
        listeners.get("message")?.forEach(listener => {
            listener({ data, waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
        });
        await Promise.all(waits);
    }

    return {
        caches,
        dispatchActivate,
        dispatchFetch,
        dispatchInstall,
        dispatchMessage,
        setNetworkFetch: (nextFetch: typeof networkFetch) => {
            networkFetch = nextFetch;
        },
        self,
    };
}

describe("PWA assets", () => {
    it("manifest declares the installable app contract", () => {
        const currentManifest = manifest();

        expect(currentManifest.name).toBe("OMR Maker");
        expect(currentManifest.short_name).toBe("OMR Maker");
        expect(currentManifest.id).toBe("/");
        expect(currentManifest.start_url).toBe("/");
        expect(currentManifest.scope).toBe("/");
        expect(currentManifest.display).toBe("standalone");
        expect(currentManifest.orientation).toBe("portrait");
        expect(currentManifest.lang).toBe("ko");
        expect(currentManifest.categories).toContain("education");
        expect(currentManifest.launch_handler.client_mode).toEqual(
            expect.arrayContaining(["navigate-existing", "auto"]),
        );
        expect(currentManifest.shortcuts?.length).toBeGreaterThanOrEqual(4);
        expect(currentManifest.shortcuts?.map(shortcut => shortcut.url)).toEqual(
            expect.arrayContaining(["/create", "/teacher/dashboard", "/?role=student", "/pwa-check"]),
        );
        currentManifest.shortcuts?.forEach(shortcut => {
            expect(shortcut.url.startsWith("/")).toBe(true);
            expect(shortcut.icons?.every(icon => publicPathExists(icon.src))).toBe(true);
        });
    });

    it("precache shell references only generated routes or existing public assets", () => {
        const generatedRoutes = new Set(["/", "/pwa-check", "/favicon.ico", "/icon.png", "/manifest.webmanifest"]);
        const missing = getServiceWorkerAppShellAssets()
            .filter(asset => !generatedRoutes.has(asset))
            .filter(asset => !publicPathExists(asset));

        expect(missing).toEqual([]);
    });

    it("precache shell includes install and offline critical assets", () => {
        const appShell = new Set(getServiceWorkerAppShellAssets());
        const requiredShellAssets = [
            "/",
            "/pwa-check",
            "/offline.html",
            "/manifest.webmanifest",
            "/favicon.ico",
            "/icon.png",
            "/logo.png",
            "/apple-touch-icon.png",
            "/browserconfig.xml",
            ...manifestIconPaths(),
            ...manifestScreenshotPaths(),
        ];

        const missing = [...new Set(requiredShellAssets)]
            .filter(asset => asset.startsWith("/"))
            .filter(asset => !appShell.has(asset));

        expect(missing).toEqual([]);
    });

    it("layout advertises mobile app install metadata for Android and iOS", () => {
        const layout = getRootLayoutSource();

        expect(layout).toContain('manifest: "/manifest.webmanifest"');
        expect(layout).toContain("appleWebApp");
        expect(layout).toContain("capable: true");
        expect(layout).toContain("startupImage: PWA_STARTUP_IMAGE_LINKS");
        expect(layout).toContain('{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }');
        expect(layout).toContain('"mobile-web-app-capable": "yes"');
        expect(layout).toContain('"apple-mobile-web-app-capable": "yes"');
        expect(layout).toContain('"apple-mobile-web-app-title": "OMR Maker"');
        expect(layout).toContain('"msapplication-config": "/browserconfig.xml"');
    });

    it("manifest icon files exist in public", () => {
        const missing = manifestIconPaths()
            .filter(src => src.startsWith("/"))
            .filter(src => !publicPathExists(src));

        expect(missing).toEqual([]);
    });

    it("manifest includes installable app icons with expected dimensions", () => {
        const icons = manifest().icons || [];
        const iconSpecs = icons.filter(icon => typeof icon !== "string");
        const maskableIcon = iconSpecs.find(icon => icon.purpose === "maskable");

        expect(maskableIcon?.src).toBe("/icons/maskable-icon-512.png");
        expect(iconSpecs.some(icon => icon.sizes === "192x192")).toBe(true);
        expect(iconSpecs.some(icon => icon.sizes === "512x512")).toBe(true);

        iconSpecs.forEach(icon => {
            expectSizedManifestAsset(icon);
            const [width, height] = icon.sizes.split("x").map(Number);
            expect(readImageSize(icon.src)).toEqual({ width, height });
        });
    });

    it("keeps browser-facing icons transparent while launcher safety icons stay opaque", async () => {
        const transparentTargets = [
            "public/logo.png",
            "src/app/icon.png",
            "public/icons/icon-512.png",
        ];
        const opaqueLauncherTargets = [
            "public/apple-touch-icon.png",
            "public/icons/apple-touch-icon.png",
            "public/icons/maskable-icon-512.png",
            "public/icons/mstile-150.png",
        ];

        for (const target of transparentTargets) {
            const stats = await readAlphaStats(target);
            expect(stats.transparentPixels).toBeGreaterThan(0);
            expect(stats.opaquePixels).toBeGreaterThan(stats.transparentPixels);
        }

        for (const target of opaqueLauncherTargets) {
            const stats = await readAlphaStats(target);
            expect(stats.transparentPixels).toBe(0);
            expect(stats.partialPixels).toBe(0);
        }
    });

    it("provides iOS startup images for phone and tablet home-screen launch", () => {
        const startupPaths = startupImagePaths();

        expect(PWA_STARTUP_IMAGES.length).toBeGreaterThanOrEqual(12);
        expect(new Set(startupPaths).size).toBe(PWA_STARTUP_IMAGES.length);
        expect(PWA_STARTUP_IMAGES.some(image => image.cssWidth === 393 && image.orientation === "portrait")).toBe(true);
        expect(PWA_STARTUP_IMAGES.some(image => image.cssWidth === 834 && image.orientation === "landscape")).toBe(true);
        expect(PWA_STARTUP_IMAGES.every(image => image.media.includes(`orientation: ${image.orientation}`))).toBe(true);
        expect(PWA_STARTUP_IMAGES.every(image => image.media.includes(`device-width: ${image.cssWidth}px`))).toBe(true);
        expect(PWA_STARTUP_IMAGES.every(image => publicPathExists(image.url))).toBe(true);

        PWA_STARTUP_IMAGES.forEach(image => {
            expect(image.url).toMatch(/\/startup\/.+-\d+x\d+-(portrait|landscape)\.png$/);
            expect(readImageSize(image.url)).toEqual({ width: image.width, height: image.height });
        });
    });

    it("manifest includes app screenshots for richer Android install previews", () => {
        const screenshots = manifestScreenshotSpecs();

        expect(screenshots).toHaveLength(2);
        expect(screenshots.map(screenshot => screenshot.form_factor).sort()).toEqual(["narrow", "wide"]);
        expect(screenshots.every(screenshot => screenshot.type === "image/jpeg")).toBe(true);
        expect(screenshots.every(screenshot => publicPathExists(screenshot.src))).toBe(true);
        screenshots.forEach(screenshot => {
            expect(screenshot.label?.length).toBeGreaterThan(12);
            expectSizedManifestAsset(screenshot);
            const dimensions = assertImageSizeMatchesSpec(screenshot);
            expect(dimensions.actual).toEqual(dimensions.expected);
        });
    });

    it("service worker serves app shell assets from cache when offline", () => {
        const sw = getServiceWorkerSource();

        expect(sw).toContain("CACHE_FIRST_PATHS.has(url.pathname)");
        expect(sw).toContain('const CACHE_VERSION = "omr-maker-v15"');
        expect(sw).toContain("canRememberNavigation(url.pathname)");
        expect(sw).toContain("NAVIGATION_CACHE_PATHS");
        expect(sw).toContain("NAVIGATION_CACHE_PREFIXES");
        expect(sw).toContain('pathname.startsWith(prefix)');
        expect(sw).toContain('"/student/dashboard"');
        expect(sw).toContain('"/student/history"');
        expect(sw).toContain('"/solve/"');
        expect(sw).toContain('"/student/review/"');
        expect(sw).toContain("readNavigationFallback(request, url)");
        expect(sw).toContain('url.pathname.startsWith("/startup/")');
        expect(sw).toContain("if (!response.ok) return");
        expect(sw).toContain(".catch(() => undefined)");
        expect(sw).toContain("caches.match(url.pathname)");
        expect(sw).toContain("caches.match(\"/\")");
        expect(sw).toContain("caches.match(\"/pwa-check\")");
        expect(sw).toContain("caches.match(\"/offline.html\")");
        expect(sw).toContain("OMR_SKIP_WAITING");
        [
            "/offline.html",
            "/manifest.webmanifest",
            "/favicon.ico",
            "/icon.png",
            "/logo.png",
            "/apple-touch-icon.png",
            "/browserconfig.xml",
            "/pdf.worker.min.mjs",
            "/screenshots/omr-mobile-home.jpg",
            "/screenshots/omr-wide-home.jpg",
        ].forEach(asset => {
            expect(sw).toContain(`"${asset}"`);
        });
    });

    it("offline page is mobile-safe and gives users reconnect and app return actions", () => {
        const offlinePage = getOfflinePageSource();

        expect(offlinePage).toContain("viewport-fit=cover");
        expect(offlinePage).toContain("min-height: 100dvh");
        expect(offlinePage).toContain("box-sizing: border-box");
        expect(offlinePage).toContain("min-height: 44px");
        expect(offlinePage).toContain("touch-action: manipulation");
        expect(offlinePage).toContain("<img src=\"/logo.png\"");
        expect(offlinePage).toContain("aria-label=\"오프라인 빠른 이동\"");
        expect(offlinePage).toContain("href=\"/\"");
        expect(offlinePage).toContain("href=\"/pwa-check\"");
        expect(offlinePage).toContain("홈으로");
        expect(offlinePage).toContain("앱 상태 체크");
        expect(offlinePage).toContain("window.location.reload()");
        expect(offlinePage).toContain("다시 연결 시도");
    });

    it("service worker precaches the app shell during install", async () => {
        const harness = createServiceWorkerHarness();

        await harness.dispatchInstall();

        expect(await harness.caches.keys()).toContain("omr-maker-v15-shell");
        expect(harness.self.skipWaiting).toHaveBeenCalledOnce();
        await expect(harness.caches.match("/pwa-check")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/offline.html")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/favicon.ico")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/icon.png")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/screenshots/omr-mobile-home.jpg")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/screenshots/omr-wide-home.jpg")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/icons/maskable-icon-512.png")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/pdf.worker.min.mjs")).resolves.toBeUndefined();
    });

    it("service worker caches the PDF worker only after its first use", async () => {
        const harness = createServiceWorkerHarness();

        await harness.dispatchInstall();
        await expect(harness.caches.match("/pdf.worker.min.mjs")).resolves.toBeUndefined();

        const response = await harness.dispatchFetch("/pdf.worker.min.mjs");

        await expect(response?.text()).resolves.toBe("network:/pdf.worker.min.mjs");
        await expect(harness.caches.match("/pdf.worker.min.mjs")).resolves.toBeInstanceOf(Response);
    });

    it("service worker removes older PWA caches when the app shell version changes", async () => {
        const harness = createServiceWorkerHarness();
        await harness.caches.open("omr-maker-v10-shell");
        await harness.caches.open("omr-maker-v10-runtime");

        await harness.dispatchInstall();
        await harness.dispatchActivate();

        expect(await harness.caches.keys()).toEqual(
            expect.arrayContaining(["omr-maker-v15-shell"]),
        );
        expect(await harness.caches.keys()).not.toEqual(
            expect.arrayContaining(["omr-maker-v10-shell", "omr-maker-v10-runtime"]),
        );
    });

    it("service worker returns cached assets and offline navigation fallback when network fails", async () => {
        const harness = createServiceWorkerHarness();
        await harness.dispatchInstall();
        await harness.dispatchActivate();
        harness.setNetworkFetch(async () => {
            throw new Error("offline");
        });

        const logoResponse = await harness.dispatchFetch("/logo.png");
        const navigationResponse = await harness.dispatchFetch("/teacher/dashboard", { mode: "navigate" });

        await expect(logoResponse?.text()).resolves.toBe("cached:/logo.png");
        await expect(navigationResponse?.text()).resolves.toBe("cached:/offline.html");
    });

    it("service worker reuses cached home for offline student shortcut launches", async () => {
        const harness = createServiceWorkerHarness();
        await harness.dispatchInstall();
        await harness.dispatchActivate();
        harness.setNetworkFetch(async () => {
            throw new Error("offline");
        });

        const navigationResponse = await harness.dispatchFetch("/?role=student", { mode: "navigate" });

        await expect(navigationResponse?.text()).resolves.toBe("cached:/");
    });

    it("service worker reuses cached device check for offline install proof launches", async () => {
        const harness = createServiceWorkerHarness();
        await harness.dispatchInstall();
        await harness.dispatchActivate();
        harness.setNetworkFetch(async () => {
            throw new Error("offline");
        });

        const navigationResponse = await harness.dispatchFetch("/pwa-check", { mode: "navigate" });

        await expect(navigationResponse?.text()).resolves.toBe("cached:/pwa-check");
    });

    it("service worker reuses cached student app pages for offline installed launches", async () => {
        const harness = createServiceWorkerHarness();
        await harness.dispatchInstall();
        await harness.dispatchActivate();

        const solveResponse = await harness.dispatchFetch("/solve/mobile-qa-exam", { mode: "navigate" });
        const dashboardResponse = await harness.dispatchFetch("/student/dashboard", { mode: "navigate" });
        const historyResponse = await harness.dispatchFetch("/student/history", { mode: "navigate" });
        const reviewResponse = await harness.dispatchFetch("/student/review/attempt-1", { mode: "navigate" });

        await expect(solveResponse?.text()).resolves.toBe("network:/solve/mobile-qa-exam");
        await expect(dashboardResponse?.text()).resolves.toBe("network:/student/dashboard");
        await expect(historyResponse?.text()).resolves.toBe("network:/student/history");
        await expect(reviewResponse?.text()).resolves.toBe("network:/student/review/attempt-1");
        await expect(harness.caches.match("/solve/mobile-qa-exam")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/student/dashboard")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/student/history")).resolves.toBeInstanceOf(Response);
        await expect(harness.caches.match("/student/review/attempt-1")).resolves.toBeInstanceOf(Response);

        harness.setNetworkFetch(async () => {
            throw new Error("offline");
        });

        const offlineSolveResponse = await harness.dispatchFetch("/solve/mobile-qa-exam", { mode: "navigate" });
        const offlineDashboardResponse = await harness.dispatchFetch("/student/dashboard", { mode: "navigate" });
        const offlineHistoryResponse = await harness.dispatchFetch("/student/history", { mode: "navigate" });
        const offlineReviewResponse = await harness.dispatchFetch("/student/review/attempt-1", { mode: "navigate" });

        await expect(offlineSolveResponse?.text()).resolves.toBe("network:/solve/mobile-qa-exam");
        await expect(offlineDashboardResponse?.text()).resolves.toBe("network:/student/dashboard");
        await expect(offlineHistoryResponse?.text()).resolves.toBe("network:/student/history");
        await expect(offlineReviewResponse?.text()).resolves.toBe("network:/student/review/attempt-1");
    });

    it("service worker keeps teacher app pages out of the runtime navigation cache", async () => {
        const harness = createServiceWorkerHarness();
        await harness.dispatchInstall();
        await harness.dispatchActivate();

        const navigationResponse = await harness.dispatchFetch("/teacher/dashboard", { mode: "navigate" });

        await expect(navigationResponse?.text()).resolves.toBe("network:/teacher/dashboard");
        await expect(harness.caches.match("/teacher/dashboard")).resolves.toBeUndefined();
    });

    it("service worker does not cache failed navigation responses", async () => {
        const harness = createServiceWorkerHarness();
        await harness.dispatchInstall();
        await harness.dispatchActivate();
        harness.setNetworkFetch(async () => new Response("server-error", { status: 500 }));

        const navigationResponse = await harness.dispatchFetch("/teacher/dashboard", { mode: "navigate" });

        await expect(navigationResponse?.text()).resolves.toBe("server-error");
        await expect(harness.caches.match("/teacher/dashboard")).resolves.toBeUndefined();
    });

    it("service worker accepts update activation messages", async () => {
        const harness = createServiceWorkerHarness();

        await harness.dispatchMessage({ type: "OMR_SKIP_WAITING" });

        expect(harness.self.skipWaiting).toHaveBeenCalledOnce();
    });

    it("PWA registration checks for mobile app updates without reloading active work screens", () => {
        const source = getPwaRegisterSource();

        expect(source).toContain("showToast");
        expect(source).toContain("DEFERRED_UPDATE_KEY");
        expect(source).toContain("omr_pwa_deferred_update_v1");
        expect(source).toContain("isActiveWorkScreen");
        expect(source).toContain("visibilitychange");
        expect(source).toContain("window.addEventListener(\"online\", handleOnline)");
        expect(source).toContain("window.removeEventListener(\"online\", handleOnline)");
        expect(source).toContain("controllerchange");
        expect(source).toContain("updatefound");
        expect(source).toContain("getRegistration(\"/sw.js\")");
        expect(source).toContain('pathname === "/create"');
        expect(source).toContain('pathname.startsWith("/solve/")');
        expect(source).toContain('pathname.startsWith("/teacher/exam/")');
        expect(source).toContain('pathname.startsWith("/teacher/live")');
        expect(source).toContain('pathname.startsWith("/teacher/billing")');
        expect(source).toContain("hasDeferredUpdate()");
        expect(source).toContain("rememberDeferredUpdate()");
        expect(source).toContain("clearDeferredUpdate()");
        expect(source).toContain("notifyOnNextController");
        expect(source).toContain("hasShownDeferredUpdateNotice");
        expect(source).toContain("새 버전 준비됨");
        expect(source).toContain("현재 작업은 유지됩니다");
        expect(source).toContain("안전한 화면으로 이동하면 최신 앱으로 전환됩니다");
        expect(source).toContain("6500");
        expect(source).toContain("OMR_SKIP_WAITING");
    });

    it("external PWA smoke requires HTTPS and separates offline browser network noise", () => {
        const source = getPwaSmokeSource();

        expect(source).toContain("External PWA smoke URLs must use HTTPS for installability");
        expect(source).toContain("isExpectedOfflineBrowserProblem");
        expect(source).toContain("ERR_INTERNET_DISCONNECTED");
        expect(source).toContain("onlineConsoleProblems");
        expect(source).toContain("offlineConsoleProblems");
        expect(source).toContain("Unexpected offline console warnings/errors were emitted during PWA smoke");
        expect(source).toContain("onlineDeviceCheckState");
        expect(source).toContain("offlineDeviceCheckState");
        expect(source).toContain("offlineFallbackState");
        expect(source).toContain("onlineSolveState");
        expect(source).toContain("offlineSolveState");
        expect(source).toContain("Offline fallback touch targets are too small");
        expect(source).toContain("installProofGuide");
        expect(source).toContain("PWA install proof guide is missing");
        expect(source).toContain("PWA install proof guide must cover Android and iOS");
        expect(source).toContain("PWA proof verifier must persist and clear collected reports");
        expect(source).toContain("Offline PWA proof verifier must persist and clear collected reports");
        expect(source).toContain("cachedPwaCheck");
        expect(source).toContain("cachedMobileSolve");
        expect(source).toContain("Offline mobile solve route did not render from cache");
        expect(source).toContain("displayEvidence=");
        expect(source).toContain("installedDisplay=no");
        expect(source).toContain("proofStatus=pending");
        expect(source).toContain("launch-proof=");
        expect(source).toContain("expectedHandoffOriginReport");
        expect(source).toContain("handoff-origin=pass:공유 가능");
        expect(source).toContain("handoff-origin=warn:로컬 전용");
        expect(source).toContain("service-worker=pass:제어 중");
        expect(source).toContain("controller=yes");
        expect(source).toContain("offline-cache=pass:준비");
        expect(source).toContain("storage=pass:사용 가능");
        expect(source).toContain("indexedDB ok");
        expect(source).toContain("viewport-height=pass:동기화");
        expect(source).toContain("keyboard-safe-area=pass:준비");
        expect(source).toContain("Page.getAppManifest");
        expect(source).toContain("Page.getInstallabilityErrors");
        expect(source).toContain("Chromium reported PWA installability errors");
        expect(source).toContain("chromiumInstallabilityState");
    });

    it("validates copied installed app proof reports from real devices", () => {
        const source = getPwaProofSource();
        const proofScriptPath = path.join(rootDir, "scripts/pwa-proof-verify.mjs");
        const freshProofEpoch = String(Date.now());
        const staleProofEpoch = String(Date.now() - 8 * 24 * 60 * 60 * 1000);
        const passingReport = [
            "OMR Maker PWA device check",
            "url=https://omr-maker-eight.vercel.app/pwa-check",
            "checkedAt=2026. 6. 22. 4시 10분 00초",
            `checkedAtEpoch=${freshProofEpoch}`,
            "verdict=앱 실행 통과",
            "displayMode=standalone",
            "installedDisplay=yes",
            "proofStatus=pass",
            "displayEvidence=css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=no",
            "summary=16 pass, 0 warn, 0 fail",
            "userAgent=Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Mobile Safari/537.36",
            "- secure-context=pass:보안 컨텍스트 (https://omr-maker-eight.vercel.app)",
            "- display-mode=pass:standalone (홈 화면 아이콘 실행 상태)",
            "- launch-proof=pass:확인됨 (css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=no)",
            "- service-worker=pass:제어 중 (script=https://omr-maker-eight.vercel.app/sw.js · controller=yes · active=activated · waiting=none · installing=none)",
            "- offline-cache=pass:준비 (caches=omr-maker-v15-shell, omr-maker-v15-runtime · required=/, /pwa-check, /offline.html, /logo.png · expected=omr-maker-v15-shell · missingCaches=none · missing=none)",
            "- manifest=pass:standalone (OMR Maker · icons 12 · screenshots 2)",
            "- viewport=pass:cover (width=device-width, initial-scale=1, viewport-fit=cover)",
            "- viewport-height=pass:동기화 (css=727px · visual=727px · inner=727px · delta=0px)",
            "- keyboard-safe-area=pass:준비 (keyboard=0px · state=closed · width=393px · offsetTop=0px · offsetLeft=0px · scale=1)",
            "- mobile-meta=pass:준비 (Android yes · iOS yes)",
            "- ios-startup-image=pass:준비 (16 images · iPhone portrait yes · iPad portrait yes · iPad landscape yes)",
            "- handoff-origin=pass:공유 가능 (https://omr-maker-eight.vercel.app/pwa-check)",
            "- overflow=pass:정상 (scroll 393px / viewport 393px)",
            "- storage=pass:사용 가능 (localStorage ok · sessionStorage ok · indexedDB ok · quota=512MB · usage=1MB · persisted=unknown)",
            "- runtime-performance=pass:쾌적 (domReady=742ms · load=980ms · response=180ms · fcp=520ms · longTasks=not-sampled · budget=3000/5000ms)",
            "- install-prompt=pass:없음 (진단 화면에는 설치 배너 없음)",
        ].join("\n");
        const pendingReport = passingReport
            .replace("verdict=앱 실행 통과", "verdict=설치 실행 전")
            .replace("displayMode=standalone", "displayMode=browser")
            .replace("installedDisplay=yes", "installedDisplay=no")
            .replace("proofStatus=pass", "proofStatus=pending");
        const staleCacheReport = passingReport.replaceAll("omr-maker-v15", "omr-maker-v9");
        const staleTimeReport = passingReport.replace(`checkedAtEpoch=${freshProofEpoch}`, `checkedAtEpoch=${staleProofEpoch}`);
        const uncontrolledWorkerReport = passingReport.replace("controller=yes", "controller=no");
        const legacyStorageReport = passingReport.replace(" · indexedDB ok · quota=512MB · usage=1MB · persisted=unknown", "");
        const legacyPerformanceReport = passingReport.replace(/\n- runtime-performance=pass:쾌적 \([^)]+\)/, "");
        const wrongPathReport = passingReport.replace("url=https://omr-maker-eight.vercel.app/pwa-check", "url=https://omr-maker-eight.vercel.app/teacher/dashboard");
        const wrongOriginReport = passingReport.replaceAll("https://omr-maker-eight.vercel.app", "https://preview.example.com");
        const iosReport = passingReport
            .replace("css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=no", "css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=yes")
            .replace("css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=no", "css-fullscreen=no · css-standalone=yes · ios-navigator-standalone=yes")
            .replace("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.7727.15 Mobile Safari/537.36", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1");
        const wrongOriginIosReport = iosReport.replaceAll("https://omr-maker-eight.vercel.app", "https://preview.example.com");
        const passingBundle = [
            "OMR Maker PWA dual device proof",
            "generatedAt=2026. 6. 22. 4시 15분 00초",
            `generatedAtEpoch=${freshProofEpoch}`,
            "status=passed",
            "requiredDevices=Android, iOS",
            "origin=https://omr-maker-eight.vercel.app",
            "android=android:standalone:pass",
            "ios=ios:standalone:pass",
            "-----BEGIN ANDROID PWA REPORT-----",
            passingReport,
            "-----END ANDROID PWA REPORT-----",
            "-----BEGIN IOS PWA REPORT-----",
            iosReport,
            "-----END IOS PWA REPORT-----",
        ].join("\n");
        const mixedOriginBundle = passingBundle.replace(iosReport, wrongOriginIosReport);
        const staleGeneratedBundle = passingBundle.replace(`generatedAtEpoch=${freshProofEpoch}`, `generatedAtEpoch=${staleProofEpoch}`);

        const passing = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: passingReport,
        });
        const passingWithOrigin = spawnSync(process.execPath, [proofScriptPath, "--origin", "https://omr-maker-eight.vercel.app"], {
            encoding: "utf8",
            input: passingReport,
        });
        const failing = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: pendingReport,
        });
        const staleCache = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: staleCacheReport,
        });
        const staleTime = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: staleTimeReport,
        });
        const uncontrolledWorker = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: uncontrolledWorkerReport,
        });
        const legacyStorage = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: legacyStorageReport,
        });
        const legacyPerformance = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: legacyPerformanceReport,
        });
        const wrongPath = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: wrongPathReport,
        });
        const wrongOrigin = spawnSync(process.execPath, [proofScriptPath, "--origin", "https://omr-maker-eight.vercel.app"], {
            encoding: "utf8",
            input: wrongOriginReport,
        });
        const bundle = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: passingBundle,
        });
        const bundleWithOrigin = spawnSync(process.execPath, [proofScriptPath, "--origin", "https://omr-maker-eight.vercel.app"], {
            encoding: "utf8",
            input: passingBundle,
        });
        const mixedOrigin = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: mixedOriginBundle,
        });
        const staleGenerated = spawnSync(process.execPath, [proofScriptPath], {
            encoding: "utf8",
            input: staleGeneratedBundle,
        });

        expect(source).toContain("proofStatus must be pass");
        expect(source).toContain("installedDisplay must be yes");
        expect(source).toContain("displayMode must be standalone or fullscreen");
        expect(source).toContain("Report URL must be the deployed HTTPS /pwa-check URL");
        expect(source).toContain("Report URL origin must be ${expectedOrigin}");
        expect(source).toContain("validateFreshProofEpoch");
        expect(source).toContain("checkedAtEpoch");
        expect(source).toContain("generatedAtEpoch");
        expect(source).toContain("must be newer than 7 days.");
        expect(source).toContain('const expectedCachePrefix = "omr-maker-v15"');
        expect(source).toContain("offline-cache must include ${expectedCachePrefix}");
        expect(source).toContain("storage must include IndexedDB availability.");
        expect(source).toContain("runtime-performance must include the device timing budget evidence.");
        expect(source).toContain("service-worker must be controlled by the active PWA worker.");
        expect(source).toContain("OMR Maker PWA dual device proof");
        expect(source).toContain("Android proof report must pass");
        expect(source).toContain("iOS proof report must pass");
        expect(source).toContain("Android and iOS proof reports must come from the same deployed origin.");
        expect(passing.status).toBe(0);
        expect(JSON.parse(passing.stdout)).toMatchObject({
            displayMode: "standalone",
            installedDisplay: "yes",
            origin: "https://omr-maker-eight.vercel.app",
            platform: "android",
            proofStatus: "pass",
            status: "passed",
        });
        expect(passingWithOrigin.status).toBe(0);
        expect(failing.status).toBe(1);
        expect(JSON.parse(failing.stdout)).toMatchObject({
            displayMode: "browser",
            installedDisplay: "no",
            proofStatus: "pending",
            status: "failed",
        });
        expect(staleCache.status).toBe(1);
        expect(JSON.parse(staleCache.stdout)).toMatchObject({
            status: "failed",
        });
        expect(JSON.parse(staleCache.stdout).errors).toContain("offline-cache must include omr-maker-v15.");
        expect(staleTime.status).toBe(1);
        expect(JSON.parse(staleTime.stdout).errors).toContain("checkedAtEpoch must be newer than 7 days.");
        expect(uncontrolledWorker.status).toBe(1);
        expect(JSON.parse(uncontrolledWorker.stdout).errors).toContain("service-worker must be controlled by the active PWA worker.");
        expect(legacyStorage.status).toBe(1);
        expect(JSON.parse(legacyStorage.stdout).errors).toContain("storage must include IndexedDB availability.");
        expect(legacyPerformance.status).toBe(1);
        expect(JSON.parse(legacyPerformance.stdout).errors).toContain("Missing check: runtime-performance.");
        expect(wrongPath.status).toBe(1);
        expect(JSON.parse(wrongPath.stdout).errors).toContain("Report URL must be the deployed HTTPS /pwa-check URL, not localhost, another path, or another origin.");
        expect(wrongOrigin.status).toBe(1);
        expect(JSON.parse(wrongOrigin.stdout).errors).toContain("Report URL origin must be https://omr-maker-eight.vercel.app.");
        expect(bundle.status).toBe(0);
        expect(JSON.parse(bundle.stdout)).toMatchObject({
            android: { platform: "android", status: "passed" },
            ios: { platform: "ios", status: "passed" },
            mode: "dual",
            origin: "https://omr-maker-eight.vercel.app",
            status: "passed",
        });
        expect(bundleWithOrigin.status).toBe(0);
        expect(mixedOrigin.status).toBe(1);
        expect(JSON.parse(mixedOrigin.stdout).errors).toContain("Android and iOS proof reports must come from the same deployed origin.");
        expect(staleGenerated.status).toBe(1);
        expect(JSON.parse(staleGenerated.stdout).errors).toContain("generatedAtEpoch must be newer than 7 days.");
    });

    it("keeps the device-check page proof status aligned with strict installed app evidence", () => {
        const pageSource = getPwaCheckPageSource();

        expect(pageSource).toContain("function isInstalledLaunchProof");
        expect(pageSource).toContain("requiredProofChecksPass(snapshot.checks)");
        expect(pageSource).toContain("checkedAtEpoch");
        expect(pageSource).toContain("validateFreshProofEpoch");
        expect(pageSource).toContain("generatedAtEpoch");
        expect(pageSource).toContain('`proofStatus=${proofReady ? "pass" : "pending"}`');
        expect(pageSource).toContain("function validateDualProofOrigins");
        expect(pageSource).toContain("Android/iOS reports must come from the same deployed origin");
        expect(pageSource).toContain('`origin=${origin || "missing"}`');
        expect(pageSource).toContain("npm run pwa:proof -- --origin 배포URL");
        expect(pageSource).toContain("omr_pwa_device_proof_inputs_v1");
        expect(pageSource).toContain("function readStoredProofInputs");
        expect(pageSource).toContain("function writeStoredProofInputs");
        expect(pageSource).toContain("pwa-proof-storage-status");
        expect(pageSource).toContain("pwa-proof-clear");
    });
});
