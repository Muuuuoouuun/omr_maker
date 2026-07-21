import { afterEach, describe, expect, it, vi } from "vitest";

async function loadSecurityHeaders(nodeEnv: string) {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", nodeEnv);
    const { default: nextConfig } = await import("../../next.config");
    const routes = await nextConfig.headers?.();
    const catchAll = routes?.find(route => route.source === "/:path*");
    return {
        headers: new Map(catchAll?.headers.map(header => [header.key, header.value])),
        routes: routes || [],
    };
}

afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe("security response headers", () => {
    it("denies framing, MIME sniffing, sensitive device APIs, and referrer leakage", async () => {
        vi.resetModules();
        const { default: nextConfig } = await import("../../next.config");
        const { headers, routes } = await loadSecurityHeaders("test");

        expect(nextConfig.poweredByHeader).toBe(false);
        expect(headers.get("X-Frame-Options")).toBe("DENY");
        expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
        expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
        expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
        expect(headers.get("Content-Security-Policy")).toContain("base-uri 'self'");
        expect(headers.get("Content-Security-Policy")).toContain("object-src 'none'");
        expect(headers.get("Content-Security-Policy")).toContain("form-action 'self'");
        expect(headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=(), payment=(), usb=()");
        expect(headers.has("Strict-Transport-Security")).toBe(false);
        expect(routes.filter(route => route.source === "/:path*" || route.source === "/(.*)")).toHaveLength(1);
    });

    it("enables HSTS only for production deployment", async () => {
        const { headers } = await loadSecurityHeaders("production");

        expect(headers.get("Strict-Transport-Security")).toBe("max-age=31536000; includeSubDomains");
    });
});
