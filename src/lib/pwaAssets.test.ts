import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const rootDir = process.cwd();
const publicDir = path.join(rootDir, "public");

function publicPathExists(assetPath: string): boolean {
    return existsSync(path.join(publicDir, assetPath.replace(/^\//, "")));
}

function getServiceWorkerAppShellAssets(): string[] {
    const sw = readFileSync(path.join(publicDir, "sw.js"), "utf8");
    const match = sw.match(/const APP_SHELL = \[([\s\S]*?)\];/);
    if (!match) return [];

    return [...match[1].matchAll(/"([^"]+)"/g)].map(item => item[1]);
}

describe("PWA assets", () => {
    it("precache shell references only generated routes or existing public assets", () => {
        const generatedRoutes = new Set(["/", "/manifest.webmanifest"]);
        const missing = getServiceWorkerAppShellAssets()
            .filter(asset => !generatedRoutes.has(asset))
            .filter(asset => !publicPathExists(asset));

        expect(missing).toEqual([]);
    });

    it("manifest icon files exist in public", () => {
        const icons = manifest().icons || [];
        const missing = icons
            .map(icon => typeof icon === "string" ? icon : icon.src)
            .filter(src => src.startsWith("/"))
            .filter(src => !publicPathExists(src));

        expect(missing).toEqual([]);
    });
});
