import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    parseOperationalAlertInput,
    runOperationalAlertCli,
    runOperationalAlertExercise,
} from "../../scripts/operational-alert-core.mjs";

const BUILD_SHA = "a".repeat(40);
const EVENT_ID = `evt_${"b".repeat(32)}`;
const TOKENS = {
    OMR_ALERT_SINK_TOKEN: `SINK_${"S".repeat(32)}`,
    OMR_ALERT_RECEIPT_TOKEN: `POLL_${"P".repeat(32)}`,
    OMR_ALERT_ACK_TOKEN: `ACK_${"A".repeat(32)}`,
    OMR_ALERT_RESOLVE_TOKEN: `RESOLVE_${"R".repeat(32)}`,
};

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function secureOutput(name = "alert-evidence.json") {
    const root = await mkdtemp(join(tmpdir(), "omr-alert-test-"));
    roots.push(root);
    await chmod(root, 0o700);
    return { root, output: join(root, name) };
}

async function fixture(options: {
    responses?: Array<Response | (() => Response)>;
    eventId?: string;
} = {}) {
    const { output } = await secureOutput();
    let nowMs = Date.parse("2026-08-08T00:00:00.000Z");
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const responses = options.responses ?? [
        new Response(null, { status: 202 }),
        Response.json({
            eventId: EVENT_ID,
            sinkReceivedAt: "2026-08-08T00:00:01.000Z",
            alertReceivedAt: "2026-08-08T00:00:02.000Z",
        }),
        Response.json({ eventId: EVENT_ID, acknowledgedAt: "2026-08-08T00:00:03.000Z" }),
        Response.json({ eventId: EVENT_ID, resolvedAt: "2026-08-08T00:00:04.000Z" }),
    ];
    const deps = {
        fetch: async (url: string | URL | Request, init?: RequestInit) => {
            calls.push({ url: String(url), init });
            const response = responses.shift();
            if (!response) throw new Error("unexpected fetch");
            return typeof response === "function" ? response() : response;
        },
        now: () => new Date(nowMs),
        sleep: async (ms: number) => { nowMs += ms; },
        generateEventId: () => options.eventId ?? EVENT_ID,
    };
    const env = {
        OMR_BUILD_SHA: BUILD_SHA,
        OMR_ALERT_SINK_URL: "https://sink.ops.vendor.com/v1/events",
        OMR_ALERT_RECEIPT_URL: "https://receipt.ops.vendor.com/v1/status",
        OMR_ALERT_ACK_URL: "https://actions.ops.vendor.com/v1/ack",
        OMR_ALERT_RESOLVE_URL: "https://actions.ops.vendor.com/v1/resolve",
        OMR_ALERT_POLL_INTERVAL_MS: "250",
        OMR_ALERT_DEADLINE_MS: "1000",
        OMR_ALERT_REQUEST_TIMEOUT_MS: "1000",
        ...TOKENS,
    };
    return { output, calls, deps, env };
}

describe("provider-neutral operational alert exercise", () => {
    it("emits, receives, acknowledges, resolves, and writes canonical 0600 evidence", async () => {
        const { output, calls, deps, env } = await fixture();

        const evidence = await runOperationalAlertExercise({ argv: ["--output", output], env }, deps);

        expect(evidence).toMatchObject({
            status: "verified",
            schemaVersion: 1,
            buildSha: BUILD_SHA,
            eventId: EVENT_ID,
            emittedAt: "2026-08-08T00:00:00.000Z",
            sinkReceivedAt: "2026-08-08T00:00:01.000Z",
            alertReceivedAt: "2026-08-08T00:00:02.000Z",
            acknowledgedAt: "2026-08-08T00:00:03.000Z",
            resolvedAt: "2026-08-08T00:00:04.000Z",
            endpointOriginHashes: {
                sink: expect.stringMatching(/^[a-f0-9]{64}$/),
                receipt: expect.stringMatching(/^[a-f0-9]{64}$/),
                acknowledge: expect.stringMatching(/^[a-f0-9]{64}$/),
                resolve: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
            integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        });
        expect(Object.keys(evidence)).toEqual([
            "status", "schemaVersion", "buildSha", "eventId", "emittedAt", "sinkReceivedAt",
            "alertReceivedAt", "acknowledgedAt", "resolvedAt", "endpointOriginHashes", "integrity",
        ]);
        expect(JSON.parse(await readFile(output, "utf8"))).toEqual(evidence);
        const serialized = await readFile(output, "utf8");
        expect(serialized).not.toContain("https://");
        for (const token of Object.values(TOKENS)) expect(serialized).not.toContain(token);
        const { integrity, ...unsignedEvidence } = evidence;
        const canonicalize = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(canonicalize);
            if (value && typeof value === "object") {
                return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
            }
            return value;
        };
        expect(integrity).toBe(`sha256:${createHash("sha256").update(JSON.stringify(canonicalize(unsignedEvidence))).digest("hex")}`);
        expect((await lstat(output)).mode & 0o777).toBe(0o600);

        expect(calls.map((call) => call.url)).toEqual([
            env.OMR_ALERT_SINK_URL,
            env.OMR_ALERT_RECEIPT_URL,
            env.OMR_ALERT_ACK_URL,
            env.OMR_ALERT_RESOLVE_URL,
        ]);
        for (const call of calls) {
            expect(call.init?.redirect).toBe("error");
            expect(new Headers(call.init?.headers).get("x-omr-event-id")).toBe(EVENT_ID);
        }
        const emitted = JSON.parse(String(calls[0].init?.body));
        expect(emitted).toEqual({
            eventId: EVENT_ID,
            event: "omr.synthetic_alert",
            severity: "critical",
            buildSha: BUILD_SHA,
            emittedAt: "2026-08-08T00:00:00.000Z",
            correlation: EVENT_ID,
        });
        expect(JSON.parse(String(calls[2].init?.body))).toEqual({ eventId: EVENT_ID });
        expect(JSON.parse(String(calls[3].init?.body))).toEqual({ eventId: EVENT_ID });
    });

    it("uses one exact event ID throughout each chain and a unique ID on the next run", async () => {
        const first = await fixture();
        await runOperationalAlertExercise({ argv: ["--output", first.output], env: first.env }, first.deps);
        expect(first.calls.every((call) => new Headers(call.init?.headers).get("x-omr-event-id") === EVENT_ID)).toBe(true);

        const nextId = `evt_${"c".repeat(32)}`;
        const second = await fixture({
            eventId: nextId,
            responses: [
                new Response(null, { status: 202 }),
                Response.json({ eventId: nextId, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" }),
                Response.json({ eventId: nextId, acknowledgedAt: "2026-08-08T00:00:03.000Z" }),
                Response.json({ eventId: nextId, resolvedAt: "2026-08-08T00:00:04.000Z" }),
            ],
        });
        const evidence = await runOperationalAlertExercise({ argv: ["--output", second.output], env: second.env }, second.deps);
        expect(evidence.eventId).toBe(nextId);
        expect(evidence.eventId).not.toBe(EVENT_ID);
    });

    it.each([
        ["missing receipt", new Response(null, { status: 404 })],
        ["mismatched receipt", Response.json({ eventId: `evt_${"c".repeat(32)}`, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" })],
        ["extra receipt event", Response.json({ eventId: EVENT_ID, extraEventId: `evt_${"c".repeat(32)}`, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" })],
        ["malformed receipt timestamp", Response.json({ eventId: EVENT_ID, sinkReceivedAt: "soon", alertReceivedAt: "2026-08-08T00:00:02.000Z" })],
        ["receipt before emission", Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2026-08-07T23:59:59.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" })],
        ["alert before sink", Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2026-08-08T00:00:02.000Z", alertReceivedAt: "2026-08-08T00:00:01.000Z" })],
    ])("fails closed for %s without continuing the chain", async (_label, receipt) => {
        const receiptResponses = receipt.status === 404
            ? Array.from({ length: 4 }, () => new Response(null, { status: 404 }))
            : [receipt];
        const { output, calls, deps, env } = await fixture({ responses: [new Response(null, { status: 202 }), ...receiptResponses] });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(calls).toHaveLength(receipt.status === 404 ? 5 : 2);
        await expect(lstat(output)).rejects.toThrow();
    });

    it.each([
        ["acknowledgement mismatch", Response.json({ eventId: `evt_${"c".repeat(32)}`, acknowledgedAt: "2026-08-08T00:00:03.000Z" })],
        ["acknowledgement before alert", Response.json({ eventId: EVENT_ID, acknowledgedAt: "2026-08-08T00:00:01.000Z" })],
    ])("stops before resolution on %s", async (_label, acknowledgement) => {
        const { output, calls, deps, env } = await fixture({ responses: [
            new Response(null, { status: 202 }),
            Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" }),
            acknowledgement,
        ] });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(calls).toHaveLength(3);
    });

    it.each([
        ["resolution mismatch", Response.json({ eventId: `evt_${"c".repeat(32)}`, resolvedAt: "2026-08-08T00:00:04.000Z" })],
        ["resolution before acknowledgement", Response.json({ eventId: EVENT_ID, resolvedAt: "2026-08-08T00:00:02.000Z" })],
    ])("rejects %s", async (_label, resolution) => {
        const { output, deps, env } = await fixture({ responses: [
            new Response(null, { status: 202 }),
            Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" }),
            Response.json({ eventId: EVENT_ID, acknowledgedAt: "2026-08-08T00:00:03.000Z" }),
            resolution,
        ] });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
    });

    it.each([
        ["missing acknowledgement", 2, new Response(null, { status: 404 })],
        ["missing resolution", 3, new Response(null, { status: 404 })],
    ])("leaves no artifact for %s", async (_label, terminalIndex, terminalResponse) => {
        const responses = [
            new Response(null, { status: 202 }),
            Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" }),
            Response.json({ eventId: EVENT_ID, acknowledgedAt: "2026-08-08T00:00:03.000Z" }),
            Response.json({ eventId: EVENT_ID, resolvedAt: "2026-08-08T00:00:04.000Z" }),
        ];
        responses[terminalIndex] = terminalResponse;
        const { output, calls, deps, env } = await fixture({ responses });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(calls).toHaveLength(terminalIndex + 1);
        await expect(lstat(output)).rejects.toThrow();
    });

    it("polls only transient receipt states and then succeeds", async () => {
        const { output, calls, deps, env } = await fixture({ responses: [
            new Response(null, { status: 202 }),
            new Response(null, { status: 404 }),
            new Response(null, { status: 202 }),
            Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2026-08-08T00:00:01.000Z", alertReceivedAt: "2026-08-08T00:00:02.000Z" }),
            Response.json({ eventId: EVENT_ID, acknowledgedAt: "2026-08-08T00:00:03.000Z" }),
            Response.json({ eventId: EVENT_ID, resolvedAt: "2026-08-08T00:00:04.000Z" }),
        ] });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).resolves.toMatchObject({ status: "verified" });
        expect(calls).toHaveLength(6);
    });

    it("stops at the receipt deadline", async () => {
        const { output, calls, deps, env } = await fixture({ responses: [
            new Response(null, { status: 202 }),
            ...Array.from({ length: 4 }, () => new Response(null, { status: 404 })),
        ] });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).rejects.toMatchObject({ code: "receipt_deadline" });
        expect(calls).toHaveLength(5);
    });

    it("caps each receipt request timeout at the remaining poll deadline", async () => {
        const current = await fixture({ responses: [
            new Response(null, { status: 202 }),
            ...Array.from({ length: 4 }, () => new Response(null, { status: 404 })),
        ] });
        const timeoutBounds: number[] = [];
        const deps = {
            ...current.deps,
            timeoutSignal: (milliseconds: number) => {
                timeoutBounds.push(milliseconds);
                return new AbortController().signal;
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: "receipt_deadline" });
        expect(timeoutBounds).toEqual([1000, 1000, 750, 500, 250]);
    });

    it.each([
        ["redirect", new Response(null, { status: 302, headers: { location: "https://other.example.test" } })],
        ["oversized response", new Response("x".repeat(32 * 1024 + 1), { status: 200 })],
        ["malformed JSON", new Response("{", { status: 200 })],
    ])("rejects a %s response and performs no later fetch", async (_label, receipt) => {
        const { output, calls, deps, env } = await fixture({ responses: [new Response(null, { status: 202 }), receipt] });
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(calls).toHaveLength(2);
    });

    it("treats a request timeout as terminal without exposing its details", async () => {
        const current = await fixture();
        const calls: string[] = [];
        const deps = {
            ...current.deps,
            fetch: async (url: string | URL | Request) => {
                calls.push(String(url));
                throw new DOMException("token-like-timeout-detail", "TimeoutError");
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({
            code: "request_failed",
            message: "Synthetic alert exercise is unverified",
        });
        expect(calls).toHaveLength(1);
    });

    it.each([
        ["http endpoint", { OMR_ALERT_SINK_URL: "http://sink.example.test/v1/events" }],
        ["localhost endpoint", { OMR_ALERT_RECEIPT_URL: "https://localhost/v1/status" }],
        ["loopback endpoint", { OMR_ALERT_ACK_URL: "https://127.0.0.1/v1/ack" }],
        ["private endpoint", { OMR_ALERT_RESOLVE_URL: "https://10.0.0.1/v1/resolve" }],
        ["reserved test endpoint", { OMR_ALERT_SINK_URL: "https://sink.example.test/v1/events" }],
        ["credential reuse", { OMR_ALERT_ACK_TOKEN: TOKENS.OMR_ALERT_RESOLVE_TOKEN }],
        ["short credential", { OMR_ALERT_SINK_TOKEN: "short" }],
        ["credential whitespace", { OMR_ALERT_SINK_TOKEN: `${"s".repeat(32)} ` }],
    ])("rejects %s before network access", async (_label, override) => {
        const { output, calls, deps, env } = await fixture();
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env: { ...env, ...override } }, deps)).rejects.toMatchObject({ code: "invalid_configuration" });
        expect(calls).toHaveLength(0);
    });

    it("requires an absolute, normalized, new output under a private real directory", async () => {
        const existing = await secureOutput("existing.json");
        await writeFile(existing.output, "owned", { mode: 0o600 });
        const symlinkPath = join(existing.root, "linked.json");
        await symlink(existing.output, symlinkPath);
        const insecure = await secureOutput("evidence.json");
        await chmod(insecure.root, 0o755);

        for (const output of ["relative.json", `${existing.root}/nested/../evidence.json`, existing.output, symlinkPath, insecure.output]) {
            const current = await fixture();
            await expect(runOperationalAlertExercise({ argv: ["--output", output], env: current.env }, current.deps)).rejects.toMatchObject({ code: "unsafe_output" });
            expect(current.calls).toHaveLength(0);
        }
    });

    it("fails missing credentials as unverified exit 1 without logging or serializing secrets", async () => {
        const { output, calls, deps, env } = await fixture();
        const secret = env.OMR_ALERT_SINK_TOKEN;
        const messages: string[] = [];
        delete (env as Partial<typeof env>).OMR_ALERT_SINK_TOKEN;

        const exitCode = await runOperationalAlertCli({
            argv: ["--output", output],
            env,
            deps,
            stderr: (message: string) => messages.push(message),
        });

        expect(exitCode).toBe(1);
        expect(messages.join("\n")).toBe("unverified: synthetic alert exercise failed");
        expect(messages.join("\n")).not.toContain(secret);
        expect(calls).toHaveLength(0);
        await expect(lstat(output)).rejects.toThrow();
    });

    it("exposes an exact bounded CLI and environment schema", async () => {
        const { output, env } = await fixture();
        expect(parseOperationalAlertInput(["--output", output], env)).toMatchObject({
            outputPath: output,
            pollIntervalMs: 250,
            deadlineMs: 1000,
            requestTimeoutMs: 1000,
        });
        expect(() => parseOperationalAlertInput(["--output", output, "--unknown"], env)).toThrow();
        expect(() => parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_DEADLINE_MS: "999" })).toThrow();
        expect(() => parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_POLL_INTERVAL_MS: "5001" })).toThrow();
        expect(() => parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_REQUEST_TIMEOUT_MS: "10001" })).toThrow();
    });

    it("wires the exact npm command and release evidence freshness contract", async () => {
        const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
        const template = await readFile(join(process.cwd(), "docs/operations/release-evidence-template.md"), "utf8");
        expect(packageJson.scripts["ops:alert:verify"]).toBe("node scripts/verify-operational-alert.mjs");
        expect(template).toContain("npm run ops:alert:verify -- --output /absolute/private/path/operational-alert-evidence.json");
        expect(template).toContain("freshness 30일 이내");
        expect(template).toContain("외부 시스템 실행만 `verified` 가능");
    });
});
