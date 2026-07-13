/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    root: process.cwd(),
  },
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb', // 전송 용량을 10MB로 확대
    },
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
      {
        // Baseline security headers for every route. The teacher console and
        // student solve pages authenticate with signed session cookies, so
        // block framing (clickjacking against force-finish/delete/distribute
        // buttons), MIME sniffing, and Referer leakage of exam ids. A fuller
        // CSP (script-src etc.) needs testing against the inline theme script
        // and pdf.js workers, so we start with frame-ancestors and tighten
        // incrementally.
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
};

export default nextConfig;
