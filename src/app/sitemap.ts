import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/siteOrigin";

export default function sitemap(): MetadataRoute.Sitemap {
    const siteOrigin = resolveSiteOrigin();

    return [
        { url: new URL("/", siteOrigin).toString() },
        { url: new URL("/pwa-check", siteOrigin).toString() },
    ];
}
