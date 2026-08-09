import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { RELEASE_DIMENSIONS, scoreReleaseEvidence } from "./release-quality-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const BUILD_SHA = /^[a-f0-9]{40}$/;
const TEMP_NAME = /^[a-f0-9]{32}$/;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SCORE_BYTES = 1024 * 1024;
const MAX_SCORER_SOURCE_BYTES = 256 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const SCORER_SOURCE_PATHS = Object.freeze([
    "scripts/release-quality-core.mjs",
    "scripts/score-release-quality.mjs",
    "scripts/strict-json.mjs",
]);

function readBoundedScorerSource(cwd, path) {
    const absolutePath = resolve(cwd, path);
    const pathStats = lstatSync(absolutePath);
    if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1
        || pathStats.size < 1 || pathStats.size > MAX_SCORER_SOURCE_BYTES) {
        throw new Error("invalid scorer source");
    }
    const descriptor = openSync(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = fstatSync(descriptor);
        if (!before.isFile() || before.dev !== pathStats.dev || before.ino !== pathStats.ino
            || before.size !== pathStats.size) throw new Error("invalid scorer source");
        const bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (bytes.byteLength !== before.size || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
            throw new Error("scorer source changed");
        }
        return bytes;
    } finally {
        closeSync(descriptor);
    }
}

export function resolveVerifiedScorerSha(cwd, run = execFileSync) {
    const options = {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        maxBuffer: 64 * 1024,
    };
    const tracked = run("git", ["ls-files", "--error-unmatch", "--", ...SCORER_SOURCE_PATHS], options)
        .trim()
        .split("\n")
        .filter(Boolean);
    if (tracked.length !== SCORER_SOURCE_PATHS.length
        || tracked.some((path, index) => path !== SCORER_SOURCE_PATHS[index])) {
        throw new Error("scorer source is not exactly tracked");
    }
    run("git", ["diff", "--quiet", "HEAD", "--", ...SCORER_SOURCE_PATHS], options);
    for (const path of SCORER_SOURCE_PATHS) {
        const headBytes = run("git", ["show", `HEAD:${path}`], {
            ...options,
            encoding: "buffer",
            maxBuffer: MAX_SCORER_SOURCE_BYTES + 1,
        });
        const workingBytes = readBoundedScorerSource(cwd, path);
        if (!Buffer.isBuffer(headBytes) || headBytes.byteLength > MAX_SCORER_SOURCE_BYTES
            || !headBytes.equals(workingBytes)) throw new Error("scorer source differs from HEAD");
    }
    const sha = run("git", ["rev-parse", "--verify", "HEAD^{commit}"], options).trim();
    if (!BUILD_SHA.test(sha)) throw new Error("invalid scorer commit");
    return sha;
}

const DEFAULT_DEPENDENCIES = Object.freeze({
    fs: Object.freeze({ link, lstat, open, realpath, unlink }),
    currentUid: () => process.getuid?.(),
    generateTempName: () => randomBytes(16).toString("hex"),
    now: () => new Date(),
    resolveScorerSha: resolveVerifiedScorerSha,
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

function exactRecord(value, expectedKeys, code) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key !== "string")) fail(code);
    const sorted = keys.sort();
    const expected = [...expectedKeys].sort();
    if (sorted.length !== expected.length || sorted.some((key, index) => key !== expected[index])) fail(code);
    for (const key of sorted) {
        const descriptor = descriptors[key];
        if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set) fail(code);
    }
    return Object.fromEntries(sorted.map((key) => [key, descriptors[key].value]));
}

function exactEmptyArray(value, code) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
        || value.length !== 0 || Reflect.ownKeys(value).length !== 1) fail(code);
}

function hashOutputPath(outputPath) {
    return createHash("sha256").update(`omr.release-score-output-path:v1\0${outputPath}`, "utf8").digest("hex");
}

function outputBinding(outputPath, boundary, score, manifestSha256) {
    return Object.freeze({
        schemaVersion: 1,
        validationRequired: "exact_path",
        outputPathSha256: hashOutputPath(outputPath),
        parentDev: String(boundary.dev),
        parentIno: String(boundary.ino),
        buildSha: score.buildSha,
        environmentDigest: score.environmentDigest,
        manifestSha256,
        scorerSha: score.scorerSha,
    });
}

function validateExpectedIdentity(raw) {
    const expected = exactRecord(raw, [
        "buildSha", "environmentDigest", "manifestSha256", "scorerSha",
    ], "invalid_published_score");
    if (!BUILD_SHA.test(expected.buildSha) || !BUILD_SHA.test(expected.scorerSha)
        || !SHA256.test(expected.environmentDigest) || !SHA256.test(expected.manifestSha256)
        || expected.buildSha !== expected.scorerSha) fail("invalid_published_score");
    return expected;
}

function validatePublishedScoreEnvelope(raw, outputPath, parent, expected) {
    const score = exactRecord(raw, [
        "approvalStatus", "buildSha", "dimensions", "environmentDigest", "evidenceFailures",
        "hardGateFailures", "manifestSha256", "mean", "minimum", "outputBinding", "schemaVersion",
        "scoredAt", "scorerSha", "status",
    ], "invalid_published_score");
    const binding = exactRecord(score.outputBinding, [
        "buildSha", "environmentDigest", "manifestSha256", "outputPathSha256", "parentDev",
        "parentIno", "schemaVersion", "scorerSha", "validationRequired",
    ], "invalid_published_score");
    if (score.schemaVersion !== 1 || score.status !== "go"
        || score.approvalStatus !== "requires_exact_path_validation"
        || !BUILD_SHA.test(score.buildSha) || !BUILD_SHA.test(score.scorerSha)
        || !SHA256.test(score.environmentDigest) || !SHA256.test(score.manifestSha256)
        || score.buildSha !== expected.buildSha || score.scorerSha !== expected.scorerSha
        || score.environmentDigest !== expected.environmentDigest
        || score.manifestSha256 !== expected.manifestSha256
        || typeof score.scoredAt !== "string" || !Number.isFinite(Date.parse(score.scoredAt))
        || binding.schemaVersion !== 1 || binding.validationRequired !== "exact_path"
        || binding.outputPathSha256 !== hashOutputPath(outputPath)
        || binding.parentDev !== String(parent.dev) || binding.parentIno !== String(parent.ino)
        || binding.buildSha !== score.buildSha || binding.scorerSha !== score.scorerSha
        || binding.environmentDigest !== score.environmentDigest
        || binding.manifestSha256 !== score.manifestSha256) fail("invalid_published_score");
    exactEmptyArray(score.hardGateFailures, "invalid_published_score");
    exactEmptyArray(score.evidenceFailures, "invalid_published_score");
    const dimensions = exactRecord(score.dimensions, RELEASE_DIMENSIONS, "invalid_published_score");
    const tenths = RELEASE_DIMENSIONS.map((dimension) => {
        const value = dimensions[dimension];
        if (typeof value !== "number" || !Number.isFinite(value)
            || !Number.isSafeInteger(value * 10) || value < 0 || value > 10) fail("invalid_published_score");
        return value * 10;
    });
    const totalTenths = tenths.reduce((sum, value) => sum + value, 0);
    const mean = Math.round((totalTenths / (RELEASE_DIMENSIONS.length * 10)) * 100) / 100;
    const minimum = Math.min(...tenths) / 10;
    if (score.mean !== mean || score.minimum !== minimum || totalTenths < 930 || minimum < 8.7) {
        fail("invalid_published_score");
    }
    return Object.freeze({ ...score, dimensions: Object.freeze(dimensions), outputBinding: Object.freeze(binding) });
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

export async function validatePublishedReleaseScore(outputPath, expectedIdentity, overrides = {}) {
    const deps = dependencies(overrides);
    let handle;
    try {
        const canonicalPath = canonicalAbsolutePath(outputPath, "invalid_published_score");
        const expected = validateExpectedIdentity(expectedIdentity);
        const parentPath = dirname(canonicalPath);
        const uid = deps.currentUid();
        const [parent, canonicalParent] = await Promise.all([
            deps.fs.lstat(parentPath),
            deps.fs.realpath(parentPath),
        ]);
        if (!parent.isDirectory() || parent.isSymbolicLink() || canonicalParent !== parentPath
            || !Number.isSafeInteger(uid) || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
            fail("invalid_published_score");
        }
        const pathStats = await deps.fs.lstat(canonicalPath);
        if (!pathStats.isFile() || pathStats.isSymbolicLink() || pathStats.nlink !== 1
            || pathStats.uid !== uid || (pathStats.mode & 0o777) !== 0o600
            || pathStats.size < 2 || pathStats.size > MAX_SCORE_BYTES) fail("invalid_published_score");
        handle = await deps.fs.open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (typeof handle.stat !== "function" || typeof handle.readFile !== "function"
            || typeof handle.close !== "function") fail("invalid_published_score");
        const before = await handle.stat();
        if (!before.isFile() || before.dev !== pathStats.dev || before.ino !== pathStats.ino
            || before.size !== pathStats.size || before.uid !== uid || (before.mode & 0o777) !== 0o600
            || before.nlink !== 1) fail("invalid_published_score");
        const bytes = await handle.readFile();
        const after = await handle.stat();
        const finalPathStats = await deps.fs.lstat(canonicalPath);
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== before.size
            || after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.nlink !== 1
            || !finalPathStats.isFile() || finalPathStats.isSymbolicLink()
            || finalPathStats.dev !== before.dev || finalPathStats.ino !== before.ino
            || finalPathStats.size !== before.size || finalPathStats.mtimeMs !== before.mtimeMs
            || finalPathStats.uid !== uid || (finalPathStats.mode & 0o777) !== 0o600
            || finalPathStats.nlink !== 1) fail("invalid_published_score");
        let parsed;
        try {
            parsed = parseStrictJson(UTF8_DECODER.decode(bytes));
        } catch {
            fail("invalid_published_score");
        }
        const score = validatePublishedScoreEnvelope(parsed, canonicalPath, parent, expected);
        await handle.close();
        handle = undefined;
        return Object.freeze({ status: "verified", score });
    } catch (error) {
        if (handle) {
            try { await handle.close(); } catch { /* fail closed */ }
        }
        if (error instanceof ReleaseScoreCliError && error.code === "invalid_published_score") throw error;
        fail("invalid_published_score");
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
    let contentMayExist = false;
    let handleClosed = false;
    try {
        directoryHandle = await deps.fs.open(boundary.parentPath, "r");
        if (typeof directoryHandle.stat !== "function" || typeof directoryHandle.sync !== "function"
            || typeof directoryHandle.close !== "function") fail("unsafe_output");
        const directoryStats = await directoryHandle.stat();
        if (!directoryStats.isDirectory() || directoryStats.dev !== boundary.dev
            || directoryStats.ino !== boundary.ino || directoryStats.uid !== boundary.uid) fail("unsafe_output");
        handle = await deps.fs.open(temporaryPath, "wx", 0o600);
        tempPresent = true;
        if (typeof handle.chmod !== "function" || typeof handle.writeFile !== "function"
            || typeof handle.sync !== "function" || typeof handle.stat !== "function"
            || typeof handle.truncate !== "function" || typeof handle.close !== "function") fail("unsafe_output");
        ownedStats = await deps.fs.lstat(temporaryPath);
        if (!ownedStats.isFile() || ownedStats.size !== 0 || ownedStats.uid !== boundary.uid
            || ownedStats.isSymbolicLink() || (ownedStats.mode & 0o777) !== 0o600) fail("unsafe_output");
        const openedStats = await handle.stat();
        if (!openedStats.isFile() || openedStats.dev !== ownedStats.dev || openedStats.ino !== ownedStats.ino
            || openedStats.size !== 0 || openedStats.uid !== boundary.uid
            || (openedStats.mode & 0o777) !== 0o600) fail("unsafe_output");
        await handle.chmod(0o600);
        contentMayExist = true;
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
        writtenStats = await handle.stat();
        if (!writtenStats.isFile() || writtenStats.dev !== ownedStats.dev || writtenStats.ino !== ownedStats.ino
            || writtenStats.uid !== boundary.uid || (writtenStats.mode & 0o777) !== 0o600
            || writtenStats.size !== Buffer.byteLength(serialized)) fail("unsafe_output");
        if (!await sameOutputBoundary(boundary, deps)) fail("unsafe_output");
        await assertAbsent(outputPath, deps.fs);
        await deps.fs.link(temporaryPath, outputPath);
        const published = await deps.fs.lstat(outputPath);
        if (!published.isFile() || published.isSymbolicLink() || published.dev !== ownedStats.dev
            || published.ino !== ownedStats.ino || published.size !== writtenStats.size
            || published.uid !== boundary.uid || (published.mode & 0o777) !== 0o600) fail("unsafe_output");
        await deps.fs.unlink(temporaryPath);
        tempPresent = false;
        await directoryHandle.sync();
        if (!await sameOutputBoundary(boundary, deps)) fail("unsafe_output");
        const finalPublished = await deps.fs.lstat(outputPath);
        if (!finalPublished.isFile() || finalPublished.isSymbolicLink()
            || finalPublished.dev !== ownedStats.dev || finalPublished.ino !== ownedStats.ino
            || finalPublished.size !== writtenStats.size || finalPublished.uid !== boundary.uid
            || (finalPublished.mode & 0o777) !== 0o600) fail("unsafe_output");
        await directoryHandle.close();
        directoryHandle = undefined;
        if (!await sameOutputBoundary(boundary, deps)) fail("unsafe_output");
        const closedPublished = await deps.fs.lstat(outputPath);
        if (!closedPublished.isFile() || closedPublished.isSymbolicLink()
            || closedPublished.dev !== ownedStats.dev || closedPublished.ino !== ownedStats.ino
            || closedPublished.size !== writtenStats.size || closedPublished.uid !== boundary.uid
            || (closedPublished.mode & 0o777) !== 0o600) fail("unsafe_output");
        await handle.close();
        handleClosed = true;
    } catch (error) {
        if (tempPresent && !ownedStats && handle && typeof handle.stat === "function") {
            try { ownedStats = await handle.stat(); } catch { /* cleanup stays inode-bound */ }
        }
        if (contentMayExist && handle && !handleClosed
            && typeof handle.truncate === "function" && typeof handle.sync === "function") {
            try {
                await handle.truncate(0);
                await handle.sync();
            } catch { /* best effort: inode-bound cleanup below still runs */ }
        }
        if (ownedStats) {
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
        if (handle && !handleClosed && typeof handle.close === "function") {
            try { await handle.close(); } catch { /* best effort */ }
        }
        if (directoryHandle && typeof directoryHandle.close === "function") {
            try { await directoryHandle.close(); } catch { /* best effort */ }
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
    const result = Object.freeze({
        ...score,
        manifestSha256: source.sha256,
        approvalStatus: "requires_exact_path_validation",
        outputBinding: outputBinding(args.outputPath, boundary, score, source.sha256),
    });
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
