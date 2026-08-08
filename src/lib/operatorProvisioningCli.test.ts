import { constants } from "node:fs";
import {
    chmod,
    link,
    lstat,
    mkdir,
    mkdtemp,
    open,
    readFile,
    rename,
    rm,
    symlink,
    unlink,
    writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    OperatorProvisioningCliError,
    createOperatorProvisioningDeadlineFetch,
    executeOperatorProvisioning,
    runOperatorProvisioningCli,
} from "../../scripts/operator-provisioning-cli-core.mjs";

const PASSWORD = "Omr-Correct-Horse-Battery-2026!";
const VERIFIER = `pbkdf2-sha256:120000:${"a".repeat(32)}:${"b".repeat(64)}`;
const IDEMPOTENCY_KEY = `prov_${"A".repeat(32)}`;
const SUCCESS = {
    status: "provisioned" as const,
    organizationId: `pilot_org_${"a".repeat(24)}`,
    accountId: `teacher_${"b".repeat(16)}`,
    grantId: `pilot_grant_${"c".repeat(24)}`,
    plan: "pro" as const,
    expiresAt: "2026-09-08T00:00:00.000000Z",
    replayed: false,
};

const roots: string[] = [];

afterEach(async () => {
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
    const base = join(process.cwd(), ".operator-provisioning-test-");
    const root = await mkdtemp(base);
    roots.push(root);
    await chmod(root, 0o700);
    const requestDir = join(root, "requests");
    const stateDir = join(root, "credentials");
    await mkdir(requestDir, { mode: 0o700 });
    await mkdir(stateDir, { mode: 0o700 });
    const requestPath = join(requestDir, "pilot.json");
    const statePath = join(stateDir, "pilot.state.json");
    const request = {
        organizationName: "서울 파일럿",
        email: "Teacher@Example.com",
        displayName: "김교사",
        plan: "pro",
        expiresAt: "2026-09-08T00:00:00.000Z",
        actor: "operator:launch",
        reason: "initial_pilot",
        idempotencyKey: IDEMPOTENCY_KEY,
        credentialStatePath: statePath,
    };
    await writeFile(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
    await chmod(requestPath, 0o600);
    const calls: Array<Record<string, unknown>> = [];
    const provisionWithVerifier = vi.fn(async (input: Record<string, unknown>): Promise<Record<string, unknown>> => {
        calls.push(input);
        return SUCCESS;
    });
    const deps = {
        now: () => new Date("2026-08-08T00:00:00.000Z"),
        generatePassword: () => PASSWORD,
        hashPassword: async () => VERIFIER,
        provisionWithVerifier,
    };
    return { root, requestDir, stateDir, requestPath, statePath, request, calls, deps };
}

async function receipt(path: string) {
    return JSON.parse(await readFile(`${path}.receipt`, "utf8"));
}

describe("operator teacher provisioning CLI", () => {
    it.each(["\u0000", "\u0001", "\u007f"])(
        "rejects email control character %j before credential or journal side effects",
        async (controlCharacter) => {
            const current = await fixture();
            await writeFile(current.requestPath, JSON.stringify({
                ...current.request,
                email: `a${controlCharacter}@b.co`,
            }), { mode: 0o600 });
            const generatePassword = vi.fn(() => PASSWORD);
            const hashPassword = vi.fn(async () => VERIFIER);

            await expect(executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} },
                { ...current.deps, generatePassword, hashPassword },
            )).rejects.toMatchObject({ code: "invalid_request" });
            expect(generatePassword).not.toHaveBeenCalled();
            expect(hashPassword).not.toHaveBeenCalled();
            expect(current.deps.provisionWithVerifier).not.toHaveBeenCalled();
            await expect(lstat(current.statePath)).rejects.toMatchObject({ code: "ENOENT" });
            await expect(lstat(`${current.statePath}.receipt`)).rejects.toMatchObject({ code: "ENOENT" });
        },
    );

    it("bounds the real Supabase transport so an uncertain timeout is retryable", async () => {
        const transport = createOperatorProvisioningDeadlineFetch(10, async (_input, init) => {
            await new Promise<void>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
            });
            throw new Error("unreachable");
        });

        await expect(transport("https://project.supabase.co/rest/v1/rpc", {}))
            .rejects.toMatchObject({ name: "TimeoutError" });
    });

    it("persists a pending password and exact verifier before the RPC, then publishes a 0600 receipt", async () => {
        const current = await fixture();
        let observedPending: Record<string, unknown> | undefined;
        current.deps.provisionWithVerifier.mockImplementationOnce(async (input) => {
            observedPending = JSON.parse(await readFile(current.statePath, "utf8"));
            expect(input.encodedVerifier).toBe(observedPending?.passwordVerifier);
            expect(input.idempotencyKey).toBe(observedPending?.idempotencyKey);
            return SUCCESS;
        });

        const output = await executeOperatorProvisioning({ argv: [`--request=${current.requestPath}`], env: {} }, current.deps);

        expect(observedPending).toMatchObject({
            schemaVersion: 1,
            status: "pending",
            initialPassword: PASSWORD,
            passwordVerifier: VERIFIER,
            idempotencyKey: IDEMPOTENCY_KEY,
        });
        expect(output).toMatchObject({ receiptPath: `${current.statePath}.receipt`, ...SUCCESS });
        await expect(lstat(current.statePath)).rejects.toMatchObject({ code: "ENOENT" });
        const receiptStats = await lstat(`${current.statePath}.receipt`);
        expect(receiptStats.mode & 0o777).toBe(0o600);
        expect(receiptStats.nlink).toBe(1);
        expect(await receipt(current.statePath)).toMatchObject({
            status: "provisioned",
            initialPassword: PASSWORD,
            organizationId: SUCCESS.organizationId,
            accountId: SUCCESS.accountId,
            grantId: SUCCESS.grantId,
        });
        expect(JSON.stringify(await receipt(current.statePath))).not.toContain(VERIFIER);
    });

    it("leaves pending state after an uncertain result and retries the exact verifier and key", async () => {
        const current = await fixture();
        current.deps.provisionWithVerifier
            .mockRejectedValueOnce(new DOMException(`${PASSWORD} timed out`, "TimeoutError"))
            .mockResolvedValueOnce({ ...SUCCESS, replayed: true });

        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            current.deps,
        )).rejects.toMatchObject({ code: "dependency_unavailable" });
        const pending = JSON.parse(await readFile(current.statePath, "utf8"));

        const result = await executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            current.deps,
        );

        expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(2);
        const firstCall = current.deps.provisionWithVerifier.mock.calls[0]?.[0];
        const secondCall = current.deps.provisionWithVerifier.mock.calls[1]?.[0];
        expect(firstCall?.encodedVerifier).toBe(VERIFIER);
        expect(secondCall?.encodedVerifier).toBe(VERIFIER);
        expect(firstCall?.idempotencyKey).toBe(secondCall?.idempotencyKey);
        expect(pending.initialPassword).toBe(PASSWORD);
        expect(result.replayed).toBe(true);
        expect((await receipt(current.statePath)).initialPassword).toBe(PASSWORD);
    });

    it.each(["after_pending_publish", "after_rpc_before_receipt", "after_receipt_publish"])(
        "recovers an injected crash at %s without credential regeneration",
        async (phase) => {
            const current = await fixture();
            let injected = false;
            const firstDeps = {
                ...current.deps,
                checkpoint: async (name: string) => {
                    if (!injected && name === phase) {
                        injected = true;
                        throw new Error(`${PASSWORD} injected crash`);
                    }
                },
            };
            await expect(executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} },
                firstDeps,
            )).rejects.toBeInstanceOf(Error);
            const generatePassword = vi.fn(() => "must-never-regenerate");

            const result = await executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} },
                { ...current.deps, generatePassword },
            );

            expect(result.status).toBe("provisioned");
            expect(generatePassword).not.toHaveBeenCalled();
            expect((await receipt(current.statePath)).initialPassword).toBe(PASSWORD);
            if (phase === "after_receipt_publish") expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(1);
        },
    );

    it("validates and replays a finalized receipt without another RPC", async () => {
        const current = await fixture();
        const first = await executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        );
        const second = await executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        );
        expect(second).toEqual(first);
        expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["group-readable request", async (f: Awaited<ReturnType<typeof fixture>>) => chmod(f.requestPath, 0o640)],
        ["request symlink", async (f: Awaited<ReturnType<typeof fixture>>) => {
            const target = join(f.requestDir, "target.json");
            await rename(f.requestPath, target);
            await symlink(target, f.requestPath);
        }],
        ["request hardlink", async (f: Awaited<ReturnType<typeof fixture>>) => link(f.requestPath, join(f.requestDir, "copy.json"))],
    ])("rejects an unsafe %s before generating credentials", async (_label, mutate) => {
        const current = await fixture();
        await mutate(current);
        const generatePassword = vi.fn(() => PASSWORD);
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            { ...current.deps, generatePassword },
        )).rejects.toMatchObject({ code: "unsafe_request" });
        expect(generatePassword).not.toHaveBeenCalled();
        expect(current.deps.provisionWithVerifier).not.toHaveBeenCalled();
    });

    it("rejects oversized, extra-field, and credential-bearing request JSON", async () => {
        for (const mutation of [
            { extra: "x" },
            { password: PASSWORD },
            { encodedVerifier: VERIFIER },
            { organizationName: "x".repeat(33_000) },
        ]) {
            const current = await fixture();
            await writeFile(current.requestPath, JSON.stringify({ ...current.request, ...mutation }), { mode: 0o600 });
            await expect(executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
            )).rejects.toMatchObject({ code: mutation.organizationName ? "unsafe_request" : "invalid_request" });
            expect(current.deps.provisionWithVerifier).not.toHaveBeenCalled();
        }
    });

    it("fails closed for tampered or aliased pending state", async () => {
        const current = await fixture();
        current.deps.provisionWithVerifier.mockResolvedValueOnce({ status: "unavailable", error: "dependency_unavailable" });
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        )).rejects.toMatchObject({ code: "dependency_unavailable" });
        const pending = JSON.parse(await readFile(current.statePath, "utf8"));
        await writeFile(current.statePath, JSON.stringify({ ...pending, passwordVerifier: VERIFIER.replace(/b/g, "c") }), { mode: 0o600 });

        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        )).rejects.toMatchObject({ code: "unsafe_state" });
        expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(1);

        await writeFile(current.statePath, JSON.stringify(pending), { mode: 0o600 });
        await link(current.statePath, join(current.stateDir, "pending-copy"));
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        )).rejects.toMatchObject({ code: "unsafe_state" });
    });

    it("rejects a preexisting receipt race or receipt tamper without touching it", async () => {
        const current = await fixture();
        await writeFile(`${current.statePath}.receipt`, JSON.stringify({ password: "attacker" }), { mode: 0o600 });
        const before = await readFile(`${current.statePath}.receipt`, "utf8");
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        )).rejects.toMatchObject({ code: "unsafe_receipt" });
        expect(await readFile(`${current.statePath}.receipt`, "utf8")).toBe(before);
        expect(current.deps.provisionWithVerifier).not.toHaveBeenCalled();
    });

    it.each(["mode", "hardlink", "symlink", "owner"])(
        "rejects a finalized receipt with unsafe %s metadata",
        async (mutation) => {
            const current = await fixture();
            await executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
            );
            const receiptPath = `${current.statePath}.receipt`;
            const deps: Record<string, unknown> = { ...current.deps };
            if (mutation === "mode") await chmod(receiptPath, 0o640);
            if (mutation === "hardlink") await link(receiptPath, join(current.stateDir, "receipt-copy"));
            if (mutation === "symlink") {
                const target = join(current.stateDir, "receipt-target");
                await rename(receiptPath, target);
                await symlink(target, receiptPath);
            }
            if (mutation === "owner") {
                deps.fs = {
                    lstat: async (path: string) => {
                        const stats = await lstat(path);
                        if (path !== receiptPath) return stats;
                        return new Proxy(stats, {
                            get(target, property, receiver) {
                                if (property === "uid") return (process.getuid?.() ?? 0) + 1;
                                return Reflect.get(target, property, receiver);
                            },
                        });
                    },
                };
            }
            await expect(executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} }, deps,
            )).rejects.toMatchObject({ code: "unsafe_receipt" });
            expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(1);
        },
    );

    it.each(["mode", "symlink", "owner"])("rejects pending state with unsafe %s metadata", async (mutation) => {
        const current = await fixture();
        current.deps.provisionWithVerifier.mockResolvedValueOnce({ status: "unavailable", error: "dependency_unavailable" });
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        )).rejects.toMatchObject({ code: "dependency_unavailable" });
        const deps: Record<string, unknown> = { ...current.deps };
        if (mutation === "mode") await chmod(current.statePath, 0o640);
        if (mutation === "symlink") {
            const target = join(current.stateDir, "pending-target");
            await rename(current.statePath, target);
            await symlink(target, current.statePath);
        }
        if (mutation === "owner") {
            deps.fs = {
                lstat: async (path: string) => {
                    const stats = await lstat(path);
                    if (path !== current.statePath) return stats;
                    return new Proxy(stats, {
                        get(target, property, receiver) {
                            if (property === "uid") return (process.getuid?.() ?? 0) + 1;
                            return Reflect.get(target, property, receiver);
                        },
                    });
                },
            };
        }
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, deps,
        )).rejects.toMatchObject({ code: "unsafe_state" });
        expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(1);
    });

    it("keeps exact pending state when receipt publication fails, then safely replays", async () => {
        const current = await fixture();
        let receiptLinkFailed = false;
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            {
                ...current.deps,
                fs: {
                    link: async (source: string, target: string) => {
                        if (!receiptLinkFailed && target === `${current.statePath}.receipt`) {
                            receiptLinkFailed = true;
                            throw new Error(`${PASSWORD} injected link failure`);
                        }
                        await link(source, target);
                    },
                },
            },
        )).rejects.toMatchObject({ code: "unsafe_receipt" });
        const pending = JSON.parse(await readFile(current.statePath, "utf8"));
        expect(pending.initialPassword).toBe(PASSWORD);
        await expect(lstat(`${current.statePath}.receipt`)).rejects.toMatchObject({ code: "ENOENT" });

        await executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        );
        expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(2);
        expect((await receipt(current.statePath)).initialPassword).toBe(PASSWORD);
    });

    it("recovers when pending cleanup fails after a durable receipt", async () => {
        const current = await fixture();
        let cleanupFailed = false;
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            {
                ...current.deps,
                fs: {
                    unlink: async (path: string) => {
                        if (!cleanupFailed && path === current.statePath) {
                            cleanupFailed = true;
                            throw new Error(`${VERIFIER} injected unlink failure`);
                        }
                        await unlink(path);
                    },
                },
            },
        )).rejects.toMatchObject({ code: "unsafe_state" });
        expect(await receipt(current.statePath)).toMatchObject({ initialPassword: PASSWORD });
        expect((await lstat(current.statePath)).isFile()).toBe(true);

        await executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
        );
        await expect(lstat(current.statePath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(current.deps.provisionWithVerifier).toHaveBeenCalledTimes(1);
    });

    it.each(["pending", "receipt"])(
        "repairs the exclusive-publication hardlink crash window for %s",
        async (kind) => {
            const current = await fixture();
            if (kind === "pending") {
                current.deps.provisionWithVerifier.mockResolvedValueOnce({ status: "unavailable", error: "dependency_unavailable" });
                await expect(executeOperatorProvisioning(
                    { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
                )).rejects.toMatchObject({ code: "dependency_unavailable" });
            } else {
                await executeOperatorProvisioning(
                    { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
                );
            }
            const published = kind === "pending" ? current.statePath : `${current.statePath}.receipt`;
            const interruptedTemp = join(
                current.stateDir,
                `.${published.split("/").at(-1)}.${"d".repeat(32)}.tmp`,
            );
            await link(published, interruptedTemp);
            expect((await lstat(published)).nlink).toBe(2);

            await executeOperatorProvisioning(
                { argv: [`--request=${current.requestPath}`], env: {} }, current.deps,
            );

            expect((await lstat(`${current.statePath}.receipt`)).nlink).toBe(1);
            await expect(lstat(interruptedTemp)).rejects.toMatchObject({ code: "ENOENT" });
            expect((await receipt(current.statePath)).initialPassword).toBe(PASSWORD);
        },
    );

    it("recovers an owner-safe lock left by a crashed process but refuses a live lock", async () => {
        const crashed = await fixture();
        const crashedLock = `${crashed.statePath}.lock`;
        await writeFile(crashedLock, `${JSON.stringify({
            schemaVersion: 1,
            pid: 999_999,
            createdAt: "2026-08-08T00:00:00.000Z",
            nonce: "e".repeat(32),
        })}\n`, { mode: 0o600 });
        await executeOperatorProvisioning(
            { argv: [`--request=${crashed.requestPath}`], env: {} },
            { ...crashed.deps, isProcessAlive: () => false },
        );
        await expect(lstat(crashedLock)).rejects.toMatchObject({ code: "ENOENT" });

        const live = await fixture();
        await writeFile(`${live.statePath}.lock`, `${JSON.stringify({
            schemaVersion: 1,
            pid: process.pid,
            createdAt: "2026-08-08T00:00:00.000Z",
            nonce: "f".repeat(32),
        })}\n`, { mode: 0o600 });
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${live.requestPath}`], env: {} },
            { ...live.deps, isProcessAlive: () => true },
        )).rejects.toMatchObject({ code: "unsafe_state" });
        expect(live.deps.provisionWithVerifier).not.toHaveBeenCalled();
    });

    it("fails closed when parent identity changes between validation and publication", async () => {
        const current = await fixture();
        const moved = `${current.stateDir}.moved`;
        const checkpoint = async (phase: string) => {
            if (phase !== "after_request_read") return;
            await rename(current.stateDir, moved);
            await symlink(moved, current.stateDir);
        };
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            { ...current.deps, checkpoint },
        )).rejects.toMatchObject({ code: "unsafe_state" });
        expect(current.deps.provisionWithVerifier).not.toHaveBeenCalled();
    });

    it("fails closed on unsupported ownership primitives and owner mismatch", async () => {
        const current = await fixture();
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            { ...current.deps, platform: "win32" },
        )).rejects.toMatchObject({ code: "unsupported_platform" });
        await expect(executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            { ...current.deps, currentUid: () => (process.getuid?.() ?? 0) + 1 },
        )).rejects.toMatchObject({ code: "unsafe_request" });
    });

    it("uses no-follow file descriptors and validates the opened inode", async () => {
        const current = await fixture();
        const flags: number[] = [];
        await executeOperatorProvisioning(
            { argv: [`--request=${current.requestPath}`], env: {} },
            {
                ...current.deps,
                fs: {
                    open: async (path: string, flag: string | number, mode?: number) => {
                        if (typeof flag === "number") flags.push(flag);
                        return open(path, flag, mode);
                    },
                },
            },
        );
        expect(flags.some(flag => (flag & constants.O_NOFOLLOW) === constants.O_NOFOLLOW)).toBe(true);
    });

    it("prints only allowlisted receipt fields and generic stderr codes", async () => {
        const current = await fixture();
        const stdout: string[] = [];
        const stderr: string[] = [];
        const code = await runOperatorProvisioningCli({
            argv: [`--request=${current.requestPath}`],
            env: { SUPABASE_SERVICE_ROLE_KEY: "must-not-print" },
            stdout: (line: string) => stdout.push(line),
            stderr: (line: string) => stderr.push(line),
            deps: current.deps,
        });
        expect(code).toBe(0);
        const printed = stdout.join("\n");
        expect(printed).toContain(`receipt_path=${current.statePath}.receipt`);
        expect(printed).toContain(`organization_id=${SUCCESS.organizationId}`);
        expect(printed).not.toContain(PASSWORD);
        expect(printed).not.toContain(VERIFIER);
        expect(printed).not.toContain(IDEMPOTENCY_KEY);
        expect(stderr).toEqual([]);

        const failureStderr: string[] = [];
        await writeFile(current.requestPath, JSON.stringify({
            ...current.request,
            password: `${PASSWORD} raw secret error`,
        }), { mode: 0o600 });
        const failed = await runOperatorProvisioningCli({
            argv: [`--request=${current.requestPath}`],
            env: {},
            stdout: vi.fn(),
            stderr: (line: string) => failureStderr.push(line),
            deps: current.deps,
        });
        expect(failed).toBe(1);
        expect(failureStderr).toEqual(["provision_failed: invalid_request"]);
        expect(failureStderr.join(" ")).not.toContain(PASSWORD);
    });

    it("does not expose raw dependency errors through the public CLI error", () => {
        const error = new OperatorProvisioningCliError("dependency_unavailable", `${PASSWORD} ${VERIFIER}`);
        expect(error.message).not.toContain(PASSWORD);
        expect(error.message).not.toContain(VERIFIER);
    });
});
