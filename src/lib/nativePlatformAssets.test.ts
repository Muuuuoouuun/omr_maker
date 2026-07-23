import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

function readPngSize(filePath: string): { height: number; width: number } {
    const buffer = readFileSync(path.join(rootDir, filePath));
    expect(buffer.subarray(1, 4).toString("ascii")).toBe("PNG");
    return {
        height: buffer.readUInt32BE(20),
        width: buffer.readUInt32BE(16),
    };
}

describe("Windows and Android native development surface", () => {
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

    it("ships the Android shell with minimal permissions and branded assets", () => {
        const manifest = readProjectFile("android/app/src/main/AndroidManifest.xml");
        const mainActivity = readProjectFile("android/app/src/main/java/com/omrmaker/app/MainActivity.java");
        const activityLayout = readProjectFile("android/app/src/main/res/layout/activity_main.xml");
        const launcherBackground = readProjectFile("android/app/src/main/res/values/ic_launcher_background.xml");
        const strings = readProjectFile("android/app/src/main/res/values/strings.xml");
        const filePaths = readProjectFile("android/app/src/main/res/xml/file_paths.xml");
        const styles = readProjectFile("android/app/src/main/res/values/styles.xml");
        const launcher = "android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png";
        const splash = "android/app/src/main/res/drawable-port-xxxhdpi/splash.png";

        expect(manifest).toContain('android:allowBackup="false"');
        expect(manifest).toContain('android.permission.INTERNET');
        expect(manifest).not.toContain('android.permission.CAMERA');
        expect(mainActivity).toContain("class MainActivity extends BridgeActivity");
        expect(activityLayout).toContain('tools:context=".MainActivity"');
        expect(launcherBackground).toContain('name="ic_launcher_background"');
        expect(strings).toContain('<string name="app_name">OMR Maker</string>');
        expect(filePaths).toContain('<cache-path name="my_cache_images"');
        expect(styles).toContain("windowSplashScreenAnimatedIcon");
        expect(existsSync(path.join(rootDir, launcher))).toBe(true);
        expect(existsSync(path.join(rootDir, splash))).toBe(true);
        expect(readPngSize(launcher)).toEqual({ height: 192, width: 192 });
        expect(readPngSize(splash)).toEqual({ height: 1920, width: 1280 });
    });
});
