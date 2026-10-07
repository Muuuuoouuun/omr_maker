import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ESLint } from "eslint";
import nextVitals from "eslint-config-next/core-web-vitals";

const require = createRequire(import.meta.url);
const pluginPath = require.resolve("@next/eslint-plugin-next");
const pluginRequire = createRequire(pluginPath);
const { getRootDirs } = require(join(dirname(pluginPath), "utils/get-root-dirs.js"));
const temporaryRoots: string[] = [];

function fixture() {
    const root = mkdtempSync(join(tmpdir(), "omr-next-eslint-glob-"));
    temporaryRoots.push(root);
    for (const app of ["alpha", "beta"]) {
        mkdirSync(join(root, "apps", app, "pages"), { recursive: true });
        writeFileSync(join(root, "apps", app, "pages", "about.tsx"), "export default function About() { return null; }");
    }
    writeFileSync(join(root, "apps", "ordinary-file"), "not a directory");
    mkdirSync(join(root, "apps", ".hidden"));
    return root;
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Next ESLint's limited glob dependency replacement", () => {
    it("loads the reviewed alternative at the actual Next plugin resolution path", () => {
        const manifest = JSON.parse(readFileSync(pluginRequire.resolve("fast-glob/package.json"), "utf8"));
        expect(manifest.name).toBe("@omr/next-eslint-glob-adapter");
        expect(manifest.dependencies).toEqual({ tinyglobby: "0.2.17" });
        expect(pluginRequire("fast-glob").globSync).toBeTypeOf("function");
    });

    it("fails closed if an upstream caller requests a different glob API", () => {
        const glob = pluginRequire("fast-glob").globSync;
        expect(() => glob("apps/*", { onlyDirectories: false })).toThrow("Unsupported Next ESLint root glob contract");
        expect(() => glob("apps/*", { onlyDirectories: true, dot: true })).toThrow("Unsupported Next ESLint root glob contract");
    });

    it("keeps the default single-app root and directory-only wildcard semantics", () => {
        const root = fixture();
        expect(getRootDirs({ cwd: root, settings: {} })).toEqual([root]);
        expect(getRootDirs({ cwd: root, settings: { next: { rootDir: `${root}/apps/*` } } }).sort())
            .toEqual([join(root, "apps", "alpha"), join(root, "apps", "beta")]);
    });

    it("retains monorepo brace, extglob, array and unmatched-root patterns", () => {
        const root = fixture();
        const expected = [join(root, "apps", "alpha"), join(root, "apps", "beta")];
        for (const pattern of ["{alpha,beta}", "@(alpha|beta)"]) {
            expect(getRootDirs({ cwd: root, settings: { next: { rootDir: `${root}/apps/${pattern}` } } }).sort()).toEqual(expected);
        }
        expect(getRootDirs({ cwd: root, settings: { next: { rootDir: [expected[0], expected[1], `${root}/missing/*`] } } }).sort()).toEqual(expected);
        expect(getRootDirs({ cwd: root, settings: { next: { rootDir: `${root}/missing/*` } } })).toEqual([]);
    });

    it("still reports invalid internal links and image elements through the actual Next rules", async () => {
        const root = fixture();
        const eslint = new ESLint({
            cwd: root,
            overrideConfigFile: true,
            overrideConfig: [
                ...nextVitals,
                { settings: { next: { rootDir: `${root}/apps/*` } } },
            ],
        });
        const [result] = await eslint.lintText(
            'export default function Page() { return <><a href="/about">About</a><img src="/image.png" alt="example" /></>; }',
            { filePath: join(root, "apps", "alpha", "pages", "index.tsx") },
        );
        expect(result.messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ ruleId: "@next/next/no-html-link-for-pages", severity: 2 }),
            expect.objectContaining({ ruleId: "@next/next/no-img-element", severity: 1 }),
        ]));
    });
});
