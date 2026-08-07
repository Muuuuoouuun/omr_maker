import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SITE_ORIGIN, resolveSiteOrigin } from "@/lib/siteOrigin";
import robots from "./robots";
import sitemap from "./sitemap";

const productionOrigin = "https://omr-maker-eight.vercel.app";

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("metadata routes", () => {
    it("publishes public crawl guidance and excludes private workflows", () => {
        vi.stubEnv("NEXT_PUBLIC_SHARE_BASE_URL", "");

        expect(robots()).toEqual({
            rules: [{
                userAgent: "*",
                allow: ["/", "/pwa-check"],
                disallow: ["/teacher/", "/student/", "/solve/", "/create", "/settings", "/groups", "/api/"],
            }],
            sitemap: `${productionOrigin}/sitemap.xml`,
        });
    });

    it("limits the sitemap to public surfaces and uses the configured share origin", () => {
        vi.stubEnv("NEXT_PUBLIC_SHARE_BASE_URL", "https://preview.example.com/");

        expect(sitemap()).toEqual([
            { url: "https://preview.example.com/" },
            { url: "https://preview.example.com/pwa-check" },
        ]);
    });
});

describe("resolveSiteOrigin", () => {
    it("trims a configured public origin", () => {
        vi.stubEnv("NEXT_PUBLIC_SHARE_BASE_URL", "  https://preview.example.com/  ");

        expect(resolveSiteOrigin()).toBe("https://preview.example.com");
    });

    it("strips paths and queries from the configured public origin", () => {
        vi.stubEnv("NEXT_PUBLIC_SHARE_BASE_URL", "https://preview.example.com/deployment?source=share#top");

        expect(resolveSiteOrigin()).toBe("https://preview.example.com");
    });

    it("falls back to the production origin for an invalid URL", () => {
        vi.stubEnv("NEXT_PUBLIC_SHARE_BASE_URL", "not a URL");

        expect(resolveSiteOrigin()).toBe(DEFAULT_SITE_ORIGIN);
    });

    it("falls back to the production origin for a non-HTTP URL", () => {
        vi.stubEnv("NEXT_PUBLIC_SHARE_BASE_URL", "ftp://preview.example.com");

        expect(resolveSiteOrigin()).toBe(DEFAULT_SITE_ORIGIN);
    });
});
