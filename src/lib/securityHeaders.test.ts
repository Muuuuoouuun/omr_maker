import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSecurityHeaders(nodeEnv: string) {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", nodeEnv);
    const { default: nextConfig } = await import("../../next.config");
    const routes = await nextConfig.headers?.();
    const catchAll = routes?.find(route => route.source === "/:path*");
    return new Map(catchAll?.headers.map(header => [header.key, header.value]));
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("security response headers", () => {
    it("denies framing, MIME sniffing, sensitive device APIs, and referrer leakage", async () => {
        vi.resetModules();
        const { default: nextConfig } = await import("../../next.config");
        const headers = await loadSecurityHeaders("test");

        expect(nextConfig.poweredByHeader).toBe(false);
        expect(headers.get("X-Frame-Options")).toBe("DENY");
        expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
        expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
        expect(headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        expect(headers.has("Strict-Transport-Security")).toBe(false);
    });

    it("enables HSTS only for production deployment", async () => {
        const headers = await loadSecurityHeaders("production");

        expect(headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    });
});
