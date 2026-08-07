import { afterEach, describe, expect, it, vi } from "vitest";
import {
    deliverTeacherAccountToken,
    probeTeacherAccountDelivery,
    resolveTeacherAccountDeliveryAdapter,
    type TeacherAccountDeliveryAdapter,
} from "./teacherAccountDelivery";

describe("teacher account delivery seam", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("is explicitly unavailable without an installed external adapter", async () => {
        const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const input = {
            purpose: "password_reset" as const,
            email: "teacher@example.com",
            token: "super-secret-one-time-token",
            expiresAt: 2_000,
        };

        expect(resolveTeacherAccountDeliveryAdapter()).toBeNull();
        await expect(deliverTeacherAccountToken(input)).resolves.toEqual({ status: "unavailable" });
        expect(log).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
    });

    it("passes plaintext token only to the explicitly injected adapter", async () => {
        const deliver = vi.fn(async () => ({ accepted: true as const }));
        const adapter: TeacherAccountDeliveryAdapter = { deliver };
        const input = {
            purpose: "email_verify" as const,
            email: "teacher@example.com",
            token: "one-time-token",
            expiresAt: 2_000,
        };

        await expect(deliverTeacherAccountToken(input, adapter)).resolves.toEqual({ status: "delivered" });
        expect(deliver).toHaveBeenCalledWith(input);
    });

    it("builds a bounded signed HTTPS webhook adapter only from complete server configuration", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"accepted":true}', {
            status: 202,
            headers: { "content-type": "application/json" },
        }));
        vi.stubGlobal("fetch", fetchMock);
        const env = {
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/omr/accounts",
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET: "s".repeat(48),
        };
        const adapter = resolveTeacherAccountDeliveryAdapter(env);
        expect(adapter).not.toBeNull();

        const input = {
            purpose: "email_verify" as const,
            email: "teacher@example.com",
            token: "one-time-token",
            expiresAt: 2_000,
        };
        await expect(deliverTeacherAccountToken(input, adapter)).resolves.toEqual({ status: "delivered" });
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(init).toBeDefined();
        if (!init) throw new Error("missing fetch init");
        expect(url).toBe(env.OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL);
        expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
        const requestHeaders = new Headers(init.headers);
        expect(requestHeaders.get("content-type")).toBe("application/json");
        expect(requestHeaders.get("x-omr-signature-version")).toBe("v1");
        expect(requestHeaders.get("x-omr-signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
        expect(typeof init.body).toBe("string");
        if (typeof init.body !== "string") throw new Error("missing JSON request body");
        expect(JSON.parse(init.body)).toMatchObject(input);
    });

    it("uses a signed side-effect-free HEAD request as the delivery readiness probe", async () => {
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
        const env = {
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/omr/accounts",
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET: "s".repeat(48),
        };

        await expect(probeTeacherAccountDelivery(env, fetchMock, 250)).resolves.toBe("ready");
        expect(fetchMock).toHaveBeenCalledOnce();
        const [url, init] = fetchMock.mock.calls[0]!;
        expect(url).toBe(env.OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL);
        expect(init).toMatchObject({ method: "HEAD", body: undefined, redirect: "error", cache: "no-store" });
        const requestHeaders = new Headers(init?.headers);
        expect(requestHeaders.get("x-omr-delivery-probe")).toBe("readiness");
        expect(requestHeaders.get("x-omr-signature")).toMatch(/^sha256=[a-f0-9]{64}$/);
    });

    it("fails delivery readiness for missing configuration, 5xx, and timeout", async () => {
        await expect(probeTeacherAccountDelivery({}, vi.fn(), 100)).resolves.toBe("not_configured");
        const env = {
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/omr/accounts",
            OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET: "s".repeat(48),
        };
        await expect(probeTeacherAccountDelivery(
            env,
            vi.fn(async () => new Response(null, { status: 503 })),
            100,
        )).resolves.toBe("probe_failed");
        await expect(probeTeacherAccountDelivery(
            env,
            vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            })),
            10,
        )).resolves.toBe("probe_timeout");
    });

    it("fails closed on missing, weak, or non-HTTPS webhook configuration", () => {
        expect(resolveTeacherAccountDeliveryAdapter({})).toBeNull();
        for (const env of [
            { OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/hook" },
            {
                OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "http://mailer.example.test/hook",
                OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET: "s".repeat(48),
            },
            {
                OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_URL: "https://mailer.example.test/hook",
                OMR_TEACHER_ACCOUNT_DELIVERY_WEBHOOK_SECRET: "weak",
            },
        ]) expect(() => resolveTeacherAccountDeliveryAdapter(env)).toThrow(/delivery webhook/i);
    });
});
