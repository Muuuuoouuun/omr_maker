import { createHash, createHmac } from "node:crypto";
import { chmod, link as linkFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";

import {
    createHttpsTransport,
    parseOperationalAlertInput,
    resolveAllAddresses,
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
    OMR_ALERT_EVIDENCE_HMAC_SECRET: `HMAC_${"H".repeat(32)}`,
};

const roots: string[] = [];

afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function secureOutput(name = "alert-evidence.json") {
    const root = await realpath(await mkdtemp(join(tmpdir(), "omr-alert-test-")));
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
    let monotonicMs = 0;
    const sleepCalls: number[] = [];
    const calls: Array<{ url: string; address: string; family: number; timeoutMs: number; init?: RequestInit }> = [];
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
        transport: async ({ url, address, family, method, headers, body, timeoutMs }: {
            url: URL; address: string; family: number; method: string; headers: HeadersInit; body?: string; timeoutMs: number;
        }) => {
            calls.push({ url: String(url), address, family, timeoutMs, init: { method, headers, body, redirect: "error" } });
            const response = responses.shift();
            if (!response) throw new Error("unexpected fetch");
            return typeof response === "function" ? response() : response;
        },
        now: () => new Date(nowMs),
        monotonicNow: () => monotonicMs,
        sleep: async (ms: number) => {
            sleepCalls.push(ms);
            nowMs += ms;
            monotonicMs += ms;
        },
        generateEventId: () => options.eventId ?? EVENT_ID,
        resolveAll: async () => [{ address: "8.8.8.8", family: 4 }],
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
    return {
        output,
        calls,
        deps,
        env,
        sleepCalls,
        currentTime: () => nowMs,
        setWallTime: (value: number) => { nowMs = value; },
    };
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
            verifiedAt: "2026-08-08T00:00:00.000Z",
            endpointOriginHashes: {
                sink: expect.stringMatching(/^[a-f0-9]{64}$/),
                receipt: expect.stringMatching(/^[a-f0-9]{64}$/),
                acknowledge: expect.stringMatching(/^[a-f0-9]{64}$/),
                resolve: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
            integrity: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            attestation: expect.stringMatching(/^hmac-sha256:[a-f0-9]{64}$/),
        });
        expect(Object.keys(evidence)).toEqual([
            "status", "schemaVersion", "buildSha", "eventId", "emittedAt", "sinkReceivedAt",
            "alertReceivedAt", "acknowledgedAt", "resolvedAt", "verifiedAt", "endpointOriginHashes", "integrity", "attestation",
        ]);
        expect(JSON.parse(await readFile(output, "utf8"))).toEqual(evidence);
        const serialized = await readFile(output, "utf8");
        expect(serialized).not.toContain("https://");
        for (const token of Object.values(TOKENS)) expect(serialized).not.toContain(token);
        const { integrity, attestation, ...unsignedEvidence } = evidence;
        const canonicalize = (value: unknown): unknown => {
            if (Array.isArray(value)) return value.map(canonicalize);
            if (value && typeof value === "object") {
                return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
            }
            return value;
        };
        expect(integrity).toBe(`sha256:${createHash("sha256").update(JSON.stringify(canonicalize(unsignedEvidence))).digest("hex")}`);
        expect(attestation).toMatch(/^hmac-sha256:[a-f0-9]{64}$/);
        expect(attestation).toBe(`hmac-sha256:${createHmac("sha256", TOKENS.OMR_ALERT_EVIDENCE_HMAC_SECRET)
            .update(`omr.synthetic-alert-evidence:v1\0${JSON.stringify(canonicalize({ ...unsignedEvidence, integrity }))}`)
            .digest("hex")}`);
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
        const originalTransport = current.deps.transport;
        const deps = {
            ...current.deps,
            transport: (input: Parameters<typeof originalTransport>[0]) => {
                timeoutBounds.push(input.timeoutMs);
                return originalTransport(input);
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: "receipt_deadline" });
        expect(timeoutBounds).toEqual([1000, 1000, 750, 500, 250]);
    });

    it("never sleeps or polls beyond a non-divisible receipt deadline", async () => {
        const startedAt = Date.parse("2026-08-08T00:00:00.000Z");
        const current = await fixture({ responses: [
            new Response(null, { status: 202 }),
            ...Array.from({ length: 3 }, () => new Response(null, { status: 404 })),
        ] });
        const env = {
            ...current.env,
            OMR_ALERT_POLL_INTERVAL_MS: "400",
            OMR_ALERT_DEADLINE_MS: "1000",
        };

        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env }, current.deps)).rejects.toMatchObject({ code: "receipt_deadline" });

        expect(current.calls).toHaveLength(4);
        expect(current.sleepCalls).toEqual([400, 400, 200]);
        expect(current.currentTime() - startedAt).toBe(1000);
    });

    it("uses monotonic time so wall-clock rollback cannot extend receipt polling", async () => {
        const current = await fixture({ responses: [
            new Response(null, { status: 202 }),
            ...Array.from({ length: 4 }, () => new Response(null, { status: 404 })),
        ] });
        const originalSleep = current.deps.sleep;
        const deps = {
            ...current.deps,
            sleep: async (milliseconds: number) => {
                await originalSleep(milliseconds);
                current.setWallTime(current.currentTime() - 60_000);
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: "receipt_deadline" });
        expect(current.calls).toHaveLength(5);
        expect(current.sleepCalls).toEqual([250, 250, 250, 250]);
    });

    it("rejects provider timestamps beyond the five-minute local observation skew", async () => {
        const current = await fixture({ responses: [
            new Response(null, { status: 202 }),
            Response.json({ eventId: EVENT_ID, sinkReceivedAt: "2099-01-01T00:00:00.000Z", alertReceivedAt: "2099-01-01T00:00:01.000Z" }),
        ] });
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, current.deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(current.calls).toHaveLength(2);
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
            transport: async ({ url }: { url: URL }) => {
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

    it.each(["headers", "body"])("aborts pinned HTTPS when %s hang past timeout", async (phase) => {
        let timerCallback: (() => void) | undefined;
        let destroyed = false;
        const response = new EventEmitter();
        Object.assign(response, { statusCode: 200, headers: {} });
        const request = Object.assign(new EventEmitter(), {
            write: () => undefined,
            end: () => undefined,
            destroy: () => { destroyed = true; },
        });
        const transport = createHttpsTransport({
            requestImpl: ((_options: object, onResponse: (value: EventEmitter) => void) => {
                if (phase === "body") {
                    onResponse(response);
                    response.emit("data", Buffer.from("{"));
                }
                return request;
            }) as unknown as typeof import("node:https").request,
            setTimer: ((callback: () => void) => {
                timerCallback = callback;
                return 1;
            }) as unknown as typeof setTimeout,
            clearTimer: () => undefined,
        });
        const pending = transport({
            url: new URL("https://alerts.ops.vendor.com/v1/events"),
            address: "8.8.8.8",
            family: 4,
            method: "GET",
            headers: {},
            body: undefined,
            timeoutMs: 1000,
        });
        timerCallback?.();
        await expect(pending).rejects.toThrow("transport failure");
        expect(destroyed).toBe(true);
    });

    it.each([
        ["http endpoint", { OMR_ALERT_SINK_URL: "http://sink.example.test/v1/events" }],
        ["localhost endpoint", { OMR_ALERT_RECEIPT_URL: "https://localhost/v1/status" }],
        ["loopback endpoint", { OMR_ALERT_ACK_URL: "https://127.0.0.1/v1/ack" }],
        ["private endpoint", { OMR_ALERT_RESOLVE_URL: "https://10.0.0.1/v1/resolve" }],
        ["reserved test endpoint", { OMR_ALERT_SINK_URL: "https://sink.example.test/v1/events" }],
        ["trailing-dot localhost", { OMR_ALERT_SINK_URL: "https://localhost./v1/events" }],
        ["trailing-dot internal", { OMR_ALERT_SINK_URL: "https://alerts.internal./v1/events" }],
        ["documentation IPv4", { OMR_ALERT_SINK_URL: "https://192.0.2.1/v1/events" }],
        ["multicast IPv4", { OMR_ALERT_SINK_URL: "https://224.0.0.1/v1/events" }],
        ["documentation IPv6", { OMR_ALERT_SINK_URL: "https://[2001:db8::1]/v1/events" }],
        ["extended documentation IPv6", { OMR_ALERT_SINK_URL: "https://[3fff::1]/v1/events" }],
        ["mapped-private IPv6", { OMR_ALERT_SINK_URL: "https://[::ffff:10.0.0.1]/v1/events" }],
        ["credential reuse", { OMR_ALERT_ACK_TOKEN: TOKENS.OMR_ALERT_RESOLVE_TOKEN }],
        ["short credential", { OMR_ALERT_SINK_TOKEN: "short" }],
        ["credential whitespace", { OMR_ALERT_SINK_TOKEN: `${"s".repeat(32)} ` }],
    ])("rejects %s before network access", async (_label, override) => {
        const { output, calls, deps, env } = await fixture();
        await expect(runOperationalAlertExercise({ argv: ["--output", output], env: { ...env, ...override } }, deps)).rejects.toMatchObject({ code: "invalid_configuration" });
        expect(calls).toHaveLength(0);
    });

    it("rejects a DNS host when any A or AAAA answer is non-global", async () => {
        const current = await fixture();
        const deps = {
            ...current.deps,
            resolveAll: async () => [
                { address: "8.8.8.8", family: 4 },
                { address: "10.0.0.1", family: 4 },
            ],
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(current.calls).toHaveLength(0);
    });

    it("collects every A and AAAA answer while tolerating one absent family", async () => {
        await expect(resolveAllAddresses("alerts.ops.vendor.com", {
            resolveIpv4: (async () => ["1.1.1.1", "8.8.8.8"]) as unknown as typeof import("node:dns/promises").resolve4,
            resolveIpv6: (async () => ["2606:4700:4700::1111"]) as unknown as typeof import("node:dns/promises").resolve6,
        })).resolves.toEqual([
            { address: "1.1.1.1", family: 4 },
            { address: "8.8.8.8", family: 4 },
            { address: "2606:4700:4700::1111", family: 6 },
        ]);
        await expect(resolveAllAddresses("ipv4-only.ops.vendor.com", {
            resolveIpv4: (async () => ["1.1.1.1"]) as unknown as typeof import("node:dns/promises").resolve4,
            resolveIpv6: async () => { throw new Error("ENODATA"); },
        })).resolves.toEqual([{ address: "1.1.1.1", family: 4 }]);
    });

    it("accepts all-global A/AAAA answers and pins the vetted first address", async () => {
        const current = await fixture();
        const deps = {
            ...current.deps,
            resolveAll: async () => [
                { address: "2606:4700:4700::1111", family: 6 },
                { address: "1.1.1.1", family: 4 },
            ],
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).resolves.toMatchObject({ status: "verified" });
        expect(current.calls.every((call) => call.address === "2606:4700:4700::1111" && call.family === 6)).toBe(true);
    });

    it("canonicalizes one trailing DNS dot and transports only to the pinned address", async () => {
        const current = await fixture();
        const env = { ...current.env, OMR_ALERT_SINK_URL: "https://sink.ops.vendor.com./v1/events" };
        let resolutions = 0;
        const deps = {
            ...current.deps,
            resolveAll: async () => {
                resolutions += 1;
                return [{ address: "8.8.4.4", family: 4 }];
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env }, deps)).resolves.toMatchObject({ status: "verified" });
        expect(resolutions).toBe(4);
        expect(current.calls[0]).toMatchObject({ url: "https://sink.ops.vendor.com/v1/events", address: "8.8.4.4", family: 4 });
    });

    it.each([
        "0.0.0.0", "100.64.0.1", "127.0.0.1", "169.254.1.1", "172.16.0.1", "192.168.0.1",
        "198.18.0.1", "198.51.100.1", "203.0.113.1", "240.0.0.1",
        "::", "::1", "fc00::1", "fe80::1", "ff02::1", "2001:db8::1",
    ])("rejects resolved non-global address %s", async (address) => {
        const current = await fixture();
        const deps = {
            ...current.deps,
            resolveAll: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: expect.any(String) });
        expect(current.calls).toHaveLength(0);
    });

    it("requires a distinct bounded HMAC evidence secret", async () => {
        const { output, env } = await fixture();
        expect(() => parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_EVIDENCE_HMAC_SECRET: "short" })).toThrow();
        expect(() => parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_EVIDENCE_HMAC_SECRET: env.OMR_ALERT_SINK_TOKEN })).toThrow();
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

    it("rejects writable or symlinked output ancestors before transport", async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "omr-alert-ancestor-")));
        roots.push(root);
        await chmod(root, 0o700);
        const writableAncestor = join(root, "writable");
        const privateParent = join(writableAncestor, "private");
        await mkdir(privateParent, { recursive: true, mode: 0o700 });
        await chmod(writableAncestor, 0o777);
        await chmod(privateParent, 0o700);
        const linkedAncestor = join(root, "linked");
        await symlink(writableAncestor, linkedAncestor);
        for (const output of [join(privateParent, "evidence.json"), join(linkedAncestor, "private", "evidence.json")]) {
            const current = await fixture();
            await expect(runOperationalAlertExercise({ argv: ["--output", output], env: current.env }, current.deps)).rejects.toMatchObject({ code: "unsafe_output" });
            expect(current.calls).toHaveLength(0);
        }
    });

    it("fails if the secure parent identity changes before atomic publication", async () => {
        const current = await fixture();
        let parentReads = 0;
        const parent = dirname(current.output);
        const deps = {
            ...current.deps,
            fs: {
                lstat: async (path: string) => {
                    const stats = await lstat(path);
                    if (path === parent && ++parentReads > 1) {
                        return new Proxy(stats, { get: (target, property, receiver) => property === "ino" ? target.ino + 1 : Reflect.get(target, property, receiver) });
                    }
                    return stats;
                },
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: "unsafe_output" });
        await expect(lstat(current.output)).rejects.toThrow();
        expect((await readdir(parent)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    });

    it.each(["link", "unlink", "directory-fsync"])("cleans owned publication artifacts when %s fails", async (phase) => {
        const current = await fixture();
        const parent = dirname(current.output);
        let unlinkAttempts = 0;
        const deps = {
            ...current.deps,
            fs: {
                link: async (source: string, destination: string) => {
                    if (phase === "link") throw new Error("injected-link-secret");
                    await linkFile(source, destination);
                },
                unlink: async (path: string) => {
                    unlinkAttempts += 1;
                    if (phase === "unlink" && unlinkAttempts === 1) throw new Error("injected-unlink-secret");
                    await unlink(path);
                },
                open: async (path: string, flags: string, mode?: number) => {
                    const handle = await open(path, flags, mode);
                    if (phase !== "directory-fsync" || path !== parent) return handle;
                    return {
                        sync: async () => { throw new Error("injected-directory-fsync-secret"); },
                        close: () => handle.close(),
                    };
                },
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: "unsafe_output" });
        await expect(lstat(current.output)).rejects.toThrow();
        expect((await readdir(parent)).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    });

    it("publishes only complete JSON and permits exactly one concurrent winner", async () => {
        const first = await fixture();
        const second = await fixture();
        const secondDeps = { ...second.deps };
        const results = await Promise.allSettled([
            runOperationalAlertExercise({ argv: ["--output", first.output], env: first.env }, first.deps),
            runOperationalAlertExercise({ argv: ["--output", first.output], env: second.env }, secondDeps),
        ]);
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
        expect(JSON.parse(await readFile(first.output, "utf8"))).toMatchObject({ status: "verified" });
        expect((await readdir(dirname(first.output))).filter((name) => name.includes(".tmp"))).toHaveLength(0);
    });

    it("keeps the final path absent until a complete temp inode is atomically linked", async () => {
        const current = await fixture();
        let inspected = false;
        const deps = {
            ...current.deps,
            fs: {
                link: async (source: string, destination: string) => {
                    await expect(lstat(destination)).rejects.toThrow();
                    expect(JSON.parse(await readFile(source, "utf8"))).toMatchObject({ status: "verified" });
                    inspected = true;
                    await linkFile(source, destination);
                },
            },
        };
        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).resolves.toMatchObject({ status: "verified" });
        expect(inspected).toBe(true);
        expect(JSON.parse(await readFile(current.output, "utf8"))).toMatchObject({ status: "verified" });
    });

    it("creates evidence exclusively at 0600 before writing, then syncs and closes", async () => {
        const current = await fixture();
        const lifecycle: string[] = [];
        const deps = {
            ...current.deps,
            fs: {
                lstat,
                link: async (source: string, destination: string) => {
                    lifecycle.push("link");
                    await linkFile(source, destination);
                },
                unlink: async (path: string) => {
                    lifecycle.push("unlink");
                    await unlink(path);
                },
                open: async (path: string, flags: string, mode: number) => {
                    if (path === dirname(current.output)) {
                        lifecycle.push("dir-open");
                        const directory = await open(path, flags);
                        return {
                            sync: async () => {
                                lifecycle.push("dir-sync");
                                await directory.sync();
                            },
                            close: async () => {
                                lifecycle.push("dir-close");
                                await directory.close();
                            },
                        };
                    }
                    lifecycle.push(`open:${flags}:${mode.toString(8)}`);
                    const handle = await open(path, flags, mode);
                    return {
                        chmod: async (nextMode: number) => {
                            lifecycle.push(`chmod:${nextMode.toString(8)}`);
                            await handle.chmod(nextMode);
                        },
                        writeFile: async (data: string, options: object) => {
                            lifecycle.push("write");
                            await handle.writeFile(data, options);
                        },
                        sync: async () => {
                            lifecycle.push("sync");
                            await handle.sync();
                        },
                        stat: async () => {
                            lifecycle.push("stat");
                            return handle.stat();
                        },
                        close: async () => {
                            lifecycle.push("close");
                            await handle.close();
                        },
                    };
                },
            },
        };

        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).resolves.toMatchObject({ status: "verified" });
        expect(lifecycle).toEqual([
            "open:wx:600", "stat", "chmod:600", "write", "sync", "stat", "close", "link", "unlink",
            "dir-open", "dir-sync", "dir-close",
        ]);
        expect((await lstat(current.output)).mode & 0o777).toBe(0o600);
    });

    it.each(["chmod", "write", "sync", "close", "lstat", "mode"] as const)(
        "removes its newly created file when %s finalization fails",
        async (failure) => {
            const current = await fixture();
            let outputLstatCalls = 0;
            let unlinkCalls = 0;
            const deps = {
                ...current.deps,
                fs: {
                    unlink: async (path: string) => {
                        unlinkCalls += 1;
                        await unlink(path);
                    },
                    lstat: async (path: string) => {
                        if (path === current.output) {
                            outputLstatCalls += 1;
                            if (failure === "lstat" && outputLstatCalls > 1) throw new Error("injected-lstat-secret");
                        }
                        const stats = await lstat(path);
                        if (failure === "mode" && path === current.output && outputLstatCalls > 1) {
                            return new Proxy(stats, {
                                get: (target, property, receiver) => property === "mode"
                                    ? (target.mode & ~0o777) | 0o644
                                    : Reflect.get(target, property, receiver),
                            });
                        }
                        return stats;
                    },
                    open: async (path: string, flags: string, mode: number) => {
                        const handle = await open(path, flags, mode);
                        let closed = false;
                        let statCalls = 0;
                        return {
                            stat: async () => {
                                statCalls += 1;
                                if (failure === "lstat" && statCalls === 2) throw new Error("injected-stat-secret");
                                const stats = await handle.stat();
                                if (failure === "mode" && statCalls === 2) {
                                    return new Proxy(stats, {
                                        get: (target, property, receiver) => property === "mode"
                                            ? (target.mode & ~0o777) | 0o644
                                            : Reflect.get(target, property, receiver),
                                    });
                                }
                                return stats;
                            },
                            chmod: async (nextMode: number) => {
                                if (failure === "chmod") throw new Error("injected-chmod-secret");
                                await handle.chmod(nextMode);
                            },
                            writeFile: async (data: string, options: object) => {
                                await handle.writeFile(data, options);
                                if (failure === "write") throw new Error("injected-write-secret");
                            },
                            sync: async () => {
                                await handle.sync();
                                if (failure === "sync") throw new Error("injected-sync-secret");
                            },
                            close: async () => {
                                if (!closed) {
                                    await handle.close();
                                    closed = true;
                                }
                                if (failure === "close") throw new Error("injected-close-secret");
                            },
                        };
                    },
                },
            };

            await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({
                code: "unsafe_output",
                message: "Synthetic alert exercise is unverified",
            });
            await expect(lstat(current.output)).rejects.toThrow();
            expect(unlinkCalls).toBeGreaterThanOrEqual(1);
        },
    );

    it("never unlinks a path that won the exclusive-create race", async () => {
        const current = await fixture();
        let unlinkCalls = 0;
        const deps = {
            ...current.deps,
            fs: {
                lstat,
                unlink: async () => { unlinkCalls += 1; },
                open: async () => {
                    await writeFile(current.output, "pre-existing-winner", { flag: "wx", mode: 0o600 });
                    const error = new Error("race") as NodeJS.ErrnoException;
                    error.code = "EEXIST";
                    throw error;
                },
            },
        };

        await expect(runOperationalAlertExercise({ argv: ["--output", current.output], env: current.env }, deps)).rejects.toMatchObject({ code: "unsafe_output" });
        expect(await readFile(current.output, "utf8")).toBe("pre-existing-winner");
        expect(unlinkCalls).toBe(0);
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
        expect(messages.join("\n")).toBe("unverified: invalid_configuration");
        expect(messages.join("\n")).not.toContain(secret);
        expect(calls).toHaveLength(0);
        await expect(lstat(output)).rejects.toThrow();
    });

    it("prints only an allowlisted code when transport throws secret-bearing diagnostics", async () => {
        const current = await fixture();
        const messages: string[] = [];
        const exitCode = await runOperationalAlertCli({
            argv: ["--output", current.output],
            env: current.env,
            deps: {
                ...current.deps,
                transport: async () => { throw new Error(`${current.env.OMR_ALERT_SINK_TOKEN} https://private.invalid`); },
            },
            stderr: (message: string) => messages.push(message),
        });
        expect(exitCode).toBe(1);
        expect(messages).toEqual(["unverified: request_failed"]);
        expect(messages[0]).not.toContain(current.env.OMR_ALERT_SINK_TOKEN);
        expect(messages[0]).not.toContain("https://");
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

    it("accepts an otherwise valid 2048-character endpoint and rejects 2049 characters", async () => {
        const { output, env } = await fixture();
        const prefix = "https://sink.ops.vendor.com/";
        const exact = `${prefix}${"a".repeat(2048 - prefix.length)}`;
        const oversized = `${prefix}${"a".repeat(2049 - prefix.length)}`;
        expect(exact).toHaveLength(2048);
        expect(new URL(exact).href).toHaveLength(2048);
        const parsed = parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_SINK_URL: exact });
        expect(parsed.endpoints.sink).toBeDefined();
        expect(parsed.endpoints.sink?.href).toHaveLength(2048);
        expect(() => parseOperationalAlertInput(["--output", output], { ...env, OMR_ALERT_SINK_URL: oversized })).toThrowError(/unverified/i);
    });

    it("wires the exact npm command and release evidence freshness contract", async () => {
        const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8"));
        const template = await readFile(join(process.cwd(), "docs/operations/release-evidence-template.md"), "utf8");
        expect(packageJson.scripts["ops:alert:verify"]).toBe("node scripts/verify-operational-alert.mjs");
        expect(template).toContain("npm run ops:alert:verify -- --output /absolute/private/path/operational-alert-evidence.json");
        expect(template).toContain("freshness 30일 이내");
        expect(template).toContain("외부 시스템 실행만 `verified` 가능");
        expect(template).toContain("최대 2048자");
    });
});
