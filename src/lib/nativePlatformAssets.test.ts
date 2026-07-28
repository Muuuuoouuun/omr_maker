import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("Windows, iOS, and web native development surface", () => {
    it("keeps remote WebView configuration opt-in and development-only", () => {
        const config = readProjectFile("capacitor.config.ts");
        const shell = readProjectFile("mobile/www/index.html");

        expect(config).toContain('process.env.CAP_ALLOW_REMOTE_DEV !== "1"');
        expect(config).toContain("CAP_SERVER_URL is development-only");
        expect(config).not.toContain("192.168.219.141");
        expect(config).not.toMatch(/process\.env\.CAP_SERVER_URL\s*\|\|/);
        expect(shell).toContain("npm run android:dev");
        expect(shell).not.toMatch(/https?:\/\/192\.168\./);
    });

    it("uses adb port forwarding for the Windows to Android live-reload path", () => {
        const packageJson = JSON.parse(readProjectFile("package.json")) as { scripts: Record<string, string> };
        const command = packageJson.scripts["android:dev"];

        expect(command).toContain("--live-reload");
        expect(command).toContain("--host 127.0.0.1");
        expect(command).toContain("--forwardPorts 3003:3003");
        expect(packageJson.scripts["android:doctor"]).toContain("android-doctor.mjs");
        expect(packageJson.scripts["mobile:apk"]).toContain("build-android-remote-dev.mjs");
    });

    it("marks the WebView as native and suppresses the duplicate PWA install prompt", () => {
        const layout = readProjectFile("src/app/layout.tsx");
        const platformSync = readProjectFile("src/components/NativePlatformSync.tsx");
        const installPrompt = readProjectFile("src/components/MobileInstallPrompt.tsx");
        const css = readProjectFile("src/app/globals.css");

        expect(layout).toContain("<NativePlatformSync />");
        expect(platformSync).toContain('Capacitor.getPlatform()');
        expect(platformSync).toContain('data-native-platform');
        expect(installPrompt).toContain("!Capacitor.isNativePlatform()");
        expect(css).toContain("html[data-native-platform] .mobile-install-prompt");
        expect(css).toContain("html[data-native-platform] .layout-main");
    });
});
