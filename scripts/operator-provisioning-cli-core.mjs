import { createHash, pbkdf2, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, link, open, realpath, readdir, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, parse, sep } from "node:path";
import { createClient } from "@supabase/supabase-js";

const REQUEST_MAX_BYTES = 32 * 1024;
const SECRET_FILE_MAX_BYTES = 16 * 1024;
const SUPABASE_TIMEOUT_MS = 10_000;
const PASSWORD_PATTERN = /^Omr-[A-Za-z0-9_-]{24,120}!$/;
const VERIFIER_PATTERN = /^pbkdf2-sha256:120000:[a-f0-9]{32}:[a-f0-9]{64}$/;
const ORGANIZATION_ID_PATTERN = /^pilot_org_[a-f0-9]{24}$/;
const ACCOUNT_ID_PATTERN = /^teacher_[a-f0-9]{16}$/;
const GRANT_ID_PATTERN = /^pilot_grant_[a-f0-9]{24}$/;
const INPUT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RESULT_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const REQUEST_KEYS = [
    "actor", "credentialStatePath", "displayName", "email", "expiresAt",
    "idempotencyKey", "organizationName", "plan", "reason",
];
const PENDING_KEYS = [
    "createdAt", "idempotencyKey", "initialPassword", "integrity", "passwordVerifier",
    "requestFingerprint", "schemaVersion", "status",
];
const RECEIPT_KEYS = [
    "accountId", "expiresAt", "grantId", "idempotencyKeyHash", "initialPassword",
    "integrity", "organizationId", "plan", "replayed", "requestFingerprint", "schemaVersion", "status",
];
const SAFE_CODES = new Set([
    "invalid_arguments", "unsupported_platform", "unsafe_request", "invalid_request",
    "unsafe_state", "unsafe_receipt", "dependency_unavailable", "provisioning_rejected",
]);

export class OperatorProvisioningCliError extends Error {
    constructor(code, _unsafeDetail) {
        super("Operator provisioning did not complete");
        void _unsafeDetail;
        this.name = "OperatorProvisioningCliError";
        this.code = code;
    }
}

function fail(code) {
    throw new OperatorProvisioningCliError(code);
}

function exactObject(value, keys, code) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
    return value;
}

function clean(value) {
    return typeof value === "string" ? value.trim() : "";
}

function canonicalize(value) {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
    }
    return value;
}

function sha256(value) {
    return createHash("sha256").update(value, "utf8").digest("hex");
}

function integrity(domain, value) {
    const unsigned = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "integrity"));
    return `sha256:${sha256(`${domain}\0${JSON.stringify(canonicalize(unsigned))}`)}`;
}

function defaultPassword() {
    return `Omr-${randomBytes(24).toString("base64url")}!`;
}

function hashPassword(password, salt = randomBytes(16)) {
    return new Promise((resolve, reject) => {
        pbkdf2(password, salt, 120_000, 32, "sha256", (error, hash) => {
            if (error) reject(error);
            else resolve(`pbkdf2-sha256:120000:${salt.toString("hex")}:${hash.toString("hex")}`);
        });
    });
}

export function createOperatorProvisioningDeadlineFetch(
    timeoutMs,
    fetchImplementation = globalThis.fetch.bind(globalThis),
) {
    return async (input, init = {}) => {
        const controller = new AbortController();
        const callerSignal = init.signal;
        const forwardAbort = () => controller.abort(callerSignal?.reason);
        if (callerSignal?.aborted) forwardAbort();
        else callerSignal?.addEventListener("abort", forwardAbort, { once: true });
        const timer = setTimeout(() => {
            controller.abort(new DOMException("Supabase provisioning request timed out", "TimeoutError"));
        }, timeoutMs);
        try {
            return await fetchImplementation(input, { ...init, signal: controller.signal });
        } finally {
            clearTimeout(timer);
            callerSignal?.removeEventListener("abort", forwardAbort);
        }
    };
}

const DEFAULT_FS = { lstat, link, open, realpath, readdir, unlink };
const DEFAULT_DEPS = {
    currentUid: () => process.getuid?.(),
    currentPid: () => process.pid,
    isProcessAlive: (pid) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch (error) {
            return error?.code !== "ESRCH";
        }
    },
    platform: process.platform,
    now: () => new Date(),
    generatePassword: defaultPassword,
    generateTempName: () => randomBytes(16).toString("hex"),
    hashPassword,
    checkpoint: async () => {},
    fs: DEFAULT_FS,
};

function withDependencies(overrides = {}) {
    return {
        ...DEFAULT_DEPS,
        ...overrides,
        fs: { ...DEFAULT_FS, ...overrides.fs },
    };
}

function normalizedAbsolutePath(value, code) {
    if (
        typeof value !== "string"
        || !isAbsolute(value)
        || normalize(value) !== value
        || value.endsWith(sep)
        || Buffer.byteLength(value, "utf8") > 4096
    ) fail(code);
    return value;
}

async function safeParentBoundary(filePath, deps, code) {
    const parentPath = dirname(filePath);
    const uid = deps.currentUid();
    if (!Number.isInteger(uid) || uid < 0) fail(code);
    let parent;
    try {
        const root = parse(parentPath).root;
        const rootStats = await deps.fs.lstat(root);
        if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || (rootStats.mode & 0o022) !== 0) fail(code);
        let current = root;
        for (const segment of parentPath.slice(root.length).split(sep).filter(Boolean)) {
            current = current === root ? `${root}${segment}` : `${current}${sep}${segment}`;
            const stats = await deps.fs.lstat(current);
            if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o022) !== 0) fail(code);
            if (current === parentPath) parent = stats;
        }
        if (await deps.fs.realpath(parentPath) !== parentPath) fail(code);
    } catch (error) {
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail(code);
    }
    if (!parent || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) fail(code);
    return { parentPath, uid, dev: parent.dev, ino: parent.ino, realpath: parentPath };
}

async function sameParent(boundary, deps) {
    try {
        const stats = await deps.fs.lstat(boundary.parentPath);
        return stats.isDirectory()
            && !stats.isSymbolicLink()
            && stats.uid === boundary.uid
            && stats.dev === boundary.dev
            && stats.ino === boundary.ino
            && (stats.mode & 0o777) === 0o700
            && await deps.fs.realpath(boundary.parentPath) === boundary.realpath;
    } catch {
        return false;
    }
}

function safeRegularStats(stats, boundary, maximumBytes, allowEmpty = false) {
    return stats.isFile()
        && !stats.isSymbolicLink()
        && stats.uid === boundary.uid
        && (stats.mode & 0o777) === 0o600
        && stats.nlink === 1
        && stats.size <= maximumBytes
        && (allowEmpty || stats.size > 0);
}

async function readAtMost(handle, maximumBytes) {
    const buffer = Buffer.alloc(maximumBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
    }
    if (offset > maximumBytes) throw new Error("bounded read exceeded");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
}

async function readSecureJson(filePath, deps, code, maximumBytes, knownBoundary) {
    normalizedAbsolutePath(filePath, code);
    const boundary = knownBoundary ?? await safeParentBoundary(filePath, deps, code);
    if (!await sameParent(boundary, deps)) fail(code);
    let handle;
    try {
        const before = await deps.fs.lstat(filePath);
        if (!safeRegularStats(before, boundary, maximumBytes)) fail(code);
        if (await deps.fs.realpath(filePath) !== filePath) fail(code);
        handle = await deps.fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        if (
            typeof handle.stat !== "function"
            || typeof handle.read !== "function"
            || typeof handle.close !== "function"
        ) fail(code);
        const opened = await handle.stat();
        if (
            !safeRegularStats(opened, boundary, maximumBytes)
            || opened.dev !== before.dev
            || opened.ino !== before.ino
            || opened.size !== before.size
        ) fail(code);
        const serialized = await readAtMost(handle, maximumBytes);
        const after = await handle.stat();
        if (
            !safeRegularStats(after, boundary, maximumBytes)
            || after.dev !== opened.dev
            || after.ino !== opened.ino
            || after.size !== opened.size
            || Buffer.byteLength(serialized, "utf8") !== after.size
        ) fail(code);
        await handle.close();
        handle = undefined;
        return { value: JSON.parse(serialized), stats: after, boundary };
    } catch (error) {
        if (handle) {
            try { await handle.close(); } catch { /* fail closed */ }
        }
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail(code);
    }
}

async function pathState(path, deps) {
    try {
        return { exists: true, stats: await deps.fs.lstat(path) };
    } catch (error) {
        if (error?.code === "ENOENT") return { exists: false };
        throw error;
    }
}

async function repairInterruptedPublication(filePath, boundary, deps, code) {
    let published;
    try {
        published = await deps.fs.lstat(filePath);
    } catch (error) {
        if (error?.code === "ENOENT") return;
        fail(code);
    }
    if (published.nlink === 1) return;
    if (
        published.nlink !== 2
        || !published.isFile()
        || published.isSymbolicLink()
        || published.uid !== boundary.uid
        || (published.mode & 0o777) !== 0o600
        || published.size < 1
        || published.size > SECRET_FILE_MAX_BYTES
        || !await sameParent(boundary, deps)
    ) fail(code);
    const prefix = `.${basename(filePath)}.`;
    let names;
    try { names = await deps.fs.readdir(boundary.parentPath); } catch { fail(code); }
    const candidates = [];
    for (const name of names) {
        if (!name.startsWith(prefix) || !/^[a-f0-9]{32}\.tmp$/.test(name.slice(prefix.length))) continue;
        const candidatePath = `${boundary.parentPath}${sep}${name}`;
        let stats;
        try { stats = await deps.fs.lstat(candidatePath); } catch { fail(code); }
        if (stats.dev === published.dev && stats.ino === published.ino) {
            if (
                !stats.isFile()
                || stats.isSymbolicLink()
                || stats.uid !== boundary.uid
                || (stats.mode & 0o777) !== 0o600
                || stats.nlink !== 2
                || stats.size !== published.size
            ) fail(code);
            candidates.push({ path: candidatePath, stats });
        }
    }
    if (candidates.length !== 1) fail(code);
    try {
        const current = await deps.fs.lstat(filePath);
        if (current.dev !== published.dev || current.ino !== published.ino || current.nlink !== 2) fail(code);
        await deps.fs.unlink(candidates[0].path);
        const repaired = await deps.fs.lstat(filePath);
        if (
            !safeRegularStats(repaired, boundary, SECRET_FILE_MAX_BYTES)
            || repaired.dev !== published.dev
            || repaired.ino !== published.ino
        ) fail(code);
        await syncDirectory(boundary, deps, code);
    } catch (error) {
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail(code);
    }
}

async function syncDirectory(boundary, deps, code) {
    let handle;
    try {
        if (!await sameParent(boundary, deps)) fail(code);
        handle = await deps.fs.open(boundary.parentPath, "r");
        if (typeof handle.sync !== "function" || typeof handle.close !== "function") fail(code);
        await handle.sync();
        await handle.close();
        handle = undefined;
    } catch (error) {
        if (handle) {
            try { await handle.close(); } catch { /* fail closed */ }
        }
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail(code);
    }
}

async function atomicPublish(targetPath, value, boundary, deps, code) {
    if (!await sameParent(boundary, deps)) fail(code);
    const existing = await pathState(targetPath, deps).catch(() => fail(code));
    if (existing.exists) fail(code);
    const temporaryId = deps.generateTempName();
    if (!/^[a-f0-9]{32}$/.test(temporaryId)) fail(code);
    const temporaryPath = `${boundary.parentPath}${sep}.${basename(targetPath)}.${temporaryId}.tmp`;
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > SECRET_FILE_MAX_BYTES) fail(code);
    let handle;
    let owned;
    let tempPresent = false;
    let finalLinked = false;
    try {
        handle = await deps.fs.open(temporaryPath, "wx", 0o600);
        tempPresent = true;
        owned = await handle.stat();
        if (!safeRegularStats(owned, boundary, SECRET_FILE_MAX_BYTES, true) || owned.size !== 0) fail(code);
        if (
            typeof handle.chmod !== "function"
            || typeof handle.writeFile !== "function"
            || typeof handle.sync !== "function"
            || typeof handle.stat !== "function"
            || typeof handle.close !== "function"
        ) fail(code);
        await handle.chmod(0o600);
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
        const written = await handle.stat();
        if (
            !safeRegularStats(written, boundary, SECRET_FILE_MAX_BYTES)
            || written.dev !== owned.dev
            || written.ino !== owned.ino
            || written.size !== Buffer.byteLength(serialized, "utf8")
        ) fail(code);
        await handle.close();
        handle = undefined;
        if (!await sameParent(boundary, deps)) fail(code);
        await deps.fs.link(temporaryPath, targetPath);
        finalLinked = true;
        const published = await deps.fs.lstat(targetPath);
        if (
            !published.isFile()
            || published.isSymbolicLink()
            || published.uid !== boundary.uid
            || published.dev !== owned.dev
            || published.ino !== owned.ino
            || (published.mode & 0o777) !== 0o600
            || published.nlink !== 2
            || published.size !== written.size
        ) fail(code);
        await deps.fs.unlink(temporaryPath);
        tempPresent = false;
        const finalized = await deps.fs.lstat(targetPath);
        if (!safeRegularStats(finalized, boundary, SECRET_FILE_MAX_BYTES) || finalized.ino !== owned.ino) fail(code);
        await syncDirectory(boundary, deps, code);
        return finalized;
    } catch (error) {
        if (handle) {
            try { await handle.close(); } catch { /* fail closed */ }
        }
        if (finalLinked && owned) {
            try {
                const stats = await deps.fs.lstat(targetPath);
                if (stats.dev === owned.dev && stats.ino === owned.ino) await deps.fs.unlink(targetPath);
            } catch { /* inode-bound cleanup only */ }
        }
        if (tempPresent && owned) {
            try {
                const stats = await deps.fs.lstat(temporaryPath);
                if (stats.dev === owned.dev && stats.ino === owned.ino) await deps.fs.unlink(temporaryPath);
            } catch { /* inode-bound cleanup only */ }
        }
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail(code);
    }
}

async function safeUnlink(filePath, expectedStats, boundary, deps, code) {
    try {
        if (!await sameParent(boundary, deps)) fail(code);
        const current = await deps.fs.lstat(filePath);
        if (
            !safeRegularStats(current, boundary, SECRET_FILE_MAX_BYTES)
            || current.dev !== expectedStats.dev
            || current.ino !== expectedStats.ino
        ) fail(code);
        await deps.fs.unlink(filePath);
        await syncDirectory(boundary, deps, code);
    } catch (error) {
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail(code);
    }
}

async function acquireLock(statePath, boundary, deps, recovered = false) {
    const lockPath = `${statePath}.lock`;
    if (!await sameParent(boundary, deps)) fail("unsafe_state");
    let handle;
    try {
        handle = await deps.fs.open(lockPath, "wx", 0o600);
        const initial = await handle.stat();
        if (!safeRegularStats(initial, boundary, 0, true) || initial.size !== 0) fail("unsafe_state");
        const pid = deps.currentPid();
        const createdAt = deps.now();
        const nonce = deps.generateTempName();
        if (
            !Number.isSafeInteger(pid) || pid < 1
            || !(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())
            || !/^[a-f0-9]{32}$/.test(nonce)
            || typeof handle.writeFile !== "function"
            || typeof handle.sync !== "function"
        ) fail("unsafe_state");
        const serialized = `${JSON.stringify({
            schemaVersion: 1,
            pid,
            createdAt: createdAt.toISOString(),
            nonce,
        })}\n`;
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
        const stats = await handle.stat();
        if (
            !safeRegularStats(stats, boundary, 1024)
            || stats.dev !== initial.dev
            || stats.ino !== initial.ino
            || stats.size !== Buffer.byteLength(serialized, "utf8")
        ) fail("unsafe_state");
        return { path: lockPath, handle, stats, boundary };
    } catch (error) {
        if (handle) {
            try { await handle.close(); } catch { /* fail closed */ }
        }
        if (error instanceof OperatorProvisioningCliError) throw error;
        if (error?.code === "EEXIST" && !recovered) {
            const lockFile = await readSecureJson(lockPath, deps, "unsafe_state", 1024, boundary);
            const value = exactObject(lockFile.value, ["createdAt", "nonce", "pid", "schemaVersion"], "unsafe_state");
            if (
                value.schemaVersion !== 1
                || !Number.isSafeInteger(value.pid)
                || value.pid < 1
                || !INPUT_TIMESTAMP_PATTERN.test(value.createdAt)
                || !Number.isFinite(Date.parse(value.createdAt))
                || !/^[a-f0-9]{32}$/.test(value.nonce)
            ) fail("unsafe_state");
            if (deps.isProcessAlive(value.pid)) fail("unsafe_state");
            await safeUnlink(lockPath, lockFile.stats, boundary, deps, "unsafe_state");
            return acquireLock(statePath, boundary, deps, true);
        }
        fail("unsafe_state");
    }
}

async function releaseLock(lock, deps) {
    try {
        await lock.handle.close();
        const stats = await deps.fs.lstat(lock.path);
        if (
            !safeRegularStats(stats, lock.boundary, 1024)
            || stats.dev !== lock.stats.dev
            || stats.ino !== lock.stats.ino
            || stats.size !== lock.stats.size
        ) fail("unsafe_state");
        await deps.fs.unlink(lock.path);
        await syncDirectory(lock.boundary, deps, "unsafe_state");
    } catch (error) {
        if (error instanceof OperatorProvisioningCliError) throw error;
        fail("unsafe_state");
    }
}

function validateRequest(raw, now) {
    const value = exactObject(raw, REQUEST_KEYS, "invalid_request");
    const organizationName = clean(value.organizationName);
    const email = clean(value.email).toLowerCase();
    const displayName = clean(value.displayName);
    const plan = clean(value.plan).toLowerCase();
    const expiresAt = clean(value.expiresAt);
    const actor = clean(value.actor);
    const reason = clean(value.reason);
    const idempotencyKey = clean(value.idempotencyKey);
    const credentialStatePath = normalizedAbsolutePath(value.credentialStatePath, "invalid_request");
    const expiresAtMs = Date.parse(expiresAt);
    if (
        organizationName.length < 1 || organizationName.length > 120
        || Buffer.byteLength(organizationName, "utf8") > 360 || /[\u0000-\u001f\u007f]/.test(organizationName)
        || email.length < 3 || email.length > 254 || Buffer.byteLength(email, "utf8") > 254
        || CONTROL_CHARACTER_PATTERN.test(email)
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
        || displayName.length < 1 || displayName.length > 80
        || Buffer.byteLength(displayName, "utf8") > 240 || /[\u0000-\u001f\u007f]/.test(displayName)
        || (plan !== "pro" && plan !== "academy")
        || !INPUT_TIMESTAMP_PATTERN.test(expiresAt) || !Number.isFinite(expiresAtMs)
        || new Date(expiresAtMs).toISOString() !== expiresAt
        || expiresAtMs <= now.getTime() || expiresAtMs > now.getTime() + 366 * 24 * 60 * 60 * 1_000
        || actor.length < 10 || actor.length > 73 || !/^operator:[a-z0-9][a-z0-9._-]{0,63}$/.test(actor)
        || reason.length < 1 || reason.length > 64 || !/^[a-z][a-z0-9_]{0,63}$/.test(reason)
        || Buffer.byteLength(idempotencyKey, "utf8") < 37 || Buffer.byteLength(idempotencyKey, "utf8") > 128
        || !/^prov_[A-Za-z0-9_-]{32,123}$/.test(idempotencyKey)
    ) fail("invalid_request");
    const provisioningInput = {
        organizationName, email, displayName, plan, expiresAt, actor, reason, idempotencyKey,
    };
    return {
        ...provisioningInput,
        credentialStatePath,
        requestFingerprint: sha256(JSON.stringify(canonicalize(provisioningInput))),
    };
}

function validatePending(raw, request) {
    const value = exactObject(raw, PENDING_KEYS, "unsafe_state");
    if (
        value.schemaVersion !== 1
        || value.status !== "pending"
        || value.requestFingerprint !== request.requestFingerprint
        || value.idempotencyKey !== request.idempotencyKey
        || value.integrity !== integrity("omr.operator-provisioning-pending:v1", value)
        || !PASSWORD_PATTERN.test(value.initialPassword)
        || !VERIFIER_PATTERN.test(value.passwordVerifier)
        || !INPUT_TIMESTAMP_PATTERN.test(value.createdAt)
        || !Number.isFinite(Date.parse(value.createdAt))
    ) fail("unsafe_state");
    return value;
}

function validateReceipt(raw, request) {
    const value = exactObject(raw, RECEIPT_KEYS, "unsafe_receipt");
    if (
        value.schemaVersion !== 1
        || value.status !== "provisioned"
        || value.requestFingerprint !== request.requestFingerprint
        || value.idempotencyKeyHash !== sha256(request.idempotencyKey)
        || value.integrity !== integrity("omr.operator-provisioning-receipt:v1", value)
        || !PASSWORD_PATTERN.test(value.initialPassword)
        || !ORGANIZATION_ID_PATTERN.test(value.organizationId)
        || !ACCOUNT_ID_PATTERN.test(value.accountId)
        || !GRANT_ID_PATTERN.test(value.grantId)
        || (value.plan !== "pro" && value.plan !== "academy")
        || !RESULT_TIMESTAMP_PATTERN.test(value.expiresAt)
        || !Number.isFinite(Date.parse(value.expiresAt))
        || typeof value.replayed !== "boolean"
    ) fail("unsafe_receipt");
    return value;
}

function validateProvisionedResult(value, request) {
    if (
        !value || value.status !== "provisioned"
        || !ORGANIZATION_ID_PATTERN.test(value.organizationId)
        || !ACCOUNT_ID_PATTERN.test(value.accountId)
        || !GRANT_ID_PATTERN.test(value.grantId)
        || (value.plan !== "pro" && value.plan !== "academy")
        || !RESULT_TIMESTAMP_PATTERN.test(value.expiresAt)
        || !Number.isFinite(Date.parse(value.expiresAt))
        || value.plan !== request.plan
        || Date.parse(value.expiresAt) !== Date.parse(request.expiresAt)
        || typeof value.replayed !== "boolean"
    ) fail("dependency_unavailable");
    return value;
}

function publicResult(receiptPath, value) {
    return {
        status: "provisioned",
        receiptPath,
        organizationId: value.organizationId,
        accountId: value.accountId,
        grantId: value.grantId,
        plan: value.plan,
        expiresAt: value.expiresAt,
        replayed: value.replayed,
    };
}

async function defaultProvisionWithVerifier(input, env) {
    const url = clean(env.SUPABASE_URL) || clean(env.NEXT_PUBLIC_SUPABASE_URL);
    const serviceRoleKey = clean(env.SUPABASE_SERVICE_ROLE_KEY) || clean(env.OMR_SUPABASE_SERVICE_ROLE_KEY);
    if (!url || serviceRoleKey.length < 32 || /\s/.test(serviceRoleKey)) {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
    let endpoint;
    try { endpoint = new URL(url); } catch { return { status: "unavailable", error: "dependency_unavailable" }; }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password) {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
    try {
        const client = createClient(endpoint.href, serviceRoleKey, {
            auth: { persistSession: false, autoRefreshToken: false },
            global: { fetch: createOperatorProvisioningDeadlineFetch(SUPABASE_TIMEOUT_MS) },
        });
        const result = await client.rpc("omr_provision_pilot_teacher_v1", {
            p_organization_name: input.organizationName,
            p_email: input.email,
            p_display_name: input.displayName,
            p_password_hash: input.encodedVerifier,
            p_plan: input.plan,
            p_expires_at: input.expiresAt,
            p_actor: input.actor,
            p_reason: input.reason,
            p_idempotency_key: input.idempotencyKey,
        });
        if (result.error) {
            const message = clean(result.error.message);
            if (message === "invalid_provisioning_request") return { status: "rejected", error: "invalid_input" };
            if (message === "idempotency_conflict" || message === "provisioning_conflict") {
                return { status: "rejected", error: "conflict" };
            }
            if (message === "capacity_exceeded") return { status: "rejected", error: "capacity_exceeded" };
            return { status: "unavailable", error: "dependency_unavailable" };
        }
        const row = Array.isArray(result.data) ? result.data[0] : result.data;
        return { status: "provisioned", ...row };
    } catch {
        return { status: "unavailable", error: "dependency_unavailable" };
    }
}

async function existingSecureFile(path, deps, code, boundary) {
    let state;
    try { state = await pathState(path, deps); } catch { fail(code); }
    if (!state.exists) return null;
    await repairInterruptedPublication(path, boundary, deps, code);
    return readSecureJson(path, deps, code, SECRET_FILE_MAX_BYTES, boundary);
}

async function cleanupPendingIfPresent(statePath, request, expectedPassword, stateBoundary, deps) {
    const pendingFile = await existingSecureFile(statePath, deps, "unsafe_state", stateBoundary);
    if (!pendingFile) return;
    const pending = validatePending(pendingFile.value, request);
    if (pending.initialPassword !== expectedPassword) fail("unsafe_receipt");
    await safeUnlink(statePath, pendingFile.stats, stateBoundary, deps, "unsafe_state");
}

export async function executeOperatorProvisioning(input, overrides = {}) {
    const deps = withDependencies(overrides);
    if (!Array.isArray(input.argv) || input.argv.length !== 1 || !input.argv[0].startsWith("--request=")) {
        fail("invalid_arguments");
    }
    if ((deps.platform !== "darwin" && deps.platform !== "linux") || constants.O_NOFOLLOW === undefined) {
        fail("unsupported_platform");
    }
    const requestPath = normalizedAbsolutePath(input.argv[0].slice("--request=".length), "unsafe_request");
    const requestFile = await readSecureJson(requestPath, deps, "unsafe_request", REQUEST_MAX_BYTES);
    const now = deps.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail("invalid_request");
    const request = validateRequest(requestFile.value, now);
    if (request.credentialStatePath === requestPath || `${request.credentialStatePath}.receipt` === requestPath) {
        fail("invalid_request");
    }
    const stateBoundary = await safeParentBoundary(request.credentialStatePath, deps, "unsafe_state");
    await deps.checkpoint("after_request_read");

    const receiptPath = `${request.credentialStatePath}.receipt`;
    let pending;
    let pendingStats;
    let lock = await acquireLock(request.credentialStatePath, stateBoundary, deps);
    try {
        const receiptFile = await existingSecureFile(receiptPath, deps, "unsafe_receipt", stateBoundary);
        if (receiptFile) {
            const finalized = validateReceipt(receiptFile.value, request);
            await cleanupPendingIfPresent(
                request.credentialStatePath, request, finalized.initialPassword, stateBoundary, deps,
            );
            return publicResult(receiptPath, finalized);
        }
        const pendingFile = await existingSecureFile(
            request.credentialStatePath, deps, "unsafe_state", stateBoundary,
        );
        if (pendingFile) {
            pending = validatePending(pendingFile.value, request);
            pendingStats = pendingFile.stats;
        } else {
            const initialPassword = deps.generatePassword();
            if (!PASSWORD_PATTERN.test(initialPassword)) fail("unsafe_state");
            let passwordVerifier;
            try { passwordVerifier = await deps.hashPassword(initialPassword); } catch { fail("dependency_unavailable"); }
            if (!VERIFIER_PATTERN.test(passwordVerifier)) fail("dependency_unavailable");
            pending = {
                schemaVersion: 1,
                status: "pending",
                requestFingerprint: request.requestFingerprint,
                idempotencyKey: request.idempotencyKey,
                initialPassword,
                passwordVerifier,
                createdAt: now.toISOString(),
            };
            pending.integrity = integrity("omr.operator-provisioning-pending:v1", pending);
            pendingStats = await atomicPublish(
                request.credentialStatePath, pending, stateBoundary, deps, "unsafe_state",
            );
        }
    } finally {
        await releaseLock(lock, deps);
    }

    await deps.checkpoint("after_pending_publish");
    const provision = overrides.provisionWithVerifier ?? defaultProvisionWithVerifier;
    let result;
    try {
        result = await provision({
            organizationName: request.organizationName,
            email: request.email,
            displayName: request.displayName,
            plan: request.plan,
            expiresAt: request.expiresAt,
            actor: request.actor,
            reason: request.reason,
            idempotencyKey: request.idempotencyKey,
            encodedVerifier: pending.passwordVerifier,
        }, input.env ?? {});
    } catch {
        fail("dependency_unavailable");
    }
    if (result?.status === "unavailable") fail("dependency_unavailable");
    if (result?.status === "rejected") fail("provisioning_rejected");
    result = validateProvisionedResult(result, request);
    await deps.checkpoint("after_rpc_before_receipt");

    lock = await acquireLock(request.credentialStatePath, stateBoundary, deps);
    let finalized;
    try {
        const currentPending = await readSecureJson(
            request.credentialStatePath, deps, "unsafe_state", SECRET_FILE_MAX_BYTES, stateBoundary,
        );
        const verifiedPending = validatePending(currentPending.value, request);
        if (
            currentPending.stats.dev !== pendingStats.dev
            || currentPending.stats.ino !== pendingStats.ino
            || verifiedPending.initialPassword !== pending.initialPassword
            || verifiedPending.passwordVerifier !== pending.passwordVerifier
        ) fail("unsafe_state");
        const receiptFile = await existingSecureFile(receiptPath, deps, "unsafe_receipt", stateBoundary);
        if (receiptFile) {
            finalized = validateReceipt(receiptFile.value, request);
            if (
                finalized.initialPassword !== pending.initialPassword
                || finalized.organizationId !== result.organizationId
                || finalized.accountId !== result.accountId
                || finalized.grantId !== result.grantId
                || finalized.plan !== result.plan
                || finalized.expiresAt !== result.expiresAt
            ) fail("unsafe_receipt");
        } else {
            finalized = {
                schemaVersion: 1,
                status: "provisioned",
                requestFingerprint: request.requestFingerprint,
                idempotencyKeyHash: sha256(request.idempotencyKey),
                organizationId: result.organizationId,
                accountId: result.accountId,
                grantId: result.grantId,
                plan: result.plan,
                expiresAt: result.expiresAt,
                replayed: result.replayed,
                initialPassword: pending.initialPassword,
            };
            finalized.integrity = integrity("omr.operator-provisioning-receipt:v1", finalized);
            await atomicPublish(receiptPath, finalized, stateBoundary, deps, "unsafe_receipt");
        }
        await deps.checkpoint("after_receipt_publish");
        await safeUnlink(
            request.credentialStatePath, currentPending.stats, stateBoundary, deps, "unsafe_state",
        );
    } finally {
        await releaseLock(lock, deps);
    }
    return publicResult(receiptPath, finalized);
}

export async function runOperatorProvisioningCli({ argv, env, deps, stdout = console.log, stderr = console.error }) {
    try {
        const result = await executeOperatorProvisioning({ argv, env }, deps);
        stdout(`receipt_path=${result.receiptPath}`);
        stdout(`organization_id=${result.organizationId}`);
        stdout(`account_id=${result.accountId}`);
        stdout(`grant_id=${result.grantId}`);
        stdout(`expires_at=${result.expiresAt}`);
        return 0;
    } catch (error) {
        const code = error instanceof OperatorProvisioningCliError && SAFE_CODES.has(error.code)
            ? error.code
            : "internal_failure";
        stderr(`provision_failed: ${code}`);
        return 1;
    }
}
