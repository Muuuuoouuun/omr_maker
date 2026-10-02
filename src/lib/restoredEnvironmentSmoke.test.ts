import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
    createExternalRestoredSmokeDependencies,
    runRestoredEnvironmentSmoke,
} from "../../scripts/run-restored-environment-smoke.mjs";

const BUILD = "c".repeat(40);
const ENVIRONMENT = "d".repeat(64);
const TARGET = "e".repeat(64);
const TEACHER_SECRET = "teacher-secret-never-output";
const STUDENT_SECRETS = ["student-one-secret-never-output", "student-two-secret-never-output"];

function config() {
    return {
        buildSha: BUILD,
        environmentDigest: ENVIRONMENT,
        targetDigest: TARGET,
    };
}

function dependencies(overrides = {}) {
    const calls: string[] = [];
    const identities = [
        { id: "restore-teacher-a1", credential: TEACHER_SECRET },
        { id: "restore-student-b1", credential: STUDENT_SECRETS[0] },
        { id: "restore-student-b2", credential: STUDENT_SECRETS[1] },
    ];
    return {
        calls,
        deps: {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            createDisposableIdentity: (kind: string, index: number) => identities[index],
            createTeacher: async (_binding: unknown, actor: { id: string }) => { calls.push("create:teacher"); return { status: "created", actorId: actor.id }; },
            createStudent: async (_binding: unknown, actor: { id: string }) => { calls.push(`create:${actor.id}`); return { status: "created", actorId: actor.id }; },
            runBrowserJourney: async (_binding: unknown, actors: { teacher: { id: string }; students: Array<{ id: string }> }) => {
                calls.push("browser");
                return {
                    status: "passed",
                    buildSha: BUILD,
                    environmentDigest: ENVIRONMENT,
                    targetDigest: TARGET,
                    startedAt: "2026-08-07T00:39:00.000Z",
                    completedAt: "2026-08-07T00:40:00.000Z",
                    actorIds: [actors.teacher.id, ...actors.students.map(student => student.id)],
                    steps: {
                        create: "passed",
                        publish: "passed",
                        invite: "passed",
                        solve: "passed",
                        submit: "passed",
                        feedback: "passed",
                    },
                };
            },
            revokeTeacher: async (_binding: unknown, actor: { id: string }) => { calls.push(`revoke:${actor.id}`); return { status: "revoked", actorId: actor.id }; },
            revokeStudent: async (_binding: unknown, actor: { id: string }) => { calls.push(`revoke:${actor.id}`); return { status: "revoked", actorId: actor.id }; },
            ...overrides,
        },
    };
}

describe("restored environment disposable browser smoke", () => {
    it("runs the exact core journey and returns only bound safe hashes after revoking every credential", async () => {
        const { calls, deps } = dependencies();
        const result = await runRestoredEnvironmentSmoke(config(), deps);

        expect(calls).toEqual([
            "create:teacher",
            "create:restore-student-b1",
            "create:restore-student-b2",
            "browser",
            "revoke:restore-teacher-a1",
            "revoke:restore-student-b1",
            "revoke:restore-student-b2",
        ]);
        expect(result).toMatchObject({
            status: "passed",
            buildSha: BUILD,
            environmentDigest: ENVIRONMENT,
            targetDigest: TARGET,
            browserSmoke: "passed",
            disposableCredentialsRevoked: true,
        });
        expect(result.artifactSha256).toMatch(/^[a-f0-9]{64}$/);
        expect(result.actorDigests).toHaveLength(3);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(TEACHER_SECRET);
        expect(serialized).not.toContain(STUDENT_SECRETS[0]);
        expect(serialized).not.toContain(STUDENT_SECRETS[1]);
        expect(serialized).not.toContain("restore-teacher-a1");
        expect(serialized).not.toContain("restore-student-b1");
    });

    it("revokes all known credentials in finally and redacts a raw browser failure", async () => {
        const raw = "token=raw-provider-secret student answer body";
        const { calls, deps } = dependencies({
            runBrowserJourney: async () => { throw new Error(raw); },
        });

        await expect(runRestoredEnvironmentSmoke(config(), deps)).rejects.toThrow("Restored environment smoke was not verified");
        expect(calls.filter(call => call.startsWith("revoke:"))).toEqual([
            "revoke:restore-teacher-a1",
            "revoke:restore-student-b1",
            "revoke:restore-student-b2",
        ]);
        await expect(runRestoredEnvironmentSmoke(config(), deps)).rejects.not.toThrow(raw);
    });

    it("attempts every revocation and fails closed when any credential cannot be revoked", async () => {
        const { calls, deps } = dependencies({
            revokeTeacher: async (_binding: unknown, actor: { id: string }) => {
                calls.push(`revoke:${actor.id}`);
                throw new Error("provider raw credential revocation error");
            },
        });

        await expect(runRestoredEnvironmentSmoke(config(), deps)).rejects.toThrow("Restored environment smoke was not verified");
        expect(calls.slice(-3)).toEqual([
            "revoke:restore-teacher-a1",
            "revoke:restore-student-b1",
            "revoke:restore-student-b2",
        ]);
    });

    it.each([
        ["wrong build", { buildSha: "f".repeat(40) }],
        ["wrong environment", { environmentDigest: "f".repeat(64) }],
        ["wrong target", { targetDigest: "f".repeat(64) }],
        ["missing step", { steps: { create: "passed", publish: "passed", invite: "passed", solve: "passed", submit: "passed" } }],
        ["failed feedback", { steps: { create: "passed", publish: "passed", invite: "passed", solve: "passed", submit: "passed", feedback: "failed" } }],
    ])("rejects a browser artifact with %s and still revokes credentials", async (_label, replacement) => {
        const { calls, deps } = dependencies({
            runBrowserJourney: async (_binding: unknown, actors: { teacher: { id: string }; students: Array<{ id: string }> }) => ({
                status: "passed",
                buildSha: BUILD,
                environmentDigest: ENVIRONMENT,
                targetDigest: TARGET,
                startedAt: "2026-08-07T00:39:00.000Z",
                completedAt: "2026-08-07T00:40:00.000Z",
                actorIds: [actors.teacher.id, ...actors.students.map(student => student.id)],
                steps: {
                    create: "passed",
                    publish: "passed",
                    invite: "passed",
                    solve: "passed",
                    submit: "passed",
                    feedback: "passed",
                },
                ...replacement,
            }),
        });

        await expect(runRestoredEnvironmentSmoke(config(), deps)).rejects.toThrow("Restored environment smoke was not verified");
        expect(calls.filter(call => call.startsWith("revoke:"))).toHaveLength(3);
    });

    it("pins the external runner bytes and never exposes raw runner output", async () => {
        const runner = join(mkdtempSync(join(tmpdir(), "omr-restore-runner-")), "runner");
        const body = "#!/usr/bin/env node\nprocess.exitCode = 1;\n";
        writeFileSync(runner, body, { mode: 0o700 });
        const operations: string[] = [];
        const browser = {
            status: "passed",
            buildSha: BUILD,
            environmentDigest: ENVIRONMENT,
            targetDigest: TARGET,
            startedAt: "2026-08-07T00:39:00.000Z",
            completedAt: "2026-08-07T00:40:00.000Z",
            steps: Object.fromEntries(["create", "publish", "invite", "solve", "submit", "feedback"].map(step => [step, "passed"])),
        };
        const deps = createExternalRestoredSmokeDependencies({
            smokeRunnerPath: runner,
            smokeRunnerSha256: createHash("sha256").update(body).digest("hex"),
            smokeRunnerEnv: { PATH: process.env.PATH ?? "" },
        }, {
            now: () => new Date("2026-08-07T00:40:00.000Z"),
            execRunner: (_path: string, operation: string, payload: { actor?: { id: string }; actorId?: string; actors?: { teacher: { id: string }; students: Array<{ id: string }> } }) => {
                operations.push(operation);
                if (operation.startsWith("create-")) return { status: "created", actorId: payload.actor?.id };
                if (operation === "browser-journey") return {
                    ...browser,
                    actorIds: [payload.actors?.teacher.id, ...(payload.actors?.students.map(student => student.id) ?? [])],
                };
                return { status: "revoked", actorId: payload.actorId };
            },
        });

        const result = await runRestoredEnvironmentSmoke(config(), deps);
        expect(result.status).toBe("passed");
        expect(operations).toEqual([
            "create-teacher",
            "create-student",
            "create-student",
            "browser-journey",
            "revoke-teacher",
            "revoke-student",
            "revoke-student",
        ]);
        expect(() => createExternalRestoredSmokeDependencies({
            smokeRunnerPath: runner,
            smokeRunnerSha256: "f".repeat(64),
            smokeRunnerEnv: {},
        })).toThrow("Restored environment smoke was not verified");
    });

    it("executes the already-verified runner inode after its public pathname is replaced", async () => {
        const runner = join(mkdtempSync(join(tmpdir(), "omr-restore-runner-swap-")), "runner");
        const original = "#!/usr/bin/env node\nprocess.stdout.write('{\"status\":\"created\",\"actorId\":\"restore-teacher-a1\"}\\n');\n";
        const replacement = "#!/usr/bin/env node\nprocess.stdout.write('{\"status\":\"created\",\"actorId\":\"attacker-replacement\"}\\n');\n";
        writeFileSync(runner, original, { mode: 0o700 });
        const deps = createExternalRestoredSmokeDependencies({
            smokeRunnerPath: runner,
            smokeRunnerSha256: createHash("sha256").update(original).digest("hex"),
            smokeRunnerEnv: { PATH: process.env.PATH ?? "" },
        });
        writeFileSync(runner, replacement, { mode: 0o700 });

        await expect(deps.createTeacher(config(), {
            id: "restore-teacher-a1",
            credential: TEACHER_SECRET,
        })).resolves.toEqual({ status: "created", actorId: "restore-teacher-a1" });
        await deps.dispose();
    });

    it("executes all seven external operations from the same captured runner bytes", async () => {
        const runner = join(mkdtempSync(join(tmpdir(), "omr-restore-runner-seven-")), "runner");
        const body = `#!/usr/bin/env node
const operation = process.argv.find(value => value.startsWith("--operation="))?.slice(12);
const raw = require("node:fs").readFileSync(0, "utf8");
const payload = JSON.parse(raw);
let result;
if (operation?.startsWith("create-")) result = { status: "created", actorId: payload.actor.id };
else if (operation?.startsWith("revoke-")) result = { status: "revoked", actorId: payload.actorId };
else result = {
  status: "passed",
  ...payload.binding,
  startedAt: "2026-08-07T00:39:00.000Z",
  completedAt: "2026-08-07T00:40:00.000Z",
  actorIds: [payload.actors.teacher.id, ...payload.actors.students.map(student => student.id)],
  steps: { create: "passed", publish: "passed", invite: "passed", solve: "passed", submit: "passed", feedback: "passed" },
};
process.stdout.write(JSON.stringify(result));
`;
        writeFileSync(runner, body, { mode: 0o700 });
        const deps = createExternalRestoredSmokeDependencies({
            smokeRunnerPath: runner,
            smokeRunnerSha256: createHash("sha256").update(body).digest("hex"),
            smokeRunnerEnv: { PATH: process.env.PATH ?? "" },
        }, { now: () => new Date("2026-08-07T00:40:00.000Z") });

        await expect(runRestoredEnvironmentSmoke(config(), deps)).resolves.toMatchObject({
            status: "passed",
            disposableCredentialsRevoked: true,
        });
    });

    it("reports unverified without an external runner instead of skipping the smoke", () => {
        const result = spawnSync(process.execPath, ["scripts/run-restored-environment-smoke.mjs"], {
            cwd: process.cwd(),
            encoding: "utf8",
            env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" },
        });
        expect(result.status).toBe(1);
        expect(JSON.parse(result.stdout)).toEqual({
            status: "unverified",
            code: "restored_environment_smoke_not_verified",
        });
        expect(result.stderr).toBe("");
    });
});
