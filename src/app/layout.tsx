import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
// Pretendard's dynamic subset: 92 @font-face rules that split the Korean glyph
// set by unicode-range, so the browser fetches only the ranges a page actually
// renders. See the --font-pretendard note in globals.css for why this is not
// wired through next/font/local.
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";
import ToastHost from "@/components/Toast";
import PWARegister from "@/components/PWARegister";
import MobileInstallPrompt from "@/components/MobileInstallPrompt";
import SyncFlusher from "@/components/SyncFlusher";
import ViewportHeightSync from "@/components/ViewportHeightSync";
import NativePlatformSync from "@/components/NativePlatformSync";
import TeacherIdentityModeProvider from "@/components/TeacherIdentityModeProvider";
import { PWA_STARTUP_IMAGE_LINKS } from "@/lib/pwaStartupImages";
import { TEACHER_RECOVERY_SAFE_NEXT_PATHS } from "@/lib/teacherRecoveryCanonical";
import { resolveTeacherIdentityMode } from "@/lib/teacherIdentityMode.server";

export const metadata: Metadata = {
  applicationName: "OMR Maker",
  title: "OMR Maker",
  description: "교사와 학생을 위한 스마트 OMR 시험 제작, 배포, 채점 앱.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    startupImage: PWA_STARTUP_IMAGE_LINKS,
    title: "OMR Maker",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-48.png", sizes: "48x48", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: [{ url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" }],
    apple: [
      { url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
      { url: "/icons/icon-152.png", sizes: "152x152", type: "image/png" },
      { url: "/icons/icon-167.png", sizes: "167x167", type: "image/png" },
      { url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" },
    ],
  },
  other: {
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-title": "OMR Maker",
    "msapplication-config": "/browserconfig.xml",
    "msapplication-TileColor": "#f8fafc",
    "msapplication-TileImage": "/icons/mstile-150.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#111827" },
  ],
};

// Runs before React hydration to prevent flash of wrong theme.
// Handles "auto" by resolving from the user's OS preference at boot.
const themeInitScript = `
(function() {
  try {
    var settings = {};
    try {
      var rawSettings = localStorage.getItem('omr_settings');
      settings = rawSettings ? JSON.parse(rawSettings) : {};
    } catch (settingsError) {
      settings = {};
    }
    var appTheme = settings && settings.theme && typeof settings.theme === 'object' ? settings.theme : {};
    var saved = localStorage.getItem('omr_theme');
    if (saved !== 'dark' && saved !== 'light' && saved !== 'auto') {
      saved = appTheme.mode;
    }
    var theme = 'light';
    if (saved === 'dark' || saved === 'light') {
      theme = saved;
    } else if (saved === 'auto') {
      theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    var root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('data-motion', appTheme.motion === false ? 'off' : 'on');

    var accentPalettes = {
      '#4f46e5': ['#818cf8', '#3730a3'],
      '#ec4899': ['#f472b6', '#be185d'],
      '#8b5cf6': ['#a78bfa', '#6d28d9'],
      '#10b981': ['#34d399', '#047857'],
      '#f59e0b': ['#fbbf24', '#b45309'],
      '#ef4444': ['#f87171', '#b91c1c']
    };
    var accent = typeof appTheme.accent === 'string' ? appTheme.accent.toLowerCase() : '';
    var palette = accentPalettes[accent];
    if (palette) {
      root.style.setProperty('--primary', accent);
      root.style.setProperty('--primary-light', palette[0]);
      root.style.setProperty('--primary-dark', palette[1]);
    }
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-motion', 'on');
  }
})();
`;

// Provisioned deployments must replace legacy lifecycle URLs before React or
// Next's client router can retain the token-bearing route as an action target.
// The non-secret sentinel restores the honest operator-recovery surface after
// the canonical, token-free document has loaded.
const teacherLegacyLinkCanonicalizationScript = `
(function() {
  try {
    var url = new URL(window.location.href);
    var hasLegacyTeacherToken = url.searchParams.has('teacherResetToken') || url.searchParams.has('teacherVerifyToken');
    if (!hasLegacyTeacherToken) return;
    var canonicalSearch = new URLSearchParams();
    canonicalSearch.set('role', 'teacher');
    canonicalSearch.set('teacherRecovery', 'legacy_link');
    var requestedNextValues = url.searchParams.getAll('next');
    var requestedNext = requestedNextValues.length === 1 ? requestedNextValues[0] : '';
    var safeNextPaths = ${JSON.stringify(TEACHER_RECOVERY_SAFE_NEXT_PATHS)};
    if (safeNextPaths.indexOf(requestedNext) !== -1) {
      canonicalSearch.set('next', requestedNext);
    }
    var canonicalUrl = '/?' + canonicalSearch.toString();
    window.location.replace(canonicalUrl);
  } catch (e) {
    // The client effect provides a second fail-closed redirect if URL parsing
    // is unavailable during the pre-hydration pass.
  }
})();
`;

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const teacherIdentityMode = resolveTeacherIdentityMode();
  const nonce = (await headers()).get("x-nonce") || undefined;

  return (
    <html lang="ko" data-theme="light" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeInitScript }} />
        {teacherIdentityMode === "provisioned_only" ? (
          <script nonce={nonce} dangerouslySetInnerHTML={{ __html: teacherLegacyLinkCanonicalizationScript }} />
        ) : null}
      </head>
      <body>
        <NativePlatformSync />
        <ViewportHeightSync />
        <PWARegister />
        <SyncFlusher />
        <TeacherIdentityModeProvider mode={teacherIdentityMode}>
          {children}
        </TeacherIdentityModeProvider>
        <MobileInstallPrompt />
        <ToastHost />
      </body>
    </html>
  );
}
