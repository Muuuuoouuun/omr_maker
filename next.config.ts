const baselineSecurityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  turbopack: {
    root: process.cwd(),
  },
  allowedDevOrigins: ["127.0.0.1"],
  experimental: {
    serverActions: {
      bodySizeLimit: '52mb', // 비공개 Storage에 전달할 최대 50MB PDF + multipart 여유
    },
  },
  async headers() {
    const globalHeaders = [
      ...baselineSecurityHeaders,
      ...(process.env.NODE_ENV === "production"
        ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
        : []),
    ];

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
        // buttons), MIME sniffing, unsafe base/object/form targets, and Referer
        // leakage of exam ids. script-src/connect-src still need nonce and pdf.js
        // worker validation before they can be tightened safely.
        source: "/:path*",
        headers: globalHeaders,
      },
    ];
  },
};

export default nextConfig;
