import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const rootDir = process.cwd();

function readProjectFile(filePath: string): string {
    return readFileSync(path.join(rootDir, filePath), "utf8");
}

describe("native WebView development surface", () => {
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
