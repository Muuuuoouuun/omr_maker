#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
    chmodSync,
    closeSync,
    constants,
    fstatSync,
    mkdtempSync,
    openSync,
    readSync,
    rmSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { parseStrictJson } from "./strict-json.mjs";

const BUILD_SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ACTOR_ID = /^[a-z][a-z0-9_-]{2,63}$/;
const STEP_NAMES = Object.freeze(["create", "publish", "invite", "solve", "submit", "feedback"]);

function fail() {
    throw new Error("Restored environment smoke was not verified");
}

function exactDataObject(value, keys) {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const actual = Object.keys(descriptors).sort();
    const expected = [...keys].sort();
    if (
        actual.length !== expected.length
        || actual.some((key, index) => key !== expected[index])
        || Object.values(descriptors).some(descriptor => !("value" in descriptor))
    ) fail();
    return value;
}

function canonicalIso(value) {
    if (
        typeof value !== "string"
        || Number.isNaN(Date.parse(value))
        || new Date(value).toISOString() !== value
    ) fail();
    return value;
}

function validateBinding(value) {
    exactDataObject(value, ["buildSha", "environmentDigest", "targetDigest"]);
    if (!BUILD_SHA.test(value.buildSha) || !SHA256.test(value.environmentDigest) || !SHA256.test(value.targetDigest)) fail();
    return Object.freeze({
        buildSha: value.buildSha,
        environmentDigest: value.environmentDigest,
        targetDigest: value.targetDigest,
    });
}

function validateIdentity(value) {
    exactDataObject(value, ["id", "credential"]);
    if (!SAFE_ACTOR_ID.test(value.id)) fail();
    if (
        typeof value.credential !== "string"
        || Buffer.byteLength(value.credential, "utf8") < 8
        || Buffer.byteLength(value.credential, "utf8") > 4096
        || /[\r\n\u0000]/.test(value.credential)
    ) fail();
    return Object.freeze({ id: value.id, credential: value.credential });
}

function validateStatus(value, expected, actorId) {
    exactDataObject(value, ["status", "actorId"]);
    if (value.status !== expected || value.actorId !== actorId) fail();
}

function validateJourney(value, binding, actors) {
    exactDataObject(value, [
        "status",
        "buildSha",
        "environmentDigest",
        "targetDigest",
        "startedAt",
        "completedAt",
        "actorIds",
        "steps",
    ]);
    if (
        value.status !== "passed"
        || value.buildSha !== binding.buildSha
        || value.environmentDigest !== binding.environmentDigest
        || value.targetDigest !== binding.targetDigest
    ) fail();
    exactDataObject(value.steps, STEP_NAMES);
    if (STEP_NAMES.some(step => value.steps[step] !== "passed")) fail();
    const expectedActorIds = [actors.teacher.id, ...actors.students.map(student => student.id)];
    if (
        !Array.isArray(value.actorIds)
        || value.actorIds.length !== 3
        || value.actorIds.some((actorId, index) => actorId !== expectedActorIds[index])
    ) fail();
    const startedAt = canonicalIso(value.startedAt);
    const completedAt = canonicalIso(value.completedAt);
    if (Date.parse(completedAt) < Date.parse(startedAt)) fail();
    return { startedAt, completedAt };
}

function actorDigest(kind, id) {
    return createHash("sha256")
        .update(`omr.restore-smoke.actor:v1\n${kind}\n${id}`, "utf8")
        .digest("hex");
}

function artifactDigest(value) {
    return createHash("sha256")
        .update("omr.restore-smoke.artifact:v1\n", "utf8")
        .update(JSON.stringify(value), "utf8")
        .digest("hex");
}

function readExactRunner(config) {
    const path = typeof config?.smokeRunnerPath === "string" ? config.smokeRunnerPath : "";
    const expectedSha256 = typeof config?.smokeRunnerSha256 === "string" ? config.smokeRunnerSha256 : "";
    if (!isAbsolute(path) || resolve(path) !== path || !SHA256.test(expectedSha256)) fail();
    let sourceFd;
    let bytes;
    try {
        sourceFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const info = fstatSync(sourceFd);
        if (!info.isFile() || info.size < 1 || info.size > 4 * 1024 * 1024 || (info.mode & 0o111) === 0) fail();
        bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
            const count = readSync(sourceFd, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) fail();
            offset += count;
        }
        if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) fail();
        if (!bytes.subarray(0, 20).toString("utf8").startsWith("#!/usr/bin/env node\n")) fail();
        closeSync(sourceFd);
        sourceFd = undefined;
    } catch {
        if (sourceFd !== undefined) try { closeSync(sourceFd); } catch { /* stable failure below */ }
        fail();
    }
    return Object.freeze({ bytes });
}

function defaultExecRunner(runner, operation, payload, runnerEnv) {
    let captureDir;
    let fd;
    try {
        captureDir = mkdtempSync(join(tmpdir(), "omr-restore-smoke-operation-"));
        chmodSync(captureDir, 0o700);
        const capturedPath = join(captureDir, "runner.mjs");
        writeFileSync(capturedPath, runner.bytes, { mode: 0o700, flag: "wx" });
        fd = openSync(capturedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
        unlinkSync(capturedPath);
        rmSync(captureDir, { recursive: true, force: true });
        captureDir = undefined;
        const stdout = execFileSync(process.execPath, ["/dev/fd/3", `--operation=${operation}`], {
            encoding: "utf8",
            input: `${JSON.stringify(payload)}\n`,
            env: runnerEnv,
            stdio: ["pipe", "pipe", "ignore", fd],
            timeout: 120_000,
            maxBuffer: 64 * 1024,
        });
        if (Buffer.byteLength(stdout, "utf8") > 64 * 1024) fail();
        return parseStrictJson(stdout);
    } catch {
        fail();
    } finally {
        if (fd !== undefined) try { closeSync(fd); } catch { /* stable result already decided */ }
        if (captureDir) rmSync(captureDir, { recursive: true, force: true });
    }
}

export function createExternalRestoredSmokeDependencies(config, overrides = {}) {
    const runner = readExactRunner(config);
    const execRunner = overrides.execRunner ?? defaultExecRunner;
    if (typeof execRunner !== "function") fail();
    const runnerEnv = config.smokeRunnerEnv;
    if (!runnerEnv || typeof runnerEnv !== "object" || Array.isArray(runnerEnv)) fail();
    let disposed = false;
    const run = (operation, payload) => {
        if (disposed) fail();
        return execRunner(runner, operation, payload, runnerEnv);
    };
    return Object.freeze({
        now: overrides.now ?? (() => new Date()),
        createDisposableIdentity(kind) {
            return {
                id: `restore-${kind}-${randomBytes(8).toString("hex")}`,
                credential: randomBytes(32).toString("base64url"),
            };
        },
        async createTeacher(binding, actor) {
            return run("create-teacher", { binding, actor });
        },
        async createStudent(binding, actor, teacher) {
            return run("create-student", { binding, actor, teacher });
        },
        async runBrowserJourney(binding, actors) {
            return run("browser-journey", { binding, actors });
        },
        async revokeTeacher(binding, actor) {
            return run("revoke-teacher", { binding, actorId: actor.id });
        },
        async revokeStudent(binding, actor) {
            return run("revoke-student", { binding, actorId: actor.id });
        },
        async dispose() {
            if (disposed) return;
            disposed = true;
            runner.bytes.fill(0);
        },
    });
}

export async function runRestoredEnvironmentSmoke(input, dependencies = {}) {
    let binding;
    let teacher;
    let students = [];
    let journey;
    let executionFailed = false;
    let adapterDisposed = typeof dependencies.dispose !== "function";
    const revocations = [];
    try {
        binding = validateBinding(input);
        if (typeof dependencies.createDisposableIdentity !== "function") fail();
        teacher = validateIdentity(dependencies.createDisposableIdentity("teacher", 0));
        students = [
            validateIdentity(dependencies.createDisposableIdentity("student", 1)),
            validateIdentity(dependencies.createDisposableIdentity("student", 2)),
        ];
        if (new Set([teacher.id, ...students.map(student => student.id)]).size !== 3) fail();
        if (
            typeof dependencies.createTeacher !== "function"
            || typeof dependencies.createStudent !== "function"
            || typeof dependencies.runBrowserJourney !== "function"
        ) fail();
        validateStatus(await dependencies.createTeacher(binding, teacher), "created", teacher.id);
        for (const student of students) {
            validateStatus(await dependencies.createStudent(binding, student, teacher), "created", student.id);
        }
        const actors = Object.freeze({ teacher, students: Object.freeze(students) });
        journey = validateJourney(
            await dependencies.runBrowserJourney(binding, actors),
            binding,
            actors,
        );
    } catch {
        executionFailed = true;
    } finally {
        if (binding && teacher && students.length === 2) {
            const operations = [
                { actor: teacher, run: () => dependencies.revokeTeacher?.(binding, teacher) },
                ...students.map(student => ({ actor: student, run: () => dependencies.revokeStudent?.(binding, student) })),
            ];
            for (const operation of operations) {
                try {
                    const result = await operation.run();
                    validateStatus(result, "revoked", operation.actor.id);
                    revocations.push(true);
                } catch {
                    revocations.push(false);
                }
            }
        }
        if (typeof dependencies.dispose === "function") {
            try {
                await dependencies.dispose();
                adapterDisposed = true;
            } catch {
                adapterDisposed = false;
            }
        }
    }

    if (executionFailed || revocations.length !== 3 || revocations.some(revoked => !revoked) || !journey || !adapterDisposed) fail();
    let verifiedAtValue;
    try {
        verifiedAtValue = typeof dependencies.now === "function" ? dependencies.now() : new Date();
    } catch {
        fail();
    }
    if (!(verifiedAtValue instanceof Date) || Number.isNaN(verifiedAtValue.getTime())) fail();
    const safeResult = {
        status: "passed",
        buildSha: binding.buildSha,
        environmentDigest: binding.environmentDigest,
        targetDigest: binding.targetDigest,
        verifiedAt: verifiedAtValue.toISOString(),
        browserSmoke: "passed",
        disposableCredentialsRevoked: true,
        actorDigests: [
            actorDigest("teacher", teacher.id),
            ...students.map(student => actorDigest("student", student.id)),
        ],
        journeyStartedAt: journey.startedAt,
        journeyCompletedAt: journey.completedAt,
    };
    return Object.freeze({ ...safeResult, artifactSha256: artifactDigest(safeResult) });
}

async function main() {
    process.stdout.write(`${JSON.stringify({ status: "unverified", code: "restored_environment_smoke_not_verified" })}\n`);
    process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    await main();
}
