import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    existsSync,
    fstatSync,
    lstatSync,
    mkdtempSync,
    openSync,
    readFileSync,
    readSync,
    realpathSync,
    rmSync,
    fsyncSync,
    writeSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { finished } from "node:stream/promises";

import {
    assertTargetProjectDiffers,
    validateBackupManifest,
} from "./backup-restore-core.mjs";
import { parseStrictJson } from "./strict-json.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const BUILD_SHA = /^[a-f0-9]{40}$/;
const PROJECT_REF = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const RESTORE_BINDING_SOURCE_PATHS = Object.freeze([
    "scripts/apply-backup-to-restore-target.mjs",
    "scripts/restore-target-apply-core.mjs",
    "scripts/restore-smoke-runner.mjs",
    "scripts/run-restored-environment-smoke.mjs",
    "scripts/verify-restored-environment.mjs",
    "scripts/backup-restore-core.mjs",
    "scripts/storage-backup-gateway.mjs",
    "scripts/strict-json.mjs",
    "supabase/production-server-boundary.sql",
]);

export const RESTORE_TARGET_APPLY_LIMITS = Object.freeze({
    maxManifestBytes: 8 * 1024 * 1024,
    maxSqlArtifactBytes: 512 * 1024 * 1024,
    maxSqlAggregateBytes: 1024 * 1024 * 1024,
    maxChildRuntimeMs: 15 * 60 * 1000,
    maxChildStdoutBytes: 64 * 1024,
    maxChildStderrBytes: 64 * 1024,
    maxStorageObjects: 10_000,
    maxStorageObjectBytes: 512 * 1024 * 1024,
    maxStorageAggregateBytes: 10 * 1024 * 1024 * 1024,
    maxStorageUploadRuntimeMs: 2 * 60 * 1000,
    uploadConcurrency: 4,
});

function fail(message = "Restore target apply was not verified") {
    throw new Error(message);
}

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function digest(label, values) {
    return createHash("sha256")
        .update(`omr.${label}:v1\n`, "utf8")
        .update(values.join("\n"), "utf8")
        .digest("hex");
}

function exactUrl(value, label) {
    let parsed;
    try {
        parsed = new URL(clean(value));
    } catch {
        fail(`${label} is invalid`);
    }
    if (
        parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash
        || parsed.pathname !== "/" || parsed.port
    ) {
        fail(`${label} is invalid`);
    }
    return parsed;
}

function projectRefFromUrl(url, label) {
    const ref = url.hostname.split(".")[0].toLowerCase();
    if (!PROJECT_REF.test(ref)) fail(`${label} project ref is invalid`);
    return ref;
}

function exactArgv(argv) {
    if (!Array.isArray(argv) || argv[0] !== "--apply") fail("Restore target apply mode is required");
    const allowed = new Set([
        "backup",
        "output-dir",
        "confirm-target-project-ref",
        "confirm-boundary-sha256",
        "started-at",
    ]);
    const result = {};
    for (const raw of argv.slice(1)) {
        if (typeof raw !== "string" || !raw.startsWith("--") || !raw.includes("=")) fail("Restore apply arguments are invalid");
        const split = raw.indexOf("=");
        const key = raw.slice(2, split);
        const value = raw.slice(split + 1);
        if (!allowed.has(key) || Object.hasOwn(result, key) || value.length === 0) fail("Restore apply arguments are invalid");
        result[key] = value;
    }
    if ([...allowed].some(key => !Object.hasOwn(result, key))) fail("Restore apply arguments are incomplete");
    return result;
}

function assertPrivateDirectory(path, label) {
    if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail(`${label} is unsafe`);
    let info;
    try {
        info = lstatSync(path);
    } catch {
        fail(`${label} is unavailable`);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail(`${label} is unsafe`);
    return { dev: info.dev, ino: info.ino, realpath: realpathSync(path) };
}

function assertExactDirectory(path, expected, label) {
    const actual = assertPrivateDirectory(path, label);
    if (!expected || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.realpath !== expected.realpath) {
        fail(`${label} identity changed`);
    }
    return actual;
}

function assertContained(root, path, label) {
    const target = resolve(path);
    if (target === root || !target.startsWith(`${root}${sep}`)) fail(`${label} escapes its root`);
    return target;
}

function inspectRegularFile(path, label, expectedBytes, expectedSha256) {
    let before;
    try {
        before = lstatSync(path);
    } catch {
        fail(`${label} is unavailable`);
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail(`${label} symbolic or hard link is forbidden`);
    if (before.size !== expectedBytes || !Number.isSafeInteger(before.size) || before.size < 1) fail(`${label} size is invalid`);
    if (!SHA256.test(expectedSha256)) fail(`${label} hash is invalid`);
    return Object.freeze({ localPath: path, bytes: expectedBytes, sha256: expectedSha256, dev: before.dev, ino: before.ino });
}

function readSmallRegularJson(path, maxBytes, label) {
    let fd;
    try {
        const before = lstatSync(path);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 2 || before.size > maxBytes) fail(`${label} is invalid`);
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) fail(`${label} changed`);
        const raw = readFileSync(fd, { encoding: "utf8" });
        const after = fstatSync(fd);
        if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.nlink !== 1) fail(`${label} changed`);
        return { value: parseStrictJson(raw), sha256: createHash("sha256").update(raw, "utf8").digest("hex") };
    } catch (error) {
        if (error instanceof Error && /invalid|changed/.test(error.message)) throw error;
        fail(`${label} is invalid`);
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

function assertCompleteBackup(backupDir) {
    if (existsSync(join(backupDir, ".INCOMPLETE"))) fail("Backup is incomplete");
    const marker = join(backupDir, ".COMPLETE");
    let info;
    try { info = lstatSync(marker); } catch { fail("Backup completion marker is missing"); }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size < 1 || info.size > 4096) {
        fail("Backup completion marker is invalid");
    }
}

export function assertRestoreApplyBounds(input) {
    const sql = input?.sqlArtifactBytes;
    const storage = input?.storageObjectBytes;
    if (!Array.isArray(sql) || sql.length !== 3 || !Array.isArray(storage)) fail("Restore bounds input is invalid");
    if (sql.some(bytes => !Number.isSafeInteger(bytes) || bytes < 1 || bytes > RESTORE_TARGET_APPLY_LIMITS.maxSqlArtifactBytes)) {
        fail("SQL artifact exceeds its bound");
    }
    const sqlTotal = sql.reduce((sum, bytes) => sum + bytes, 0);
    if (!Number.isSafeInteger(sqlTotal) || sqlTotal > RESTORE_TARGET_APPLY_LIMITS.maxSqlAggregateBytes) {
        fail("SQL aggregate exceeds its bound");
    }
    if (storage.length > RESTORE_TARGET_APPLY_LIMITS.maxStorageObjects) fail("Storage object count exceeds its bound");
    if (storage.some(bytes => !Number.isSafeInteger(bytes) || bytes < 1 || bytes > RESTORE_TARGET_APPLY_LIMITS.maxStorageObjectBytes)) {
        fail("Storage object exceeds its bound");
    }
    const storageTotal = storage.reduce((sum, bytes) => sum + bytes, 0);
    if (!Number.isSafeInteger(storageTotal) || storageTotal > RESTORE_TARGET_APPLY_LIMITS.maxStorageAggregateBytes) {
        fail("Storage aggregate exceeds its bound");
    }
    return Object.freeze({ sqlTotal, storageTotal, storageCount: storage.length });
}

function verifyCheckoutAtBuild(cwd, buildSha) {
    let actualBuild;
    const hashes = [];
    let boundarySha256;
    try {
        actualBuild = execFileSync("git", ["rev-parse", "HEAD"], {
            cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 4096,
        }).trim();
        if (actualBuild !== buildSha) fail("Restore apply checkout does not match build");
        for (const relativePath of RESTORE_BINDING_SOURCE_PATHS) {
            const current = readFileSync(resolve(cwd, relativePath));
            const committed = execFileSync("git", ["show", `${buildSha}:${relativePath}`], {
                cwd, encoding: null, stdio: ["ignore", "pipe", "ignore"], timeout: 20_000, maxBuffer: 32 * 1024 * 1024,
            });
            if (!Buffer.isBuffer(committed) || !current.equals(committed)) fail("Restore apply source does not match build");
            const sha = createHash("sha256").update(current).digest("hex");
            hashes.push(`${relativePath}:${sha}`);
            if (relativePath === "supabase/production-server-boundary.sql") boundarySha256 = sha;
        }
    } catch (error) {
        if (error instanceof Error && /checkout|source/.test(error.message)) throw error;
        fail("Restore apply checkout was not verified");
    }
    return Object.freeze({
        buildSha: actualBuild,
        boundarySha256,
        sourceSha256: digest("restore.apply-sources", hashes),
    });
}

export function buildRestoreApplyBinding(input) {
    const targetDigest = digest("restore-target", [
        input.targetProjectRef,
        input.targetSupabaseHost,
        input.targetAppHost,
    ]);
    const environmentDigest = digest("restore-environment", [
        input.buildSha,
        targetDigest,
        input.backupManifestSha256,
        input.boundarySha256,
        input.sourceSha256,
    ]);
    return Object.freeze({ targetDigest, environmentDigest });
}

export function resolveRestoreTargetApplyConfig(input = {}) {
    const args = exactArgv(input.argv);
    const env = input.env ?? {};
    if (clean(env.OMR_DEPLOYMENT_TIER) !== "staging") fail("Restore apply requires staging");
    const cwd = resolve(input.cwd ?? process.cwd());
    const backupDir = resolve(args.backup);
    const outputDir = resolve(args["output-dir"]);
    assertPrivateDirectory(backupDir, "Backup directory");
    assertPrivateDirectory(outputDir, "Restore output directory");
    if (backupDir === outputDir || backupDir.startsWith(`${outputDir}${sep}`) || outputDir.startsWith(`${backupDir}${sep}`)) {
        fail("Restore output must be separate from backup");
    }
    assertCompleteBackup(backupDir);
    const manifestRead = readSmallRegularJson(join(backupDir, "manifest.json"), RESTORE_TARGET_APPLY_LIMITS.maxManifestBytes, "Backup manifest");
    const manifest = validateBackupManifest(manifestRead.value);
    const expectedBuild = clean(env.OMR_RESTORE_EXPECTED_BUILD);
    if (!BUILD_SHA.test(expectedBuild) || manifest.gitCommit !== expectedBuild) fail("Restore build is stale or invalid");
    const verifyCheckout = input.verifyCheckout ?? verifyCheckoutAtBuild;
    const checkout = verifyCheckout(cwd, expectedBuild);
    if (checkout?.buildSha !== expectedBuild || !SHA256.test(checkout?.sourceSha256) || !SHA256.test(checkout?.boundarySha256)) {
        fail("Restore apply checkout was not verified");
    }
    const expectedBoundary = clean(env.OMR_RESTORE_EXPECTED_BOUNDARY_SHA256);
    if (!SHA256.test(expectedBoundary) || args["confirm-boundary-sha256"] !== expectedBoundary || checkout.boundarySha256 !== expectedBoundary) {
        fail("Restore boundary hash does not match the exact build");
    }
    const targetSupabase = exactUrl(env.OMR_RESTORE_TARGET_SUPABASE_URL, "Restore target Supabase URL");
    const targetApp = exactUrl(env.OMR_RESTORE_TARGET_APP_URL, "Restore target app URL");
    const productionSupabase = exactUrl(env.OMR_PRODUCTION_SUPABASE_URL, "Production Supabase URL");
    const targetProjectRef = projectRefFromUrl(targetSupabase, "Restore target");
    const productionProjectRef = projectRefFromUrl(productionSupabase, "Production");
    if (
        targetSupabase.hostname !== `${targetProjectRef}.supabase.co`
        || productionSupabase.hostname !== `${productionProjectRef}.supabase.co`
    ) fail("Restore and production Supabase URLs must be canonical");
    if (args["confirm-target-project-ref"] !== targetProjectRef) fail("Restore target confirmation does not match");
    const targetIdentity = assertTargetProjectDiffers(manifest.sourceProjectRefHash, targetProjectRef);
    if (targetProjectRef === productionProjectRef || targetSupabase.hostname === productionSupabase.hostname) {
        fail("Restore target must differ from production");
    }
    if (clean(env.OMR_PRODUCTION_APP_URL)) {
        const productionApp = exactUrl(env.OMR_PRODUCTION_APP_URL, "Production app URL");
        if (productionApp.hostname === targetApp.hostname) fail("Restore app target must differ from production");
    }
    const startedAt = args["started-at"];
    if (Number.isNaN(Date.parse(startedAt)) || new Date(startedAt).toISOString() !== startedAt) fail("Restore started-at is invalid");
    assertRestoreApplyBounds({
        sqlArtifactBytes: [manifest.database.roles.bytes, manifest.database.schema.bytes, manifest.database.data.bytes],
        storageObjectBytes: manifest.storage.objects.map(object => object.bytes),
    });
    const artifacts = Object.freeze(["roles", "schema", "data"].map((kind) => {
        const expected = manifest.database[kind];
        const path = assertContained(backupDir, join(backupDir, "database", expected.file), `Database ${kind}`);
        return Object.freeze({ kind, ...inspectRegularFile(path, `Database ${kind} artifact`, expected.bytes, expected.sha256) });
    }));
    const storageObjects = Object.freeze(manifest.storage.objects.map((object, index) => {
        const path = assertContained(backupDir, join(backupDir, "storage", ...object.path.split("/")), `Storage object ${index}`);
        return Object.freeze({ ...object, ...inspectRegularFile(path, `Storage object ${index}`, object.bytes, object.sha256) });
    }));
    const binding = buildRestoreApplyBinding({
        buildSha: expectedBuild,
        targetProjectRef,
        targetSupabaseHost: targetSupabase.hostname,
        targetAppHost: targetApp.hostname,
        backupManifestSha256: manifestRead.sha256,
        boundarySha256: expectedBoundary,
        sourceSha256: checkout.sourceSha256,
    });
    const safe = {
        environment: "staging",
        buildSha: expectedBuild,
        backupDir,
        outputDir,
        startedAt,
        targetProjectRef,
        targetProjectRefHash: targetIdentity.targetProjectRefHash,
        boundarySha256: expectedBoundary,
        sourceSha256: checkout.sourceSha256,
        backupManifestSha256: manifestRead.sha256,
        targetDigest: binding.targetDigest,
        environmentDigest: binding.environmentDigest,
        manifest,
        artifacts,
        storageObjects,
        postgresBin: resolve(clean(env.OMR_POSTGRES_BIN)),
    };
    const serviceRoleKey = typeof env.OMR_RESTORE_TARGET_SERVICE_ROLE_KEY === "string"
        ? env.OMR_RESTORE_TARGET_SERVICE_ROLE_KEY
        : "";
    const database = {
        host: clean(env.OMR_RESTORE_TARGET_DB_HOST).toLowerCase(),
        port: Number(clean(env.OMR_RESTORE_TARGET_DB_PORT)),
        user: clean(env.OMR_RESTORE_TARGET_DB_USER),
        name: clean(env.OMR_RESTORE_TARGET_DB_NAME),
        password: typeof env.OMR_RESTORE_TARGET_DB_PASSWORD === "string"
            ? env.OMR_RESTORE_TARGET_DB_PASSWORD
            : "",
    };
    const directDatabase = database.host === `db.${targetProjectRef}.supabase.co`
        && database.port === 5432
        && database.user === "postgres";
    const pooledDatabase = /^[a-z0-9-]{1,63}\.pooler\.supabase\.com$/.test(database.host)
        && (database.port === 5432 || database.port === 6543)
        && database.user === `postgres.${targetProjectRef}`;
    if (
        serviceRoleKey.length < 32 || Buffer.byteLength(serviceRoleKey, "utf8") > 8192 || /[\s\u0000-\u001f\u007f]/.test(serviceRoleKey)
        || (!directDatabase && !pooledDatabase)
        || (database.port !== 5432 && database.port !== 6543)
        || database.name !== "postgres"
        || database.password.length < 1 || Buffer.byteLength(database.password, "utf8") > 4096
        || /[\r\n\u0000]/.test(database.password)
        || !isAbsolute(safe.postgresBin)
    ) fail("Restore staging credentials or target database identity are missing or invalid");
    Object.defineProperties(safe, {
        targetSupabaseUrl: { value: targetSupabase.origin },
        targetAppUrl: { value: targetApp.origin },
        serviceRoleKey: { value: serviceRoleKey },
        database: { value: Object.freeze(database) },
        outputIdentity: { value: assertPrivateDirectory(outputDir, "Restore output directory") },
    });
    return Object.freeze(safe);
}

async function hashOpenFd(fd) {
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
        const chunk = Buffer.allocUnsafe(64 * 1024);
        const count = readSync(fd, chunk, 0, chunk.byteLength, bytes);
        if (count === 0) break;
        bytes += count;
        hash.update(chunk.subarray(0, count));
    }
    return { bytes, sha256: hash.digest("hex") };
}

function assertOpenIdentity(artifact, opened) {
    const artifactPath = artifact.localPath ?? artifact.path;
    let pathInfo;
    try { pathInfo = lstatSync(artifactPath); } catch { fail("Restore artifact changed during use"); }
    if (
        !opened.isFile() || opened.nlink !== 1
        || pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1
        || opened.dev !== pathInfo.dev || opened.ino !== pathInfo.ino
        || (artifact.dev !== undefined && (opened.dev !== artifact.dev || opened.ino !== artifact.ino))
        || opened.size !== artifact.bytes || pathInfo.size !== artifact.bytes
    ) fail("Restore artifact identity changed during use");
}

function awaitWritableDrain(writable) {
    return new Promise((resolvePromise, rejectPromise) => {
        const cleanup = () => {
            writable.off("drain", onDrain);
            writable.off("error", onError);
            writable.off("close", onClose);
        };
        const onDrain = () => { cleanup(); resolvePromise(); };
        const onError = (error) => { cleanup(); rejectPromise(error); };
        const onClose = () => { cleanup(); rejectPromise(new Error("destination closed")); };
        writable.once("drain", onDrain);
        writable.once("error", onError);
        writable.once("close", onClose);
    });
}

export async function streamVerifiedArtifact(artifact, writable) {
    if (!artifact || !Number.isInteger(artifact.fd) || !writable || typeof writable.write !== "function") {
        fail("Restore artifact stream is invalid");
    }
    const before = fstatSync(artifact.fd);
    assertOpenIdentity(artifact, before);
    const pre = await hashOpenFd(artifact.fd);
    if (pre.bytes !== artifact.bytes || pre.sha256 !== artifact.sha256) fail("Restore artifact hash or size changed");
    try {
        let position = 0;
        while (position < artifact.bytes) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, artifact.bytes - position));
            const count = readSync(artifact.fd, chunk, 0, chunk.byteLength, position);
            if (count <= 0) fail("Restore artifact ended during streaming");
            position += count;
            const body = count === chunk.byteLength ? chunk : chunk.subarray(0, count);
            if (writable.destroyed) fail("Restore artifact destination closed");
            if (!writable.write(body)) await awaitWritableDrain(writable);
        }
        writable.end();
        await finished(writable);
    } catch {
        writable.destroy?.();
        fail("Restore artifact streaming failed");
    }
    const after = fstatSync(artifact.fd);
    assertOpenIdentity(artifact, after);
    const post = await hashOpenFd(artifact.fd);
    if (post.bytes !== artifact.bytes || post.sha256 !== artifact.sha256) fail("Restore artifact changed after streaming");
    return Object.freeze(post);
}

function escapePgPass(value) {
    return String(value).replaceAll("\\", "\\\\").replaceAll(":", "\\:");
}

function defaultSpawnPsql(config, passFile, kind) {
    return spawn(join(config.postgresBin, "psql"), [
        "-X", "--no-psqlrc", "--no-password", "--set=ON_ERROR_STOP=1",
        "--host", config.database.host,
        "--port", String(config.database.port),
        "--username", config.database.user,
        "--dbname", config.database.name,
    ], {
        shell: false,
        env: {
            PATH: process.env.PATH ?? "",
            LC_ALL: "C",
            LANG: "C",
            PGAPPNAME: `omr-restore-apply-${kind}`,
            PGCONNECT_TIMEOUT: "10",
            PGPASSFILE: passFile,
            PGSSLMODE: "verify-full",
            PGSSLROOTCERT: "system",
        },
        stdio: ["pipe", "pipe", "pipe"],
    });
}

async function applyOneSql(config, artifact, spawnPsql, limits, passFile) {
    let fd;
    let child;
    let timer;
    let childClosed = false;
    let childClosedPromise = Promise.resolve();
    try {
        fd = openSync(artifact.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const opened = fstatSync(fd);
        assertOpenIdentity(artifact, opened);
        child = spawnPsql({ kind: artifact.kind, config, passFile }) ?? fail("PostgreSQL apply process is unavailable");
        if (!child.stdin || !child.stdout || !child.stderr || typeof child.once !== "function") fail("PostgreSQL apply process is invalid");
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let overflow = false;
        child.stdout.on("data", (chunk) => {
            stdoutBytes += Buffer.byteLength(chunk);
            if (stdoutBytes > limits.maxChildStdoutBytes) { overflow = true; child.kill?.("SIGKILL"); }
        });
        child.stderr.on("data", (chunk) => {
            stderrBytes += Buffer.byteLength(chunk);
            if (stderrBytes > limits.maxChildStderrBytes) { overflow = true; child.kill?.("SIGKILL"); }
        });
        childClosedPromise = new Promise(resolvePromise => child.once("close", () => {
            childClosed = true;
            resolvePromise();
        }));
        const completion = new Promise((resolvePromise, rejectPromise) => {
            child.once("error", () => rejectPromise(new Error("PostgreSQL apply process failed")));
            child.once("close", (code, signal) => {
                if (overflow) rejectPromise(new Error("PostgreSQL apply process output exceeded its bound"));
                else if (code !== 0 || signal) rejectPromise(new Error("PostgreSQL apply process failed"));
                else resolvePromise();
            });
        });
        const timeout = new Promise((_, rejectPromise) => {
            timer = setTimeout(() => {
                child.kill?.("SIGKILL");
                rejectPromise(new Error("PostgreSQL apply process timed out"));
            }, limits.maxChildRuntimeMs);
            timer.unref?.();
        });
        await Promise.race([
            Promise.all([streamVerifiedArtifact({ ...artifact, fd }, child.stdin), completion]),
            timeout,
        ]);
    } catch (error) {
        child?.kill?.("SIGKILL");
        if (child && !childClosed) {
            await Promise.race([
                childClosedPromise,
                new Promise(resolvePromise => setTimeout(resolvePromise, 2_000)),
            ]);
        }
        if (error instanceof Error && /output|timed out/.test(error.message)) throw error;
        fail("PostgreSQL restore apply failed");
    } finally {
        if (timer) clearTimeout(timer);
        if (fd !== undefined) closeSync(fd);
    }
}

async function defaultUploadStorageObject(config, object, body, signal) {
    const encodedPath = object.path.split("/").map(encodeURIComponent).join("/");
    const metadataJson = JSON.stringify({ sha256Hex: object.sha256 });
    const metadataHeader = Buffer.from(metadataJson, "utf8").toString("base64");
    if (Buffer.byteLength(metadataJson, "utf8") > 192 || Buffer.byteLength(metadataHeader, "ascii") > 256) {
        fail("Storage upload metadata is invalid");
    }
    let response;
    try {
        response = await fetch(`${config.targetSupabaseUrl}/storage/v1/object/${encodeURIComponent(config.manifest.storage.bucket)}/${encodedPath}`, {
            method: "POST",
            headers: {
                authorization: `Bearer ${config.serviceRoleKey}`,
                apikey: config.serviceRoleKey,
                "content-type": object.contentType,
                "x-metadata": metadataHeader,
                "x-upsert": "true",
            },
            body,
            duplex: "half",
            signal,
        });
    } catch {
        fail("Storage upload failed");
    }
    if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        fail("Storage upload failed");
    }
    await response.body?.cancel().catch(() => undefined);
}

async function uploadOne(config, object, uploadStorageObject, limits) {
    let fd;
    const { PassThrough } = await import("node:stream");
    const abortController = new AbortController();
    let timer;
    let body;
    let streamOperation;
    let uploadOperation;
    try {
        fd = openSync(object.localPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        assertOpenIdentity(object, fstatSync(fd));
        body = new PassThrough({ highWaterMark: 64 * 1024 });
        streamOperation = streamVerifiedArtifact({ ...object, fd }, body);
        uploadOperation = Promise.resolve().then(() => uploadStorageObject({
                bucket: config.manifest.storage.bucket,
                path: object.path,
                contentType: object.contentType,
                bytes: object.bytes,
                sha256: object.sha256,
                body,
                signal: abortController.signal,
                config,
            }));
        const timeoutOperation = new Promise((_, rejectPromise) => {
            timer = setTimeout(() => {
                abortController.abort();
                rejectPromise(new Error("Storage upload timed out"));
            }, limits.maxStorageUploadRuntimeMs);
            timer.unref?.();
        });
        await Promise.race([Promise.all([streamOperation, uploadOperation]), timeoutOperation]);
    } catch (error) {
        abortController.abort();
        body?.destroy();
        await Promise.allSettled([streamOperation, uploadOperation].filter(Boolean));
        if (error instanceof Error && /timed out/.test(error.message)) throw error;
        fail("Storage restore upload failed");
    } finally {
        if (timer) clearTimeout(timer);
        if (fd !== undefined) closeSync(fd);
    }
}

async function uploadStorage(config, uploadStorageObject, limits) {
    let cursor = 0;
    let stopped = false;
    async function worker() {
        while (!stopped) {
            const index = cursor;
            cursor += 1;
            if (index >= config.storageObjects.length) return;
            try {
                await uploadOne(config, config.storageObjects[index], uploadStorageObject, limits);
            } catch (error) {
                stopped = true;
                throw error;
            }
        }
    }
    const outcomes = await Promise.allSettled(
        Array.from({ length: Math.min(limits.uploadConcurrency, config.storageObjects.length) }, worker),
    );
    const failure = outcomes.find(outcome => outcome.status === "rejected");
    if (failure) throw failure.reason;
}

export function createRestoreApplyMarker(config) {
    return Object.freeze({
        schemaVersion: 1,
        status: "incomplete",
        buildSha: config.buildSha,
        environmentDigest: config.environmentDigest,
        targetDigest: config.targetDigest,
        backupManifestSha256: config.backupManifestSha256,
        boundarySha256: config.boundarySha256,
        targetProjectRefHash: config.targetProjectRefHash,
        startedAt: config.startedAt,
    });
}

function exactMarker(value, expected) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("Restore apply marker is invalid");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Object.keys(expected).sort();
    const actual = Object.keys(descriptors).sort();
    if (
        keys.length !== actual.length || keys.some((key, index) => key !== actual[index])
        || Object.values(descriptors).some(descriptor => !("value" in descriptor))
        || keys.some(key => value[key] !== expected[key])
    ) fail("Restore apply marker binding is invalid");
    return value;
}

export function readRestoreApplyMarker(config) {
    const path = join(config.outputDir ?? dirname(config.outputPath), ".INCOMPLETE");
    return exactMarker(readSmallRegularJson(path, 8 * 1024, "Restore apply marker").value, createRestoreApplyMarker(config));
}

function ensureApplyMarker(config) {
    const markerPath = join(config.outputDir, ".INCOMPLETE");
    const marker = createRestoreApplyMarker(config);
    assertExactDirectory(config.outputDir, config.outputIdentity, "Restore output directory");
    if (existsSync(join(config.outputDir, ".RESTORE_COMPLETE"))) fail("Restore is already marked complete");
    if (existsSync(markerPath)) {
        readRestoreApplyMarker(config);
        assertExactDirectory(config.outputDir, config.outputIdentity, "Restore output directory");
        return marker;
    }
    let markerFd;
    let parentFd;
    try {
        markerFd = openSync(
            markerPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
        );
        writeSync(markerFd, `${JSON.stringify(marker)}\n`, null, "utf8");
        fsyncSync(markerFd);
        chmodSync(markerPath, 0o600);
        parentFd = openSync(config.outputDir, constants.O_RDONLY | constants.O_NOFOLLOW);
        fsyncSync(parentFd);
        assertExactDirectory(config.outputDir, config.outputIdentity, "Restore output directory");
    } catch {
        fail("Restore apply marker could not be created");
    } finally {
        if (markerFd !== undefined) closeSync(markerFd);
        if (parentFd !== undefined) closeSync(parentFd);
    }
    return marker;
}

function effectiveLimits(overrides) {
    const result = { ...RESTORE_TARGET_APPLY_LIMITS };
    if (overrides !== undefined) {
        if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) fail("Restore limits override is invalid");
        for (const [key, value] of Object.entries(overrides)) {
            if (!Object.hasOwn(result, key) || !Number.isSafeInteger(value) || value < 1 || value > result[key]) {
                fail("Restore limits override is invalid");
            }
            result[key] = value;
        }
    }
    return Object.freeze(result);
}

export async function runRestoreTargetApply(config, dependencies = {}) {
    ensureApplyMarker(config);
    const limits = effectiveLimits(dependencies.limits);
    const useDefaultPsql = typeof dependencies.spawnPsql !== "function";
    const spawnPsql = dependencies.spawnPsql ?? (({ kind, passFile }) => defaultSpawnPsql(config, passFile, kind));
    const uploadStorageObject = dependencies.uploadStorageObject
        ?? (({ body, signal, ...object }) => defaultUploadStorageObject(config, object, body, signal));
    let credentialDir;
    let passFile = "";
    try {
        if (useDefaultPsql) {
            let version;
            try {
                version = execFileSync(join(config.postgresBin, "psql"), ["--version"], {
                    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000, maxBuffer: 4096,
                });
            } catch { fail("PostgreSQL 17 apply tool is unavailable"); }
            if (!/\(PostgreSQL\)\s+17(?:\.|\s|$)/.test(version)) fail("PostgreSQL 17 apply tool is required");
            credentialDir = mkdtempSync(join(tmpdir(), "omr-restore-apply-pg-"));
            chmodSync(credentialDir, 0o700);
            passFile = join(credentialDir, "pgpass");
            writeFileSync(passFile, `${[
                config.database.host,
                config.database.port,
                config.database.name,
                config.database.user,
                config.database.password,
            ].map(escapePgPass).join(":")}\n`, { mode: 0o600, flag: "wx" });
        }
        for (const artifact of config.artifacts) {
            await applyOneSql(config, artifact, spawnPsql, limits, passFile);
        }
        await uploadStorage(config, uploadStorageObject, limits);
        assertExactDirectory(config.outputDir, config.outputIdentity, "Restore output directory");
        readRestoreApplyMarker(config);
        assertExactDirectory(config.outputDir, config.outputIdentity, "Restore output directory");
        const result = Object.freeze({
            status: "restored",
            buildSha: config.buildSha,
            environmentDigest: config.environmentDigest,
            targetDigest: config.targetDigest,
            backupManifestSha256: config.backupManifestSha256,
            boundarySha256: config.boundarySha256,
            targetProjectRefHash: config.targetProjectRefHash,
            storageObjectCount: config.manifest.storage.objectCount,
            storageBytes: config.manifest.storage.totalBytes,
            completedAt: (dependencies.now?.() ?? new Date()).toISOString(),
        });
        return result;
    } catch (error) {
        if (error instanceof Error && /output|timed out|Storage|PostgreSQL|Restore/.test(error.message)) throw error;
        throw new Error("Restore target apply failed", { cause: error });
    } finally {
        if (credentialDir) rmSync(credentialDir, { recursive: true, force: true });
    }
}

export function formatRestoreApplyStatusLine(value) {
    const keys = [
        "status", "buildSha", "environmentDigest", "targetDigest", "backupManifestSha256",
        "boundarySha256", "targetProjectRefHash", "storageObjectCount", "storageBytes", "completedAt",
    ];
    if (!value || typeof value !== "object" || keys.some(key => !Object.hasOwn(value, key))) fail("Restore apply result is invalid");
    const safe = { schemaVersion: 1 };
    for (const key of keys) safe[key] = value[key];
    const line = `${JSON.stringify(safe)}\n`;
    if (Buffer.byteLength(line, "utf8") > 4096 || line.split("\n").length !== 2) fail("Restore apply status is not bounded");
    return line;
}
