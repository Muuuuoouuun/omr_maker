const isProduction = process.env.NODE_ENV === "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  // Next.js emits inline bootstrap scripts and the UI uses inline component
  // styles. Development additionally needs eval for source maps/HMR.
  `script-src 'self' 'unsafe-inline'${isProduction ? "" : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  // Remote API/storage traffic is HTTPS/WSS. PDF.js also reads locally
  // generated data/blob URLs without granting another network origin.
  "connect-src 'self' https: wss: data: blob:",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  // pdf.js and generated previews use blob-backed workers/resources.
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "media-src 'self' data: blob:",
  "manifest-src 'self'",
].join("; ");

const baselineSecurityHeaders = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  {
    key: "Content-Security-Policy",
    value: contentSecurityPolicy,
  },
];

// Next.js Server Action ids change between builds. A student can keep a solve
// page open for 80+ minutes while Vercel promotes a newer deployment, so tag
// each build and let Next.js hard-reload on version skew before it posts an old
// action id. Vercel's raw id starts with the prefix reserved from custom ids.
const deploymentId = process.env.VERCEL_DEPLOYMENT_ID
  ?.replace(/^dpl_/, "")
  .slice(0, 32);
const isDesktopRuntime = process.env.OMR_DESKTOP_RUNTIME === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  ...(deploymentId ? { deploymentId } : {}),
  ...(isDesktopRuntime
    ? {
        images: {
          // Electron serves from a read-only ASAR, so retain optimization without
          // attempting to create `.next/cache/images` inside the archive.
          maximumDiskCacheSize: 0,
        },
      }
    : {}),
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
      ...(isProduction
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
        // leakage of exam ids. Next bootstrap/component styles require inline
        // allowances until nonce-based rendering is adopted; remote data
        // traffic is limited to HTTPS/WSS and workers to same-origin/blob.
        source: "/:path*",
        headers: globalHeaders,
      },
    ];
  },
};

export default nextConfig;
