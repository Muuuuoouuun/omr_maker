import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { scoreReleaseEvidence } from "./release-quality-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const BUILD_SHA = /^[a-f0-9]{40}$/;
const TEMP_NAME = /^[a-f0-9]{32}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const DEFAULT_DEPENDENCIES = Object.freeze({
    fs: Object.freeze({ link, lstat, open, realpath, unlink }),
    currentUid: () => process.getuid?.(),
    generateTempName: () => randomBytes(16).toString("hex"),
    now: () => new Date(),
    resolveScorerSha: (cwd) => execFileSync("git", ["rev-parse", "HEAD"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
    }).trim(),
});

export class ReleaseScoreCliError extends Error {
    constructor(code) {
        super("Release score is unverified");
        this.name = "ReleaseScoreCliError";
        this.code = code;
    }
}

function fail(code) {
    throw new ReleaseScoreCliError(code);
}

function canonicalAbsolutePath(value, label) {
    if (typeof value !== "string" || value.length < 2 || value.length > 4096 || value.includes("\0")
        || !isAbsolute(value) || resolve(value) !== value) fail(label);
    return value;
}

export function parseReleaseScoreArgs(argv) {
    if (!Array.isArray(argv) || argv.length !== 2 || Object.keys(argv).length !== 2) fail("invalid_arguments");
    const parsed = {};
    for (const argument of argv) {
        if (typeof argument !== "string") fail("invalid_arguments");
        if (argument.startsWith("--manifest=")) {
            if (parsed.manifestPath !== undefined) fail("invalid_arguments");
            parsed.manifestPath = canonicalAbsolutePath(argument.slice("--manifest=".length), "invalid_arguments");
        } else if (argument.startsWith("--output=")) {
            if (parsed.outputPath !== undefined) fail("invalid_arguments");
            parsed.outputPath = canonicalAbsolutePath(argument.slice("--output=".length), "invalid_arguments");
        } else {
            fail("invalid_arguments");
        }
    }
    if (!parsed.manifestPath || !parsed.outputPath || parsed.manifestPath === parsed.outputPath) {
        fail("invalid_arguments");
    }
    return Object.freeze(parsed);
}

function dependencies(overrides) {
    return {
        ...DEFAULT_DEPENDENCIES,
        ...overrides,
        fs: { ...DEFAULT_DEPENDENCIES.fs, ...(overrides.fs ?? {}) },
    };
}

async function assertAbsent(path, fs) {
    try {
        await fs.lstat(path);
    } catch (error) {
        if (error?.code === "ENOENT") return;
        fail("unsafe_output");
    }
    fail("unsafe_output");
}

async function safeOutputBoundary(outputPath, deps) {
    await assertAbsent(outputPath, deps.fs);
    const parentPath = dirname(outputPath);
    let stats;
    let canonicalParent;
    try {
        [stats, canonicalParent] = await Promise.all([
            deps.fs.lstat(parentPath),
            deps.fs.realpath(parentPath),
        ]);
    } catch {
        fail("unsafe_output");
    }
    const uid = deps.currentUid();
    if (!stats.isDirectory() || stats.isSymbolicLink() || canonicalParent !== parentPath
        || !Number.isSafeInteger(uid) || stats.uid !== uid || (stats.mode & 0o777) !== 0o700) {
        fail("unsafe_output");
    }
    return Object.freeze({
        parentPath,
        realpath: canonicalParent,
        dev: stats.dev,
        ino: stats.ino,
        uid,
    });
}

async function sameOutputBoundary(boundary, deps) {
    try {
        const stats = await deps.fs.lstat(boundary.parentPath);
        return stats.isDirectory()
            && !stats.isSymbolicLink()
            && stats.dev === boundary.dev
            && stats.ino === boundary.ino
            && stats.uid === boundary.uid
            && (stats.mode & 0o777) === 0o700
            && await deps.fs.realpath(boundary.parentPath) === boundary.realpath;
    } catch {
        return false;
    }
}

async function readManifest(path, deps) {
    let handle;
    try {
        const pathStats = await deps.fs.lstat(path);
        if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1
            || pathStats.size < 2 || pathStats.size > MAX_MANIFEST_BYTES) fail("invalid_manifest");
        handle = await deps.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (typeof handle.stat !== "function" || typeof handle.readFile !== "function"
            || typeof handle.close !== "function") fail("invalid_manifest");
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== pathStats.dev || before.ino !== pathStats.ino
            || before.size !== pathStats.size) fail("invalid_manifest");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== before.size
            || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeMs !== after.mtimeMs) fail("invalid_manifest");
        let manifest;
        try {
            manifest = parseStrictJson(UTF8_DECODER.decode(bytes));
        } catch {
            fail("invalid_manifest");
        }
        return Object.freeze({
            manifest,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    } catch (error) {
        if (error instanceof ReleaseScoreCliError) throw error;
        fail("invalid_manifest");
    } finally {
        if (handle) {
            try {
                await handle.close();
            } catch {
                fail("invalid_manifest");
            }
        }
    }
}

async function publishScore(outputPath, value, boundary, deps) {
    const serialized = `${JSON.stringify(value)}\n`;
    const temporaryId = deps.generateTempName();
    if (typeof temporaryId !== "string" || !TEMP_NAME.test(temporaryId)) fail("unsafe_output");
    const temporaryPath = `${boundary.parentPath}${sep}.${basename(outputPath)}.${temporaryId}.tmp`;
    let handle;
    let directoryHandle;
    let ownedStats;
    let writtenStats;
    let tempPresent = false;
    let outputLinked = false;
    let handleClosed = false;
    try {
        handle = await deps.fs.open(temporaryPath, "wx", 0o600);
        tempPresent = true;
        if (typeof handle.chmod !== "function" || typeof handle.writeFile !== "function"
            || typeof handle.sync !== "function" || typeof handle.stat !== "function"
            || typeof handle.close !== "function") fail("unsafe_output");
        ownedStats = await deps.fs.lstat(temporaryPath);
        if (!ownedStats.isFile() || ownedStats.size !== 0 || ownedStats.uid !== boundary.uid
            || ownedStats.isSymbolicLink() || (ownedStats.mode & 0o777) !== 0o600) fail("unsafe_output");
        const openedStats = await handle.stat();
        if (!openedStats.isFile() || openedStats.dev !== ownedStats.dev || openedStats.ino !== ownedStats.ino
            || openedStats.size !== 0 || openedStats.uid !== boundary.uid
            || (openedStats.mode & 0o777) !== 0o600) fail("unsafe_output");
        await handle.chmod(0o600);
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
        writtenStats = await handle.stat();
        if (!writtenStats.isFile() || writtenStats.dev !== ownedStats.dev || writtenStats.ino !== ownedStats.ino
            || writtenStats.uid !== boundary.uid || (writtenStats.mode & 0o777) !== 0o600
            || writtenStats.size !== Buffer.byteLength(serialized)) fail("unsafe_output");
        await handle.close();
        handleClosed = true;
        if (!await sameOutputBoundary(boundary, deps)) fail("unsafe_output");
        await assertAbsent(outputPath, deps.fs);
        await deps.fs.link(temporaryPath, outputPath);
        outputLinked = true;
        const published = await deps.fs.lstat(outputPath);
        if (!published.isFile() || published.isSymbolicLink() || published.dev !== ownedStats.dev
            || published.ino !== ownedStats.ino || published.size !== writtenStats.size
            || published.uid !== boundary.uid || (published.mode & 0o777) !== 0o600) fail("unsafe_output");
        await deps.fs.unlink(temporaryPath);
        tempPresent = false;
        directoryHandle = await deps.fs.open(boundary.parentPath, "r");
        if (typeof directoryHandle.sync !== "function" || typeof directoryHandle.close !== "function") {
            fail("unsafe_output");
        }
        await directoryHandle.sync();
        await directoryHandle.close();
        directoryHandle = undefined;
    } catch (error) {
        if (tempPresent && !ownedStats && handle && typeof handle.stat === "function") {
            try { ownedStats = await handle.stat(); } catch { /* cleanup stays inode-bound */ }
        }
        if (handle && !handleClosed && typeof handle.close === "function") {
            try { await handle.close(); } catch { /* best effort */ }
        }
        if (directoryHandle && typeof directoryHandle.close === "function") {
            try { await directoryHandle.close(); } catch { /* best effort */ }
        }
        if (outputLinked && ownedStats) {
            try {
                const stats = await deps.fs.lstat(outputPath);
                if (stats.dev === ownedStats.dev && stats.ino === ownedStats.ino) await deps.fs.unlink(outputPath);
            } catch { /* best effort */ }
        }
        if (tempPresent && ownedStats) {
            try {
                const stats = await deps.fs.lstat(temporaryPath);
                if (stats.dev === ownedStats.dev && stats.ino === ownedStats.ino) await deps.fs.unlink(temporaryPath);
            } catch { /* best effort */ }
        }
        if (error instanceof ReleaseScoreCliError) throw error;
        fail("unsafe_output");
    }
}

export async function runReleaseScoreCli(input, overrides = {}) {
    const deps = dependencies(overrides);
    const cwd = resolve(input?.cwd ?? resolve(import.meta.dirname, ".."));
    const args = parseReleaseScoreArgs(input?.argv ?? []);
    const boundary = await safeOutputBoundary(args.outputPath, deps);
    const source = await readManifest(args.manifestPath, deps);
    let scorerSha;
    try {
        scorerSha = overrides.scorerSha ?? deps.resolveScorerSha(cwd);
    } catch {
        fail("invalid_scorer_sha");
    }
    if (typeof scorerSha !== "string" || !BUILD_SHA.test(scorerSha)) fail("invalid_scorer_sha");
    let score;
    try {
        score = await scoreReleaseEvidence(source.manifest, {
            now: deps.now,
            scorerSha,
            ...(overrides.readArtifact ? { readArtifact: overrides.readArtifact } : {}),
        });
    } catch {
        fail("invalid_manifest");
    }
    const result = Object.freeze({ ...score, manifestSha256: source.sha256 });
    await publishScore(args.outputPath, result, boundary, deps);
    return Object.freeze({
        exitCode: result.status === "go" ? 0 : 1,
        diagnostic: result.status === "go"
            ? "verified: release_quality_go"
            : "no_go: release_quality_gate_failed",
        result,
    });
}

async function main() {
    try {
        const outcome = await runReleaseScoreCli({ argv: process.argv.slice(2) });
        process.stdout.write(`${outcome.diagnostic}\n`);
        process.exitCode = outcome.exitCode;
    } catch {
        process.stderr.write("unverified: release_score_not_verified\n");
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    await main();
}
