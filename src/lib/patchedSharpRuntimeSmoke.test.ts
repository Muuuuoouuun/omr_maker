import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();
const optimizedImagePath = "/_next/image?url=%2Flogo.png&w=96&q=75";
const desktopSuccessMarker = "OMR_DESKTOP_SMOKE_OK";

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("patched sharp runtime smoke contracts", () => {
    it("probes the real Next image optimizer during the production PWA smoke", () => {
        const source = readProjectFile("scripts/pwa-prod-smoke.mjs");

        expect(source).toContain(`const optimizedImagePath = "${optimizedImagePath}";`);
        expect(source).toContain("await response.arrayBuffer()");
        expect(source).toContain('contentType.toLowerCase().startsWith("image/")');
        expect(source).toContain("Optimized image response must not be empty");
        expect(source).toContain("new URL(pathname, baseUrl)");
        expect(source).toContain("externalBaseUrl && !isLocalhostUrl(baseUrl)");
    });

    it("keeps the packaged Electron optimizer smoke behind an explicit environment gate", () => {
        const source = readProjectFile("electron/main.mjs");
        const nextConfig = readProjectFile("next.config.ts");

        expect(source).toContain('const DESKTOP_SMOKE_ENABLED = process.env.OMR_DESKTOP_SMOKE === "1";');
        expect(source).toContain(`const DESKTOP_SMOKE_SUCCESS_MARKER = "${desktopSuccessMarker}";`);
        expect(source).toContain(`const optimizedImagePath = "${optimizedImagePath}";`);
        expect(source).toContain("await response.arrayBuffer()");
        expect(source).toContain('contentType.toLowerCase().startsWith("image/")');
        expect(source).toContain('process.env.OMR_DESKTOP_RUNTIME = "1";');
        expect(nextConfig).toContain('process.env.OMR_DESKTOP_RUNTIME === "1"');
        expect(nextConfig).toContain("maximumDiskCacheSize: 0");
        expect(source).toContain("await closeNextServer()");
        expect(source).toContain("app.exit(0)");
        expect(source).toContain("app.exit(1)");
    });

    it("launches the platform-specific unpacked executable with a timeout and success marker", () => {
        const scriptPath = "scripts/desktop-package-smoke.mjs";
        expect(existsSync(path.join(rootDir, scriptPath))).toBe(true);

        const source = readProjectFile(scriptPath);
        const logSource = readProjectFile("scripts/desktop-smoke-log.mjs");
        const packageJson = JSON.parse(readProjectFile("package.json")) as {
            scripts: Record<string, string>;
        };

        expect(source).toContain("OMR_DESKTOP_SMOKE_EXECUTABLE");
        expect(source).toContain("OMR_DESKTOP_SMOKE_RELEASE_DIR");
        expect(source).toContain('process.platform === "darwin"');
        expect(source).toContain('process.platform === "win32"');
        expect(source).toContain('process.platform === "linux"');
        expect(source).toContain('OMR_DESKTOP_SMOKE: "1"');
        expect(source).toContain("OMR_DESKTOP_SMOKE_TIMEOUT_MS");
        expect(source).toContain(desktopSuccessMarker);
        expect(source).toContain("unexpectedRuntimeProblem");
        expect(source).toContain("findDesktopSmokeFatalLog");
        expect(logSource).toContain("UnhandledPromiseRejectionWarning");
        expect(logSource).toContain("UnhandledPromiseRejection");
        expect(logSource).toContain("unhandledRejection");
        expect(logSource).toContain("uncaughtException");
        expect(logSource).toContain("OMR_DESKTOP_SMOKE_FAILED");
        expect(packageJson.scripts["desktop:smoke:packaged"]).toBe("node scripts/desktop-package-smoke.mjs");
    });
});
