import { describe, expect, it } from "vitest";
import { isSameOriginServerActionRequest } from "./serverActionSecurity";

function headers(values: Record<string, string>): Headers {
    return new Headers(values);
}

describe("server action security", () => {
    it("allows same-origin requests by host and falls back to forwarded host only when host is absent", () => {
        expect(isSameOriginServerActionRequest(headers({
            origin: "https://omr.example.com",
            host: "omr.example.com",
        }))).toBe(true);

        expect(isSameOriginServerActionRequest(headers({
            origin: "https://preview.example.com",
            "x-forwarded-host": "preview.example.com",
        }))).toBe(true);

        expect(isSameOriginServerActionRequest(headers({
            origin: "https://preview.example.com",
            host: "internal.example.com",
            "x-forwarded-host": "preview.example.com",
        }))).toBe(false);
    });

    it("allows non-browser calls without an Origin header", () => {
        expect(isSameOriginServerActionRequest(headers({
            host: "omr.example.com",
        }))).toBe(true);
    });

    it("rejects cross-origin, malformed, or unhosted requests", () => {
        expect(isSameOriginServerActionRequest(headers({
            origin: "https://evil.example",
            host: "omr.example.com",
        }))).toBe(false);

        expect(isSameOriginServerActionRequest(headers({
            origin: "not-a-url",
            host: "omr.example.com",
        }))).toBe(false);

        expect(isSameOriginServerActionRequest(headers({
            origin: "https://omr.example.com",
        }))).toBe(false);
    });
});
