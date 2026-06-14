import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import ToastHost from "@/components/Toast";
import PWARegister from "@/components/PWARegister";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "OMR Maker",
  title: "OMR Maker",
  description: "Create and customize your OMR sheets easily.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "OMR Maker",
    statusBarStyle: "default",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
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
    var saved = localStorage.getItem('omr_theme');
    var theme = 'light';
    if (saved === 'dark' || saved === 'light') {
      theme = saved;
    } else if (saved === 'auto') {
      theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <PWARegister />
        {children}
        <ToastHost />
      </body>
    </html>
  );
}
