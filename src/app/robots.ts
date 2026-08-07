import type { MetadataRoute } from "next";
import { resolveSiteOrigin } from "@/lib/siteOrigin";

export default function robots(): MetadataRoute.Robots {
    return {
        // Explicit crawler deny-list; this is indexing guidance, not access control.
        rules: [{
            userAgent: "*",
            allow: ["/", "/pwa-check"],
            disallow: ["/teacher/", "/student/", "/solve/", "/create", "/settings", "/groups", "/api/"],
        }],
        sitemap: `${resolveSiteOrigin()}/sitemap.xml`,
    };
}
