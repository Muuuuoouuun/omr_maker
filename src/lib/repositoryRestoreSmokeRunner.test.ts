import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
    RESTORE_SMOKE_STEPS,
    createRepositoryRestoredSmokeDependencies,
    executeRepositoryRestoreSmokeOperation,
    probeRestoreTargetHealth,
    runBoundedRestoreSmokeOperation,
    resolveRepositoryRestoreSmokeConfig,
    validateRotatedStudentCredentialRevocation,
} from "../../scripts/restore-smoke-runner.mjs";
import { runRestoredEnvironmentSmoke } from "../../scripts/run-restored-environment-smoke.mjs";

const BUILD = "6".repeat(40);
const ENVIRONMENT_DIGEST = "7".repeat(64);
const TARGET_DIGEST = "8".repeat(64);
const TARGET_REF = "staging-restore-ref";

function env(overrides: Record<string, string> = {}) {
    return {
        OMR_DEPLOYMENT_TIER: "staging",
        OMR_BUILD_SHA: BUILD,
        OMR_RESTORE_ENVIRONMENT_DIGEST: ENVIRONMENT_DIGEST,
        OMR_RESTORE_TARGET_DIGEST: TARGET_DIGEST,
        OMR_RESTORE_TARGET_PROJECT_REF: TARGET_REF,
        OMR_RESTORE_STARTED_AT: "2026-08-10T00:10:00.000Z",
        OMR_RESTORE_TARGET_APP_URL: "https://restore-staging.example.test",
        OMR_RESTORE_TARGET_SUPABASE_URL: `https://${TARGET_REF}.supabase.co`,
        OMR_RESTORE_TARGET_SERVICE_ROLE_KEY: "restore-service-role-key-at-least-32-bytes",
        OMR_PRODUCTION_SUPABASE_URL: "https://production-source-ref.supabase.co",
        OMR_PRODUCTION_APP_URL: "https://production.example.test",
        OMR_DELIVERY_PROVIDER_MODE: "disabled",
        OMR_PAYMENT_PROVIDER_MODE: "disabled",
        ...overrides,
    };
}

function request(operation: string, overrides = {}) {
    return {
        schemaVersion: 1,
        operation,
        buildSha: BUILD,
        environmentDigest: ENVIRONMENT_DIGEST,
        targetDigest: TARGET_DIGEST,
        disposableRunId: "restore-smoke-0001",
        ...overrides,
    };
}

describe("repository-owned restored-environment smoke runner", () => {
    it("fails closed outside the exact staging restore build and target", () => {
        expect(() => resolveRepositoryRestoreSmokeConfig({ env: env({ OMR_DEPLOYMENT_TIER: "production" }) })).toThrow(/staging/i);
        expect(() => resolveRepositoryRestoreSmokeConfig({
            env: env({ OMR_RESTORE_TARGET_SUPABASE_URL: "https://production-source-ref.supabase.co" }),
        })).toThrow(/production|target/i);
        expect(() => resolveRepositoryRestoreSmokeConfig({ env: env({ OMR_BUILD_SHA: "5".repeat(40) }) }, BUILD)).toThrow(/build/i);
        expect(() => resolveRepositoryRestoreSmokeConfig({ env: env({ OMR_DELIVERY_PROVIDER_MODE: "live" }) })).toThrow(/provider|delivery/i);
        expect(() => resolveRepositoryRestoreSmokeConfig({ env: env({ OMR_PAYMENT_PROVIDER_MODE: "live" }) })).toThrow(/provider|payment/i);
        const withoutStartedAt: Record<string, string> = { ...env() };
        delete withoutStartedAt.OMR_RESTORE_STARTED_AT;
        expect(() => resolveRepositoryRestoreSmokeConfig({ env: withoutStartedAt })).toThrow(/started|time|binding/i);
    });

    it("binds every operation to the build, environment, target, and disposable actor IDs", async () => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        await expect(executeRepositoryRestoreSmokeOperation(
            config,
            request("create-teacher", { targetDigest: "0".repeat(64) }),
            {},
        )).rejects.toThrow(/target|binding/i);
        await expect(executeRepositoryRestoreSmokeOperation(
            config,
            request("create-student", { disposableRunId: "../escape" }),
            {},
        )).rejects.toThrow(/disposable|identifier/i);
    });

    it("keeps the exact operation allowlist in the tracked runner", () => {
        expect(RESTORE_SMOKE_STEPS).toEqual(["create", "publish", "invite", "solve", "submit", "feedback"]);
        const source = readFileSync("scripts/restore-smoke-runner.mjs", "utf8");
        expect(source).toContain('case "create-teacher"');
        expect(source).toContain('case "create-student"');
        expect(source).toContain('case "browser-journey"');
        expect(source).toContain('case "revoke-teacher"');
        expect(source).toContain('case "revoke-student"');
        expect(source).toMatch(/newContext\s*\(/);
        expect(source).not.toMatch(/execFileSync\([^\n]+import\.meta\.url|spawn\([^\n]+import\.meta\.url/);
        expect(source).toMatch(/executeRepositoryRestoreSmokeOperation\(config, request/);
        expect(source).not.toMatch(/stripe|sendgrid|twilio|production\.example/i);
    });

    it("probes the exact same-origin health endpoint and rejects a missing or wrong build", async () => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        const requested: Array<{ url: string; init?: RequestInit }> = [];
        const goodFetch = async (input: string | URL | Request, init?: RequestInit) => {
            requested.push({ url: String(input), init });
            return new Response(JSON.stringify({
                status: "alive",
                build: BUILD,
                timestamp: "2026-08-10T00:10:01.000Z",
            }), { status: 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
        };
        await expect(probeRestoreTargetHealth(config, {
            fetchImpl: goodFetch,
            now: new Date("2026-08-10T00:10:02.000Z"),
        })).resolves.toEqual({ status: "alive", build: BUILD, timestamp: "2026-08-10T00:10:01.000Z" });
        expect(requested).toHaveLength(1);
        expect(requested[0].url).toBe("https://restore-staging.example.test/api/healthz");
        expect(requested[0].init).toMatchObject({ method: "GET", redirect: "error", cache: "no-store" });
        expect(requested[0].init?.signal).toBeInstanceOf(AbortSignal);

        for (const body of [
            { status: "alive", timestamp: "2026-08-10T00:10:01.000Z" },
            { status: "alive", build: "5".repeat(40), timestamp: "2026-08-10T00:10:01.000Z" },
            { status: "ready", build: BUILD, timestamp: "2026-08-10T00:10:01.000Z" },
            { status: "alive", build: BUILD, timestamp: "2026-08-10T00:10:01.000Z", extra: true },
        ]) {
            await expect(probeRestoreTargetHealth(config, {
                fetchImpl: async () => new Response(JSON.stringify(body), {
                    status: 200,
                    headers: { "content-type": "application/json", "cache-control": "no-store" },
                }),
                now: new Date("2026-08-10T00:10:02.000Z"),
            })).rejects.toThrow(/health|build|verified/i);
        }
    });

    it("navigates the generated invite in a fresh context before marking invite passed", () => {
        const source = readFileSync("scripts/restore-smoke-runner.mjs", "utf8");
        expect(source).toMatch(/distribution-share-url[\s\S]{0,1200}newContext\(\)[\s\S]{0,800}goto\(inviteUrl/);
        expect(source).toMatch(/goto\(inviteUrl[\s\S]{0,1200}steps\.invite = "passed"/);
        expect(source).toMatch(/const studentContext = await browser\.newContext\(\)[\s\S]{0,300}const studentPage[\s\S]{0,600}goto\(inviteUrl[\s\S]{0,1800}getByPlaceholder\("이름을 입력하세요"\)/);
        const handoff = source.slice(source.indexOf("goto(inviteUrl"), source.indexOf('getByPlaceholder("이름을 입력하세요")'));
        expect(handoff).not.toContain('/?role=student');
        expect(handoff.match(/browser\.newContext\(\)/g) ?? []).toHaveLength(0);
        expect(source).not.toMatch(/steps\.publish = "passed";\s*steps\.invite = "passed"/);
    });

    it("selects the exact invited class through a Playwright-supported string value", async () => {
        const runner = await import("../../scripts/restore-smoke-runner.mjs") as unknown as {
            selectExactOptionByText?: (
                locator: {
                    locator: (selector: string) => {
                        count: () => Promise<number>;
                        nth: (index: number) => {
                            textContent: () => Promise<string | null>;
                            getAttribute: (name: string) => Promise<string | null>;
                        };
                    };
                    selectOption: (value: string) => Promise<string[]>;
                },
                text: string,
            ) => Promise<string>;
        };
        expect(runner.selectExactOptionByText).toBeTypeOf("function");
        const selected: unknown[] = [];
        const options = [
            { text: "다른 반", value: "class-other" },
            { text: "  Restore Smoke Class  ", value: "class-restore" },
        ];
        const locator = {
            locator(selector: string) {
                expect(selector).toBe("option");
                return {
                    count: async () => options.length,
                    nth: (index: number) => ({
                        textContent: async () => options[index]?.text ?? null,
                        getAttribute: async (name: string) => name === "value" ? options[index]?.value ?? null : null,
                    }),
                };
            },
            async selectOption(value: string) {
                selected.push(value);
                if (typeof value !== "string") throw new Error("Playwright selectOption value must be a string");
                return [value];
            },
        };

        await expect(runner.selectExactOptionByText!(locator, "Restore Smoke Class"))
            .resolves.toBe("class-restore");
        expect(selected).toEqual(["class-restore"]);
        expect(readFileSync("scripts/restore-smoke-runner.mjs", "utf8"))
            .not.toMatch(/selectOption\(\{\s*label:\s*\//);
    });

    it("requires the old student credential incarnation to be replaced and stale", () => {
        const oldCredential = {
            accountId: "student_credential_old",
            credentialGeneration: 1,
            startCodeHash: `pbkdf2-sha256:120000:${"1".repeat(32)}:${"2".repeat(64)}`,
        };
        const currentCredential = {
            accountId: "student_credential_new",
            credentialGeneration: 2,
            startCodeHash: `pbkdf2-sha256:120000:${"3".repeat(32)}:${"4".repeat(64)}`,
        };
        expect(validateRotatedStudentCredentialRevocation(oldCredential, currentCredential, {
            error: null,
            data: false,
        })).toBe(true);
        for (const [current, validation] of [
            [oldCredential, { error: null, data: false }],
            [{ ...currentCredential, credentialGeneration: 1 }, { error: null, data: false }],
            [currentCredential, { error: null, data: true }],
            [currentCredential, { error: new Error("unavailable"), data: null }],
        ] as const) {
            expect(() => validateRotatedStudentCredentialRevocation(oldCredential, current, validation)).toThrow(/credential|revocation|verified/i);
        }
        const source = readFileSync("scripts/restore-smoke-runner.mjs", "utf8");
        expect(source).toMatch(/omr_validate_student_session_v1/);
        expect(source).toMatch(/omr_student_start_credentials/);
    });

    it("aborts and joins a stalled in-process operation before returning", async () => {
        let active = 0;
        let laterWork = 0;
        await expect(runBoundedRestoreSmokeOperation(async (signal: AbortSignal) => {
            active += 1;
            const interval = setInterval(() => { laterWork += 1; }, 2);
            await new Promise<void>(resolve => signal.addEventListener("abort", () => {
                clearInterval(interval);
                active -= 1;
                resolve();
            }, { once: true }));
            throw new Error("aborted");
        }, { timeoutMs: 10, cleanupTimeoutMs: 50 })).rejects.toThrow(/timed out|failed|verified/i);
        const atReturn = laterWork;
        await new Promise(resolve => setTimeout(resolve, 10));
        expect(active).toBe(0);
        expect(laterWork).toBe(atReturn);
    });

    it("never reads or deletes protected teacher account rows as service_role and rotates disposable credentials", () => {
        const source = readFileSync("scripts/restore-smoke-runner.mjs", "utf8");
        expect(source).not.toMatch(/\.from\(["']omr_teacher_accounts["']\)/);
        expect(source).not.toMatch(/\.from\(["']omr_organizations["']\)\.delete/);
        expect(source.match(/provisionedTeacherIdentity/g)?.length).toBeGreaterThanOrEqual(4);
        expect(source).toMatch(/defaultRevokeTeacher[\s\S]*provisionedTeacherIdentity\([\s\S]{0,400}\btrue,/);
        expect(source.match(/omr_issue_student_start_code_batch_v1/g)?.length).toBeGreaterThanOrEqual(2);
    });

    it.each([
        [{ freshContext: false, steps: [...RESTORE_SMOKE_STEPS], status: "passed" }, /fresh|context|journey/i],
        [{ freshContext: true, steps: RESTORE_SMOKE_STEPS.slice(0, -1), status: "passed" }, /step|journey/i],
        [{ freshContext: true, steps: [...RESTORE_SMOKE_STEPS, "extra"], status: "passed" }, /step|journey/i],
        [{ freshContext: true, steps: [RESTORE_SMOKE_STEPS[1], RESTORE_SMOKE_STEPS[0], ...RESTORE_SMOKE_STEPS.slice(2)], status: "passed" }, /step|order|journey/i],
    ])("rejects a non-exact fresh-context journey receipt", async (receipt, error) => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        await expect(executeRepositoryRestoreSmokeOperation(
            config,
            request("browser-journey", {
                teacherId: "teacher-0001",
                studentIds: ["student-0001", "student-0002"],
            }),
            { runBrowserJourney: async () => receipt },
        )).rejects.toThrow(error);
    });

    it("requires the exact ordered fresh-context journey receipt before passing", async () => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        const result = await executeRepositoryRestoreSmokeOperation(
            config,
            request("browser-journey", {
                teacherId: "teacher-0001",
                studentIds: ["student-0001", "student-0002"],
            }),
            {
                runBrowserJourney: async () => ({
                    freshContext: true,
                    steps: [...RESTORE_SMOKE_STEPS],
                    status: "passed",
                }),
            },
        );
        expect(result).toMatchObject({ status: "passed", freshContext: true, steps: RESTORE_SMOKE_STEPS });
    });

    it("binds the tracked runner into create teacher, two students, browser journey, and finally revocation", async () => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        const operations: string[] = [];
        const dependencies = createRepositoryRestoredSmokeDependencies(config, {
            createDisposableIdentity: (kind: string, index: number) => ({
                id: `restore-${kind}-${index}`,
                credential: `credential-${kind}-${index}-bounded`,
            }),
            execOperation: async (operation: string, payload: Record<string, unknown>) => {
                operations.push(operation);
                if (operation === "browser-journey") throw new Error("journey failed");
                const actor = payload.actor as { id: string } | undefined;
                return {
                    status: operation.startsWith("revoke-") ? "revoked" : "created",
                    actorId: actor?.id ?? payload.actorId,
                };
            },
        });
        await expect(runRestoredEnvironmentSmoke({
            buildSha: BUILD,
            environmentDigest: ENVIRONMENT_DIGEST,
            targetDigest: TARGET_DIGEST,
        }, dependencies)).rejects.toThrow(/verified|smoke/i);
        expect(operations).toEqual([
            "create-teacher",
            "create-student",
            "create-student",
            "browser-journey",
            "revoke-teacher",
            "revoke-student",
            "revoke-student",
        ]);
    });

    it("uses the teacher disposable ID as one shared run binding for both student operations", async () => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        const runIds: Array<{ operation: string; disposableRunId: unknown }> = [];
        const dependencies = createRepositoryRestoredSmokeDependencies(config, {
            createDisposableIdentity: (kind: string, index: number) => ({
                id: `restore-${kind}-${index}`,
                credential: kind === "student" ? (index === 1 ? "AB2CD3" : "EF4GH5") : "teacher-credential-bounded",
            }),
            execOperation: async (operation: string, payload: Record<string, unknown>) => {
                runIds.push({ operation, disposableRunId: payload.disposableRunId });
                const actorValue = payload.actor as { id: string } | undefined;
                if (operation === "browser-journey") return {
                    status: "passed",
                    buildSha: BUILD,
                    environmentDigest: ENVIRONMENT_DIGEST,
                    targetDigest: TARGET_DIGEST,
                    startedAt: "2026-08-10T00:20:00.000Z",
                    completedAt: "2026-08-10T00:21:00.000Z",
                    actorIds: ["restore-teacher-0", "restore-student-1", "restore-student-2"],
                    steps: Object.fromEntries(RESTORE_SMOKE_STEPS.map(step => [step, "passed"])),
                };
                return { status: operation.startsWith("revoke-") ? "revoked" : "created", actorId: actorValue?.id };
            },
            now: () => new Date("2026-08-10T00:22:00.000Z"),
        });
        const binding = {
            buildSha: BUILD,
            environmentDigest: ENVIRONMENT_DIGEST,
            targetDigest: TARGET_DIGEST,
        };
        const teacher = dependencies.createDisposableIdentity("teacher", 0);
        const studentOne = dependencies.createDisposableIdentity("student", 1);
        const studentTwo = dependencies.createDisposableIdentity("student", 2);
        await dependencies.createTeacher(binding, teacher);
        await dependencies.createStudent(binding, studentOne, teacher);
        await dependencies.createStudent(binding, studentTwo, teacher);
        const studentRuns = runIds.filter(item => item.operation === "create-student");
        expect(studentRuns).toEqual([
            { operation: "create-student", disposableRunId: "restore-teacher-0" },
            { operation: "create-student", disposableRunId: "restore-teacher-0" },
        ]);
    });

    it("retries the exact revocation request after a lost response and still attempts all credentials", async () => {
        const config = resolveRepositoryRestoreSmokeConfig({ env: env() }, BUILD);
        const attempts = new Map<string, number>();
        const nonces = new Map<string, unknown[]>();
        const dependencies = createRepositoryRestoredSmokeDependencies(config, {
            createDisposableIdentity: (kind: string, index: number) => ({
                id: `restore-${kind}-${index}`,
                credential: kind === "student" ? (index === 1 ? "AB2CD3" : "EF4GH5") : "teacher-credential-bounded",
            }),
            execOperation: async (operation: string, payload: Record<string, unknown>) => {
                const actorValue = payload.actor as { id: string } | undefined;
                const actorId = actorValue?.id ?? String(payload.actorId);
                if (operation === "browser-journey") return {
                    status: "passed",
                    buildSha: BUILD,
                    environmentDigest: ENVIRONMENT_DIGEST,
                    targetDigest: TARGET_DIGEST,
                    startedAt: "2026-08-10T00:20:00.000Z",
                    completedAt: "2026-08-10T00:21:00.000Z",
                    actorIds: ["restore-teacher-0", "restore-student-1", "restore-student-2"],
                    steps: Object.fromEntries(RESTORE_SMOKE_STEPS.map(step => [step, "passed"])),
                };
                if (operation.startsWith("revoke-")) {
                    const key = `${operation}:${actorId}`;
                    attempts.set(key, (attempts.get(key) ?? 0) + 1);
                    nonces.set(key, [...(nonces.get(key) ?? []), payload.revocationNonce]);
                    if (attempts.get(key) === 1) throw new Error("response lost after commit");
                    return { status: "revoked", actorId };
                }
                return { status: "created", actorId };
            },
            now: () => new Date("2026-08-10T00:22:00.000Z"),
        });

        await expect(runRestoredEnvironmentSmoke({
            buildSha: BUILD,
            environmentDigest: ENVIRONMENT_DIGEST,
            targetDigest: TARGET_DIGEST,
        }, dependencies)).resolves.toMatchObject({ disposableCredentialsRevoked: true });
        expect([...attempts.values()]).toEqual([2, 2, 2]);
        for (const values of nonces.values()) {
            expect(values).toHaveLength(2);
            expect(values[0]).toBe(values[1]);
            expect(values[0]).toMatch(/^[A-Za-z0-9_-]{32,}$/);
        }
    });
});
