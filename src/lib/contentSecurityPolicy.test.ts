import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { browserConnectionSources, contentSecurityPolicy } from "./contentSecurityPolicy";
import { proxy } from "../proxy";

describe("CSP request and network boundaries", () => {
    it("allows only the selected project and its direct-upload host", () => {
        expect(browserConnectionSources({ NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co" })).toEqual([
            "'self'", "data:", "blob:", "https://project.supabase.co", "wss://project.supabase.co", "https://project.storage.supabase.co",
        ]);
        for (const url of ["https://user:secret@evil.test", "javascript:alert(1)", "invalid", "http://evil.test"]) {
            expect(browserConnectionSources({ NEXT_PUBLIC_SUPABASE_URL: url })).toEqual(["'self'", "data:", "blob:"]);
        }
    });

    it("permits production scripts only with the server nonce", () => {
        const policy = contentSecurityPolicy({ NODE_ENV: "production" }, "test-nonce");
        const script = policy.split('; ').find(value => value.startsWith('script-src'));
        expect(script).toBe("script-src 'self' 'nonce-test-nonce' 'strict-dynamic'");
        expect(script).not.toContain("unsafe-inline");
        expect(script).not.toContain("unsafe-eval");
    });

    it("matches the server gateway URL when a stale public URL is also configured", () => {
        const sources = browserConnectionSources({
            SUPABASE_URL: "https://active.supabase.co",
            NEXT_PUBLIC_SUPABASE_URL: "https://old.supabase.co",
        });
        expect(sources).toContain("https://active.storage.supabase.co");
        expect(sources).not.toContain("https://old.supabase.co");
    });

    it("overwrites forged nonces and does not share the nonce across requests", () => {
        const request = () => new NextRequest("https://school.test/", { headers: { "x-nonce": "attacker" } });
        const first = proxy(request());
        const second = proxy(request());
        const firstNonce = first.headers.get("x-middleware-request-x-nonce");
        expect(firstNonce).toMatch(/^[A-Za-z0-9+/]{43}=$/);
        expect(second.headers.get("x-middleware-request-x-nonce")).not.toBe(firstNonce);
        expect(first.headers.get("cache-control")).toBe("private, no-store");
    });
});
