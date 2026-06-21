"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Check, CheckCircle2, Clipboard, ExternalLink, RefreshCcw, Share2, Smartphone } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";

type CheckTone = "pass" | "warn" | "fail";
type ProofPlatform = "android" | "ios" | "unknown";
type ProofTarget = Exclude<ProofPlatform, "unknown">;
type ProofBundleState = "copied" | "failed" | "idle" | "shared";

interface DeviceCheck {
  detail: string;
  id: string;
  label: string;
  tone: CheckTone;
  value: string;
}

interface RuntimeSnapshot {
  checks: DeviceCheck[];
  checkedAt: string;
  displayMode: string;
  displayModeEvidence: string;
  userAgent: string;
}

interface CheckSummary {
  fails: number;
  passes: number;
  warnings: number;
}

interface ParsedProofReport {
  checks: Record<string, { detail: string; tone: string; value: string }>;
  fields: Record<string, string>;
  header: string;
}

interface ProofValidationResult {
  displayMode: string;
  errors: string[];
  installedDisplay: string;
  platform: ProofPlatform;
  proofStatus: string;
  status: "failed" | "passed";
  url: string;
  userAgent: string;
  verdict: string;
}

interface ProofTargetConfig {
  detail: string;
  errorTestId: string;
  inputTestId: string;
  label: string;
  platform: ProofTarget;
  resultTestId: string;
}

const VIEWPORT_HEIGHT_VAR = "--app-viewport-height";
const VIEWPORT_WIDTH_VAR = "--app-viewport-width";
const VIEWPORT_OFFSET_TOP_VAR = "--app-visual-viewport-offset-top";
const VIEWPORT_OFFSET_LEFT_VAR = "--app-visual-viewport-offset-left";
const VIEWPORT_SCALE_VAR = "--app-visual-viewport-scale";
const KEYBOARD_INSET_BOTTOM_VAR = "--app-keyboard-inset-bottom";
const OFFLINE_CACHE_REQUIRED_PATHS = ["/", "/pwa-check", "/offline.html", "/logo.png"];
const DUAL_PROOF_HEADER = "OMR Maker PWA dual device proof";
const PROOF_INSTALLED_MODES = new Set(["standalone", "fullscreen"]);
const REQUIRED_PROOF_PASS_CHECKS = [
  "secure-context",
  "display-mode",
  "launch-proof",
  "service-worker",
  "offline-cache",
  "manifest",
  "viewport",
  "viewport-height",
  "keyboard-safe-area",
  "mobile-meta",
  "handoff-origin",
  "overflow",
  "storage",
  "install-prompt",
];

const CHECK_TONE_META: Record<CheckTone, { background: string; color: string; icon: typeof CheckCircle2; label: string }> = {
  pass: { background: "rgba(16, 185, 129, 0.1)", color: "var(--success)", icon: CheckCircle2, label: "통과" },
  warn: { background: "rgba(245, 158, 11, 0.12)", color: "var(--warning)", icon: AlertTriangle, label: "확인" },
  fail: { background: "rgba(239, 68, 68, 0.1)", color: "var(--error)", icon: AlertTriangle, label: "조치" },
};

const INSTALL_PROOF_STEPS = [
  {
    detail: "QR 또는 링크를 실제 Android Chrome / iPhone Safari에서 엽니다.",
    label: "실기기 열기",
  },
  {
    detail: "Android는 설치, iOS는 공유 메뉴의 홈 화면에 추가를 완료합니다.",
    label: "홈 화면 추가",
  },
  {
    detail: "홈 화면 아이콘으로 다시 열고 앱 실행 통과 리포트를 복사합니다.",
    label: "아이콘 실행",
  },
];

const PROOF_TARGETS: ProofTargetConfig[] = [
  {
    detail: "Android Chrome에서 홈 화면 아이콘으로 실행한 리포트",
    errorTestId: "pwa-proof-errors",
    inputTestId: "pwa-proof-input",
    label: "Android",
    platform: "android",
    resultTestId: "pwa-proof-result-android",
  },
  {
    detail: "iPhone 또는 iPad Safari에서 홈 화면 아이콘으로 실행한 리포트",
    errorTestId: "pwa-proof-errors-ios",
    inputTestId: "pwa-proof-input-ios",
    label: "iOS",
    platform: "ios",
    resultTestId: "pwa-proof-result-ios",
  },
];

async function waitForViewportHeightSync(): Promise<void> {
  await new Promise<void>(resolve => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

function readDisplayModeState(): { evidence: string; mode: string } {
  if (typeof window === "undefined") return { evidence: "server", mode: "unknown" };

  const fullscreen = window.matchMedia("(display-mode: fullscreen)").matches;
  const standalone = window.matchMedia("(display-mode: standalone)").matches;
  const navigatorStandalone = "standalone" in window.navigator
    && Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);
  const mode = fullscreen ? "fullscreen" : standalone || navigatorStandalone ? "standalone" : "browser";

  return {
    evidence: [
      `css-fullscreen=${fullscreen ? "yes" : "no"}`,
      `css-standalone=${standalone ? "yes" : "no"}`,
      `ios-navigator-standalone=${navigatorStandalone ? "yes" : "no"}`,
    ].join(" · "),
    mode,
  };
}

function canUseStorage(readStorage: () => Storage): boolean {
  try {
    const storage = readStorage();
    const key = "__omr_pwa_check__";
    storage.setItem(key, "1");
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function isInstalledDisplay(displayMode: string): boolean {
  return displayMode === "standalone" || displayMode === "fullscreen";
}

function isLocalHandoffHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost"
    || normalized === "127.0.0.1"
    || normalized === "::1"
    || normalized.endsWith(".localhost");
}

function isDeviceReachableHttps(urlValue: string): boolean {
  try {
    const url = new URL(urlValue);
    return url.protocol === "https:" && !isLocalHandoffHost(url.hostname);
  } catch {
    return false;
  }
}

function proofPlatformLabel(platform: ProofPlatform): string {
  if (platform === "android") return "Android";
  if (platform === "ios") return "iOS";
  return "unknown";
}

function readProofPlatform(fields: ParsedProofReport["fields"]): ProofPlatform {
  const userAgent = fields.userAgent || "";
  const displayEvidence = fields.displayEvidence || "";

  if (/Android/i.test(userAgent)) return "android";
  if (/(iPhone|iPad|iPod)/i.test(userAgent) || /ios-navigator-standalone=yes/i.test(displayEvidence)) {
    return "ios";
  }
  return "unknown";
}

function readRootCssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function isPixelValue(value: string): boolean {
  return /^\d+px$/.test(value);
}

function readViewportHeightSummary(): { detail: string; tone: CheckTone; value: string } {
  const cssValue = readRootCssVar(VIEWPORT_HEIGHT_VAR);
  const visualViewportHeight = Math.round(window.visualViewport?.height || window.innerHeight);
  const innerHeight = Math.round(window.innerHeight);
  const cssPixels = Number.parseInt(cssValue, 10);
  const cssIsSyncedPixels = isPixelValue(cssValue);
  const delta = cssIsSyncedPixels ? Math.abs(cssPixels - visualViewportHeight) : Number.POSITIVE_INFINITY;
  const isSynced = cssIsSyncedPixels && delta <= 2;

  return {
    detail: `css=${cssValue || "missing"} · visual=${visualViewportHeight}px · inner=${innerHeight}px · delta=${Number.isFinite(delta) ? `${delta}px` : "n/a"}`,
    tone: isSynced ? "pass" : cssIsSyncedPixels ? "warn" : "fail",
    value: isSynced ? "동기화" : cssIsSyncedPixels ? "차이 있음" : "대기",
  };
}

function readKeyboardSafeAreaSummary(): { detail: string; tone: CheckTone; value: string } {
  const viewportWidth = readRootCssVar(VIEWPORT_WIDTH_VAR);
  const offsetTop = readRootCssVar(VIEWPORT_OFFSET_TOP_VAR);
  const offsetLeft = readRootCssVar(VIEWPORT_OFFSET_LEFT_VAR);
  const scale = readRootCssVar(VIEWPORT_SCALE_VAR);
  const keyboardInsetBottom = readRootCssVar(KEYBOARD_INSET_BOTTOM_VAR);
  const keyboardState = document.documentElement.getAttribute("data-app-keyboard") || "unknown";
  const scaleNumber = Number.parseFloat(scale);
  const isPrepared = [viewportWidth, offsetTop, offsetLeft, keyboardInsetBottom].every(isPixelValue)
    && Number.isFinite(scaleNumber)
    && (keyboardState === "open" || keyboardState === "closed");

  return {
    detail: `keyboard=${keyboardInsetBottom || "missing"} · state=${keyboardState} · width=${viewportWidth || "missing"} · offsetTop=${offsetTop || "missing"} · offsetLeft=${offsetLeft || "missing"} · scale=${scale || "missing"}`,
    tone: isPrepared ? "pass" : "fail",
    value: isPrepared ? "준비" : "대기",
  };
}

function checkSummary(checks: DeviceCheck[]): CheckSummary {
  return checks.reduce(
    (acc, check) => {
      if (check.tone === "pass") acc.passes += 1;
      if (check.tone === "warn") acc.warnings += 1;
      if (check.tone === "fail") acc.fails += 1;
      return acc;
    },
    { fails: 0, passes: 0, warnings: 0 },
  );
}

function deviceVerdict(snapshot: RuntimeSnapshot | null, summary: CheckSummary): { detail: string; label: string; tone: CheckTone } {
  if (!snapshot) return { detail: "기기 상태를 읽는 중", label: "검사 중", tone: "warn" };
  if (summary.fails > 0) return { detail: `${summary.fails}개 항목 조치 필요`, label: "조치 필요", tone: "fail" };
  if (!isInstalledDisplay(snapshot.displayMode)) {
    return {
      detail: "홈 화면 아이콘 실행 증거가 아직 없음",
      label: "설치 실행 전",
      tone: "warn",
    };
  }
  return {
    detail: `${summary.passes} 통과 · ${summary.warnings} 확인`,
    label: "앱 실행 통과",
    tone: "pass",
  };
}

function buildDeviceReport(snapshot: RuntimeSnapshot, summary: CheckSummary): string {
  const url = typeof location === "undefined" ? "" : location.href;
  const verdict = deviceVerdict(snapshot, summary);
  const installedDisplay = isInstalledDisplay(snapshot.displayMode);
  const checks = snapshot.checks
    .map(check => `- ${check.id}=${check.tone}:${check.value} (${check.detail})`)
    .join("\n");

  return [
    "OMR Maker PWA device check",
    `url=${url}`,
    `checkedAt=${snapshot.checkedAt}`,
    `verdict=${verdict.label}`,
    `displayMode=${snapshot.displayMode}`,
    `installedDisplay=${installedDisplay ? "yes" : "no"}`,
    `proofStatus=${installedDisplay ? "pass" : "pending"}`,
    `displayEvidence=${snapshot.displayModeEvidence}`,
    `summary=${summary.passes} pass, ${summary.warnings} warn, ${summary.fails} fail`,
    `userAgent=${snapshot.userAgent}`,
    checks,
  ].join("\n");
}

function parseProofReport(reportText: string): ParsedProofReport {
  const lines = reportText
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean);
  const fields: ParsedProofReport["fields"] = {};
  const checks: ParsedProofReport["checks"] = {};

  for (const line of lines.slice(1)) {
    if (line.startsWith("- ")) {
      const match = line.match(/^- ([^=]+)=([^:]+):([^(]+?)(?: \((.*)\))?$/);
      if (match) {
        checks[match[1]] = {
          detail: match[4] || "",
          tone: match[2],
          value: match[3].trim(),
        };
      }
      continue;
    }

    const separator = line.indexOf("=");
    if (separator > 0) {
      fields[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }

  return {
    checks,
    fields,
    header: lines[0] || "",
  };
}

function validateProofReport(reportText: string, expectedPlatform?: ProofTarget): ProofValidationResult {
  const parsed = parseProofReport(reportText);
  const errors: string[] = [];
  const platform = readProofPlatform(parsed.fields);

  if (parsed.header !== "OMR Maker PWA device check") {
    errors.push("Report header is not an OMR Maker PWA device check report.");
  }
  if (expectedPlatform && platform !== expectedPlatform) {
    errors.push(`Report must come from ${proofPlatformLabel(expectedPlatform)}, got ${proofPlatformLabel(platform)}.`);
  }
  if (!isDeviceReachableHttps(parsed.fields.url || "")) {
    errors.push("Report URL must be the deployed HTTPS URL, not localhost or an invalid URL.");
  }
  if (parsed.fields.verdict !== "앱 실행 통과") {
    errors.push("Report verdict is not 앱 실행 통과.");
  }
  if (!PROOF_INSTALLED_MODES.has(parsed.fields.displayMode || "")) {
    errors.push("displayMode must be standalone or fullscreen.");
  }
  if (parsed.fields.installedDisplay !== "yes") {
    errors.push("installedDisplay must be yes.");
  }
  if (parsed.fields.proofStatus !== "pass") {
    errors.push("proofStatus must be pass.");
  }
  if (!/0 fail/.test(parsed.fields.summary || "")) {
    errors.push("Report summary must include 0 fail.");
  }
  if (!/yes/.test(parsed.fields.displayEvidence || "")) {
    errors.push("displayEvidence must include at least one yes signal.");
  }

  for (const checkId of REQUIRED_PROOF_PASS_CHECKS) {
    const check = parsed.checks[checkId];
    if (!check) {
      errors.push(`Missing check: ${checkId}.`);
      continue;
    }
    if (check.tone !== "pass") {
      errors.push(`Check ${checkId} must be pass, got ${check.tone}:${check.value}.`);
    }
  }

  return {
    displayMode: parsed.fields.displayMode || "",
    errors,
    installedDisplay: parsed.fields.installedDisplay || "",
    platform,
    proofStatus: parsed.fields.proofStatus || "",
    status: errors.length === 0 ? "passed" : "failed",
    url: parsed.fields.url || "",
    userAgent: parsed.fields.userAgent || "",
    verdict: parsed.fields.verdict || "",
  };
}

function buildDualProofBundle(
  proofInputs: Record<ProofTarget, string>,
  proofResults: Record<ProofTarget, ProofValidationResult | null>,
): string {
  return [
    DUAL_PROOF_HEADER,
    `generatedAt=${new Date().toLocaleString("ko-KR", { hour12: false })}`,
    "status=passed",
    "requiredDevices=Android, iOS",
    `android=${proofResults.android?.platform || "missing"}:${proofResults.android?.displayMode || "missing"}:${proofResults.android?.proofStatus || "missing"}`,
    `ios=${proofResults.ios?.platform || "missing"}:${proofResults.ios?.displayMode || "missing"}:${proofResults.ios?.proofStatus || "missing"}`,
    "-----BEGIN ANDROID PWA REPORT-----",
    proofInputs.android.trim(),
    "-----END ANDROID PWA REPORT-----",
    "-----BEGIN IOS PWA REPORT-----",
    proofInputs.ios.trim(),
    "-----END IOS PWA REPORT-----",
  ].join("\n");
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some embedded browsers expose the Clipboard API but block writes.
      // Fall back to a focused textarea so real devices still have a path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.left = "-9999px";
  textarea.style.position = "fixed";
  document.body.appendChild(textarea);
  textarea.focus({ preventScroll: true });
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);
  if (!copied) throw new Error("Clipboard copy failed");
}

async function readManifestSummary(): Promise<{ detail: string; ok: boolean; value: string }> {
  const manifestHref = document.querySelector('link[rel="manifest"]')?.getAttribute("href");
  if (!manifestHref) return { detail: "manifest link 없음", ok: false, value: "없음" };

  try {
    const manifest = await fetch(manifestHref, { cache: "no-store" }).then(response => response.json());
    const hasStandalone = manifest.display === "standalone" || manifest.display_override?.includes("standalone");
    const hasIcons = Array.isArray(manifest.icons) && manifest.icons.some((icon: { sizes?: string }) => icon.sizes === "192x192")
      && manifest.icons.some((icon: { sizes?: string }) => icon.sizes === "512x512");
    const hasScreenshots = Array.isArray(manifest.screenshots) && manifest.screenshots.length >= 2;

    return {
      detail: `${manifest.short_name || manifest.name || "앱"} · icons ${manifest.icons?.length || 0} · screenshots ${manifest.screenshots?.length || 0}`,
      ok: hasStandalone && hasIcons && hasScreenshots,
      value: manifest.display || "unknown",
    };
  } catch {
    return { detail: "manifest fetch 실패", ok: false, value: manifestHref };
  }
}

async function readServiceWorkerSummary(): Promise<{ detail: string; tone: CheckTone; value: string }> {
  if (!("serviceWorker" in navigator)) {
    return { detail: "현재 브라우저가 service worker를 지원하지 않음", tone: "fail", value: "미지원" };
  }

  try {
    const registration = await navigator.serviceWorker.getRegistration("/sw.js");
    if (!registration) {
      return {
        detail: process.env.NODE_ENV === "production" ? "등록 없음" : "개발 서버에서는 production 등록 전",
        tone: process.env.NODE_ENV === "production" ? "fail" : "warn",
        value: "대기",
      };
    }

    return {
      detail: registration.active?.scriptURL || registration.waiting?.scriptURL || registration.installing?.scriptURL || "등록됨",
      tone: registration.active ? "pass" : "warn",
      value: navigator.serviceWorker.controller ? "제어 중" : "등록됨",
    };
  } catch {
    return { detail: "registration 조회 실패", tone: "fail", value: "오류" };
  }
}

async function readOfflineCacheSummary(): Promise<{ detail: string; tone: CheckTone; value: string }> {
  if (!("caches" in window)) {
    return { detail: "Cache Storage를 지원하지 않음", tone: "fail", value: "미지원" };
  }

  try {
    const [cacheKeys, matches] = await Promise.all([
      caches.keys(),
      Promise.all(OFFLINE_CACHE_REQUIRED_PATHS.map(path => caches.match(path))),
    ]);
    const missingPaths = OFFLINE_CACHE_REQUIRED_PATHS.filter((_, index) => !matches[index]);
    const omrCaches = cacheKeys.filter(key => key.startsWith("omr-maker-"));
    const detail = [
      `caches=${omrCaches.length ? omrCaches.join(", ") : "none"}`,
      `required=${OFFLINE_CACHE_REQUIRED_PATHS.join(", ")}`,
      `missing=${missingPaths.length ? missingPaths.join(", ") : "none"}`,
    ].join(" · ");

    return {
      detail,
      tone: missingPaths.length === 0 ? "pass" : "warn",
      value: missingPaths.length === 0 ? "준비" : "대기",
    };
  } catch {
    return { detail: "cache 조회 실패", tone: "warn", value: "확인 필요" };
  }
}

async function collectRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  await waitForViewportHeightSync();

  const displayModeState = readDisplayModeState();
  const displayMode = displayModeState.mode;
  const [manifest, serviceWorker, offlineCache] = await Promise.all([
    readManifestSummary(),
    readServiceWorkerSummary(),
    readOfflineCacheSummary(),
  ]);
  const viewportHeight = readViewportHeightSummary();
  const keyboardSafeArea = readKeyboardSafeAreaSummary();
  const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  const androidCapable = [...document.querySelectorAll('meta[name="mobile-web-app-capable"]')]
    .some(meta => meta.getAttribute("content") === "yes");
  const appleCapable = [...document.querySelectorAll('meta[name="apple-mobile-web-app-capable"]')]
    .some(meta => meta.getAttribute("content") === "yes");
  const hasHorizontalOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  const promptCount = document.querySelectorAll(".mobile-install-prompt").length;
  const localStorageOk = canUseStorage(() => window.localStorage);
  const sessionStorageOk = canUseStorage(() => window.sessionStorage);
  const isLocalHandoff = isLocalHandoffHost(location.hostname);
  const hasDeviceReachableHandoff = location.protocol === "https:" && !isLocalHandoff;

  return {
    checkedAt: new Date().toLocaleString("ko-KR", { hour12: false }),
    displayMode,
    displayModeEvidence: displayModeState.evidence,
    userAgent: navigator.userAgent,
    checks: [
      {
        detail: `${location.protocol}//${location.host}`,
        id: "secure-context",
        label: "HTTPS",
        tone: window.isSecureContext ? "pass" : "fail",
        value: window.isSecureContext ? "보안 컨텍스트" : "차단",
      },
      {
        detail: displayMode === "browser" ? "홈 화면 아이콘 실행 전" : "홈 화면 아이콘 실행 상태",
        id: "display-mode",
        label: "실행 모드",
        tone: displayMode === "browser" ? "warn" : "pass",
        value: displayMode,
      },
      {
        detail: displayModeState.evidence,
        id: "launch-proof",
        label: "앱 아이콘 실행 증거",
        tone: isInstalledDisplay(displayMode) ? "pass" : "warn",
        value: isInstalledDisplay(displayMode) ? "확인됨" : "대기",
      },
      {
        detail: serviceWorker.detail,
        id: "service-worker",
        label: "서비스워커",
        tone: serviceWorker.tone,
        value: serviceWorker.value,
      },
      {
        detail: offlineCache.detail,
        id: "offline-cache",
        label: "오프라인 캐시",
        tone: offlineCache.tone,
        value: offlineCache.value,
      },
      {
        detail: manifest.detail,
        id: "manifest",
        label: "Manifest",
        tone: manifest.ok ? "pass" : "fail",
        value: manifest.value,
      },
      {
        detail: viewport || "viewport meta 없음",
        id: "viewport",
        label: "Viewport",
        tone: viewport.includes("viewport-fit=cover") ? "pass" : "fail",
        value: viewport.includes("viewport-fit=cover") ? "cover" : "확인 필요",
      },
      {
        detail: viewportHeight.detail,
        id: "viewport-height",
        label: "화면 높이",
        tone: viewportHeight.tone,
        value: viewportHeight.value,
      },
      {
        detail: keyboardSafeArea.detail,
        id: "keyboard-safe-area",
        label: "키보드 여백",
        tone: keyboardSafeArea.tone,
        value: keyboardSafeArea.value,
      },
      {
        detail: `Android ${androidCapable ? "yes" : "no"} · iOS ${appleCapable ? "yes" : "no"}`,
        id: "mobile-meta",
        label: "모바일 메타",
        tone: androidCapable && appleCapable ? "pass" : "fail",
        value: androidCapable && appleCapable ? "준비" : "누락",
      },
      {
        detail: hasDeviceReachableHandoff
          ? `${location.origin}/pwa-check`
          : `${location.origin} · 실제 Android/iPhone에서는 배포 HTTPS 링크로 열어야 함`,
        id: "handoff-origin",
        label: "실기기 링크",
        tone: hasDeviceReachableHandoff ? "pass" : "warn",
        value: hasDeviceReachableHandoff ? "공유 가능" : "로컬 전용",
      },
      {
        detail: `scroll ${document.documentElement.scrollWidth}px / viewport ${document.documentElement.clientWidth}px`,
        id: "overflow",
        label: "가로폭",
        tone: hasHorizontalOverflow ? "fail" : "pass",
        value: hasHorizontalOverflow ? "넘침" : "정상",
      },
      {
        detail: `localStorage ${localStorageOk ? "ok" : "blocked"} · sessionStorage ${sessionStorageOk ? "ok" : "blocked"}`,
        id: "storage",
        label: "저장소",
        tone: localStorageOk && sessionStorageOk ? "pass" : "warn",
        value: localStorageOk && sessionStorageOk ? "사용 가능" : "제한됨",
      },
      {
        detail: promptCount === 0 ? "진단 화면에는 설치 배너 없음" : `${promptCount}개 감지`,
        id: "install-prompt",
        label: "설치 배너",
        tone: promptCount === 0 ? "pass" : "warn",
        value: promptCount === 0 ? "없음" : "표시 중",
      },
    ],
  };
}

function CheckRow({ check }: { check: DeviceCheck }) {
  const meta = CHECK_TONE_META[check.tone];
  const Icon = meta.icon;

  return (
    <article
      data-testid={`pwa-device-check-${check.id}`}
      style={{
        alignItems: "center",
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "8px",
        display: "grid",
        gap: "0.8rem",
        gridTemplateColumns: "auto minmax(0, 1fr) auto",
        padding: "0.95rem",
      }}
    >
      <span
        aria-label={meta.label}
        style={{
          alignItems: "center",
          background: meta.background,
          borderRadius: "8px",
          color: meta.color,
          display: "inline-flex",
          height: "2.5rem",
          justifyContent: "center",
          width: "2.5rem",
        }}
      >
        <Icon size={18} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: "var(--foreground)", fontSize: "0.93rem", fontWeight: 850 }}>{check.label}</div>
        <div style={{ color: "var(--muted)", fontSize: "0.78rem", lineHeight: 1.35, overflowWrap: "anywhere" }}>{check.detail}</div>
      </div>
      <strong style={{ color: meta.color, fontSize: "0.78rem", whiteSpace: "nowrap" }}>{check.value}</strong>
    </article>
  );
}

export default function PwaCheckPage() {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const [isChecking, setIsChecking] = useState(true);
  const [copyState, setCopyState] = useState<"copied" | "failed" | "idle" | "shared">("idle");
  const [handoffState, setHandoffState] = useState<"copied" | "failed" | "idle" | "shared">("idle");
  const [handoffUrl, setHandoffUrl] = useState("");
  const [proofBundleState, setProofBundleState] = useState<ProofBundleState>("idle");
  const [proofInputs, setProofInputs] = useState<Record<ProofTarget, string>>({ android: "", ios: "" });

  const runCheck = useCallback(async () => {
    setIsChecking(true);
    const next = await collectRuntimeSnapshot();
    setSnapshot(next);
    setIsChecking(false);
  }, []);

  useEffect(() => {
    let isCancelled = false;
    const currentUrl = location.href;

    collectRuntimeSnapshot().then(next => {
      if (isCancelled) return;
      setHandoffUrl(currentUrl);
      setSnapshot(next);
      setIsChecking(false);
    });

    return () => {
      isCancelled = true;
    };
  }, []);

  useEffect(() => {
    if (copyState === "idle") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  useEffect(() => {
    if (handoffState === "idle") return;
    const timeout = window.setTimeout(() => setHandoffState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [handoffState]);

  useEffect(() => {
    if (proofBundleState === "idle") return;
    const timeout = window.setTimeout(() => setProofBundleState("idle"), 2200);
    return () => window.clearTimeout(timeout);
  }, [proofBundleState]);

  const summary = useMemo(() => snapshot ? checkSummary(snapshot.checks) : { fails: 0, passes: 0, warnings: 0 }, [snapshot]);
  const verdict = useMemo(() => deviceVerdict(snapshot, summary), [snapshot, summary]);
  const reportText = useMemo(() => snapshot ? buildDeviceReport(snapshot, summary) : "", [snapshot, summary]);
  const proofResults = useMemo(() => ({
    android: proofInputs.android.trim() ? validateProofReport(proofInputs.android, "android") : null,
    ios: proofInputs.ios.trim() ? validateProofReport(proofInputs.ios, "ios") : null,
  }), [proofInputs]);
  const proofEnteredCount = PROOF_TARGETS.filter(target => proofInputs[target.platform].trim()).length;
  const proofPassedCount = PROOF_TARGETS.filter(target => proofResults[target.platform]?.status === "passed").length;
  const proofFailedCount = PROOF_TARGETS.filter(target => proofResults[target.platform]?.status === "failed").length;
  const verdictMeta = CHECK_TONE_META[verdict.tone];
  const VerdictIcon = verdictMeta.icon;
  const proofTone: CheckTone = proofPassedCount === PROOF_TARGETS.length ? "pass" : proofFailedCount > 0 ? "fail" : "warn";
  const proofMeta = CHECK_TONE_META[proofTone];
  const ProofIcon = proofMeta.icon;
  const proofOverallLabel = proofPassedCount === PROOF_TARGETS.length
    ? "Android/iOS 리포트 통과"
    : proofEnteredCount === 0
      ? "Android/iOS 리포트 대기"
      : proofFailedCount > 0
        ? "Android/iOS 리포트 미통과"
        : "Android/iOS 리포트 미완료";
  const proofOverallDetail = `${proofPassedCount}/${PROOF_TARGETS.length} 통과 · ${proofFailedCount} 미통과`;
  const dualProofBundle = useMemo(() => (
    proofPassedCount === PROOF_TARGETS.length ? buildDualProofBundle(proofInputs, proofResults) : ""
  ), [proofInputs, proofPassedCount, proofResults]);

  const copyReport = useCallback(async () => {
    if (!reportText) return;
    try {
      await copyText(reportText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [reportText]);

  const shareReport = useCallback(async () => {
    if (!reportText) return;
    if (!navigator.share) {
      await copyReport();
      return;
    }

    try {
      await navigator.share({
        text: reportText,
        title: "OMR Maker PWA device check",
        url: location.href,
      });
      setCopyState("shared");
    } catch {
      setCopyState("idle");
    }
  }, [copyReport, reportText]);

  const copyHandoffUrl = useCallback(async () => {
    if (!handoffUrl) return;
    try {
      await copyText(handoffUrl);
      setHandoffState("copied");
    } catch {
      setHandoffState("failed");
    }
  }, [handoffUrl]);

  const shareHandoffUrl = useCallback(async () => {
    if (!handoffUrl) return;
    if (!navigator.share) {
      await copyHandoffUrl();
      return;
    }

    try {
      await navigator.share({
        text: "OMR Maker PWA 디바이스 체크",
        title: "OMR Maker",
        url: handoffUrl,
      });
      setHandoffState("shared");
    } catch {
      setHandoffState("idle");
    }
  }, [copyHandoffUrl, handoffUrl]);

  const copyDualProofBundle = useCallback(async () => {
    if (!dualProofBundle) return;
    try {
      await copyText(dualProofBundle);
      setProofBundleState("copied");
    } catch {
      setProofBundleState("failed");
    }
  }, [dualProofBundle]);

  const shareDualProofBundle = useCallback(async () => {
    if (!dualProofBundle) return;
    if (!navigator.share) {
      await copyDualProofBundle();
      return;
    }

    try {
      await navigator.share({
        text: dualProofBundle,
        title: "OMR Maker PWA dual device proof",
        url: location.href,
      });
      setProofBundleState("shared");
    } catch {
      setProofBundleState("idle");
    }
  }, [copyDualProofBundle, dualProofBundle]);

  return (
    <main className="layout-main pwa-check-page" style={{ background: "var(--background)" }}>
      <div className="container" style={{ maxWidth: 760, paddingBottom: "2rem", paddingTop: "max(1.25rem, env(safe-area-inset-top))" }}>
        <section
          style={{
            display: "grid",
            gap: "1rem",
            margin: "0 auto",
            minHeight: "calc(var(--app-viewport-height, 100dvh) - 3.5rem)",
            padding: "1rem 0",
          }}
        >
          <header style={{ display: "grid", gap: "0.9rem" }}>
            <Link
              href="/"
              style={{
                alignItems: "center",
                color: "var(--muted)",
                display: "inline-flex",
                fontSize: "0.85rem",
                fontWeight: 750,
                gap: "0.35rem",
                justifySelf: "start",
                minHeight: "2.75rem",
                minWidth: "2.75rem",
                padding: "0 0.25rem",
              }}
            >
              <ExternalLink size={15} />
              홈
            </Link>
            <div
              style={{
                alignItems: "center",
                display: "grid",
                gap: "1rem",
                gridTemplateColumns: "auto minmax(0, 1fr)",
              }}
            >
              <span
                style={{
                  alignItems: "center",
                  background: "color-mix(in srgb, var(--primary), transparent 88%)",
                  borderRadius: "8px",
                  color: "var(--primary)",
                  display: "inline-flex",
                  height: "3.25rem",
                  justifyContent: "center",
                  width: "3.25rem",
                }}
              >
                <Smartphone size={25} />
              </span>
              <div style={{ minWidth: 0 }}>
                <h1 style={{ color: "var(--foreground)", fontSize: "1.55rem", fontWeight: 950, letterSpacing: 0, lineHeight: 1.12 }}>
                  PWA 디바이스 체크
                </h1>
                <p style={{ color: "var(--muted)", fontSize: "0.88rem", lineHeight: 1.45, marginTop: "0.3rem" }}>
                  {snapshot ? `${summary.passes} 통과 · ${summary.warnings} 확인 · ${summary.fails} 조치` : "검사 중"}
                </p>
              </div>
            </div>
          </header>

          <section
            aria-label="PWA 실행 상태"
            data-testid="pwa-device-verdict"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              display: "grid",
              gap: "0.75rem",
              padding: "1rem",
            }}
          >
            <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.65rem", justifyContent: "space-between" }}>
              <div style={{ alignItems: "center", display: "flex", gap: "0.7rem", minWidth: 0 }}>
                <span
                  aria-label={verdictMeta.label}
                  style={{
                    alignItems: "center",
                    background: verdictMeta.background,
                    borderRadius: "8px",
                    color: verdictMeta.color,
                    display: "inline-flex",
                    flex: "0 0 auto",
                    height: "2.5rem",
                    justifyContent: "center",
                    width: "2.5rem",
                  }}
                >
                  <VerdictIcon size={18} />
                </span>
                <div style={{ minWidth: 0 }}>
                  <strong style={{ color: "var(--foreground)", display: "block", fontSize: "0.95rem" }}>
                    {verdict.label}
                  </strong>
                  <span style={{ color: "var(--muted)", display: "block", fontSize: "0.75rem", overflowWrap: "anywhere" }}>
                    {verdict.detail}
                  </span>
                </div>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  onClick={copyReport}
                  disabled={!snapshot}
                  data-testid="pwa-device-report-copy"
                  style={{
                    alignItems: "center",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    color: "var(--foreground)",
                    display: "inline-flex",
                    fontSize: "0.8rem",
                    fontWeight: 850,
                    gap: "0.35rem",
                    minHeight: "2.75rem",
                    opacity: snapshot ? 1 : 0.55,
                    padding: "0 0.85rem",
                  }}
                >
                  {copyState === "copied" ? <Check size={15} /> : <Clipboard size={15} />}
                  복사
                </button>
                <button
                  type="button"
                  onClick={shareReport}
                  disabled={!snapshot}
                  data-testid="pwa-device-report-share"
                  style={{
                    alignItems: "center",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    color: "var(--foreground)",
                    display: "inline-flex",
                    fontSize: "0.8rem",
                    fontWeight: 850,
                    gap: "0.35rem",
                    minHeight: "2.75rem",
                    opacity: snapshot ? 1 : 0.55,
                    padding: "0 0.85rem",
                  }}
                >
                  {copyState === "shared" ? <Check size={15} /> : <Share2 size={15} />}
                  공유
                </button>
                <button
                  type="button"
                  onClick={runCheck}
                  style={{
                    alignItems: "center",
                    background: "var(--foreground)",
                    borderRadius: "8px",
                    color: "var(--surface)",
                    display: "inline-flex",
                    fontSize: "0.8rem",
                    fontWeight: 850,
                    gap: "0.35rem",
                    minHeight: "2.75rem",
                    padding: "0 0.85rem",
                  }}
                >
                  {isChecking ? <Activity size={15} /> : <RefreshCcw size={15} />}
                  검사
                </button>
              </div>
            </div>
            <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.65rem", justifyContent: "space-between" }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ color: "var(--foreground)", display: "block", fontSize: "0.95rem" }}>
                  {snapshot?.displayMode || "checking"}
                </strong>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.75rem", overflowWrap: "anywhere" }}>
                  {snapshot?.checkedAt || "잠시만요"}
                </span>
              </div>
              <span
                aria-live="polite"
                data-testid="pwa-device-copy-status"
                style={{ color: copyState === "failed" ? "var(--warning)" : "var(--success)", fontSize: "0.75rem", fontWeight: 850, minWidth: "4rem", textAlign: "right" }}
              >
                {copyState === "copied" ? "복사됨" : copyState === "shared" ? "공유됨" : copyState === "failed" ? "직접 복사" : ""}
              </span>
            </div>
            <div style={{ color: "var(--muted)", fontSize: "0.72rem", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {snapshot?.userAgent || "user agent"}
            </div>
            <pre
              aria-label="PWA 진단 보고서"
              data-testid="pwa-device-report"
              style={{
                background: "var(--background)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                color: "var(--muted)",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: "0.68rem",
                lineHeight: 1.45,
                margin: 0,
                maxHeight: "9rem",
                overflow: "auto",
                padding: "0.8rem",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
              }}
            >
              {reportText || "검사 결과 준비 중"}
            </pre>
          </section>

          <section
            aria-label="실기기 설치 확인"
            data-testid="pwa-install-proof-guide"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              display: "grid",
              gap: "0.85rem",
              padding: "1rem",
            }}
          >
            <div style={{ display: "grid", gap: "0.3rem" }}>
              <strong style={{ color: "var(--foreground)", fontSize: "0.98rem", fontWeight: 900 }}>
                실기기 설치 확인
              </strong>
              <span style={{ color: "var(--muted)", fontSize: "0.78rem", lineHeight: 1.4 }}>
                Android와 iOS 모두 마지막 단계에서 displayMode가 standalone 또는 fullscreen이면 통과입니다.
              </span>
            </div>
            <div style={{ display: "grid", gap: "0.55rem" }}>
              {INSTALL_PROOF_STEPS.map((step, index) => (
                <div
                  key={step.label}
                  data-testid={`pwa-install-proof-step-${index + 1}`}
                  style={{
                    alignItems: "center",
                    background: "var(--background)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    display: "grid",
                    gap: "0.7rem",
                    gridTemplateColumns: "auto minmax(0, 1fr)",
                    minHeight: "3.25rem",
                    padding: "0.7rem",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      alignItems: "center",
                      background: "color-mix(in srgb, var(--primary), transparent 88%)",
                      borderRadius: "8px",
                      color: "var(--primary)",
                      display: "inline-flex",
                      fontSize: "0.78rem",
                      fontWeight: 950,
                      height: "2rem",
                      justifyContent: "center",
                      width: "2rem",
                    }}
                  >
                    {index + 1}
                  </span>
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ color: "var(--foreground)", display: "block", fontSize: "0.84rem", fontWeight: 900 }}>
                      {step.label}
                    </strong>
                    <span style={{ color: "var(--muted)", display: "block", fontSize: "0.74rem", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                      {step.detail}
                    </span>
                  </span>
                </div>
              ))}
            </div>
            <div style={{ display: "grid", gap: "0.55rem", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
              <div
                data-testid="pwa-install-proof-android"
                style={{
                  background: "rgba(16, 185, 129, 0.08)",
                  border: "1px solid rgba(16, 185, 129, 0.18)",
                  borderRadius: "8px",
                  color: "var(--foreground)",
                  minHeight: "3.25rem",
                  padding: "0.75rem",
                }}
              >
                <strong style={{ display: "block", fontSize: "0.8rem", fontWeight: 900 }}>Android</strong>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.72rem", lineHeight: 1.35 }}>
                  Chrome 설치 버튼 또는 메뉴의 앱 설치
                </span>
              </div>
              <div
                data-testid="pwa-install-proof-ios"
                style={{
                  background: "rgba(99, 102, 241, 0.08)",
                  border: "1px solid rgba(99, 102, 241, 0.18)",
                  borderRadius: "8px",
                  color: "var(--foreground)",
                  minHeight: "3.25rem",
                  padding: "0.75rem",
                }}
              >
                <strong style={{ display: "block", fontSize: "0.8rem", fontWeight: 900 }}>iOS</strong>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.72rem", lineHeight: 1.35 }}>
                  Safari 공유 메뉴에서 홈 화면에 추가
                </span>
              </div>
            </div>
          </section>

          <section
            aria-label="기기 전달"
            data-testid="pwa-device-handoff"
            style={{
              alignItems: "center",
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              display: "grid",
              gap: "1rem",
              gridTemplateColumns: "auto minmax(0, 1fr)",
              padding: "1rem",
            }}
          >
            <div
              style={{
                alignItems: "center",
                background: "white",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                display: "inline-flex",
                height: "9rem",
                justifyContent: "center",
                padding: "0.55rem",
                width: "9rem",
              }}
            >
              {handoffUrl ? (
                <QRCodeCanvas
                  data-testid="pwa-device-handoff-qr"
                  value={handoffUrl}
                  size={116}
                  level="H"
                  includeMargin
                />
              ) : (
                <Smartphone size={28} />
              )}
            </div>
            <div style={{ display: "grid", gap: "0.7rem", minWidth: 0 }}>
              <div style={{ minWidth: 0 }}>
                <strong style={{ color: "var(--foreground)", display: "block", fontSize: "0.95rem" }}>
                  폰으로 열기
                </strong>
                <span
                  data-testid="pwa-device-handoff-url"
                  style={{ color: "var(--muted)", display: "block", fontSize: "0.75rem", overflowWrap: "anywhere", userSelect: "text" }}
                >
                  {handoffUrl || "URL 준비 중"}
                </span>
              </div>
              <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={copyHandoffUrl}
                  disabled={!handoffUrl}
                  data-testid="pwa-device-handoff-copy"
                  style={{
                    alignItems: "center",
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    color: "var(--foreground)",
                    display: "inline-flex",
                    fontSize: "0.8rem",
                    fontWeight: 850,
                    gap: "0.35rem",
                    minHeight: "2.75rem",
                    opacity: handoffUrl ? 1 : 0.55,
                    padding: "0 0.85rem",
                  }}
                >
                  {handoffState === "copied" ? <Check size={15} /> : <Clipboard size={15} />}
                  링크 복사
                </button>
                <button
                  type="button"
                  onClick={shareHandoffUrl}
                  disabled={!handoffUrl}
                  data-testid="pwa-device-handoff-share"
                  style={{
                    alignItems: "center",
                    background: "var(--foreground)",
                    borderRadius: "8px",
                    color: "var(--surface)",
                    display: "inline-flex",
                    fontSize: "0.8rem",
                    fontWeight: 850,
                    gap: "0.35rem",
                    minHeight: "2.75rem",
                    opacity: handoffUrl ? 1 : 0.55,
                    padding: "0 0.85rem",
                  }}
                >
                  <Share2 size={15} />
                  공유
                </button>
                <span
                  aria-live="polite"
                  data-testid="pwa-device-handoff-status"
                  style={{ color: handoffState === "failed" ? "var(--warning)" : "var(--success)", fontSize: "0.75rem", fontWeight: 850 }}
                >
                  {handoffState === "copied" ? "복사됨" : handoffState === "shared" ? "공유됨" : handoffState === "failed" ? "직접 복사" : ""}
                </span>
              </div>
            </div>
          </section>

          <section
            aria-label="실기기 리포트 판정"
            data-testid="pwa-proof-verifier"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "8px",
              display: "grid",
              gap: "0.85rem",
              padding: "1rem",
            }}
          >
            <div style={{ alignItems: "center", display: "grid", gap: "0.75rem", gridTemplateColumns: "auto minmax(0, 1fr)" }}>
              <span
                aria-label={proofMeta.label}
                style={{
                  alignItems: "center",
                  background: proofMeta.background,
                  borderRadius: "8px",
                  color: proofMeta.color,
                  display: "inline-flex",
                  height: "2.5rem",
                  justifyContent: "center",
                  width: "2.5rem",
                }}
              >
                <ProofIcon size={18} />
              </span>
              <div style={{ minWidth: 0 }}>
                <strong
                  data-testid="pwa-proof-result"
                  style={{ color: "var(--foreground)", display: "block", fontSize: "0.95rem", fontWeight: 900 }}
                >
                  {proofOverallLabel}
                </strong>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.75rem", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                  {proofEnteredCount ? proofOverallDetail : "Android와 iOS 리포트를 각각 붙여넣습니다."}
                </span>
              </div>
            </div>
            <div style={{ display: "grid", gap: "0.75rem", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))" }}>
              {PROOF_TARGETS.map(target => {
                const proofInput = proofInputs[target.platform];
                const result = proofResults[target.platform];
                const slotTone: CheckTone = result ? result.status === "passed" ? "pass" : "fail" : "warn";
                const slotMeta = CHECK_TONE_META[slotTone];

                return (
                  <article
                    key={target.platform}
                    data-testid={`pwa-proof-slot-${target.platform}`}
                    style={{
                      background: "var(--background)",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      display: "grid",
                      gap: "0.65rem",
                      padding: "0.8rem",
                    }}
                  >
                    <div style={{ alignItems: "start", display: "grid", gap: "0.5rem", gridTemplateColumns: "auto minmax(0, 1fr)" }}>
                      <span
                        aria-label={slotMeta.label}
                        style={{
                          background: slotMeta.background,
                          borderRadius: "8px",
                          color: slotMeta.color,
                          display: "inline-flex",
                          height: "0.9rem",
                          marginTop: "0.2rem",
                          width: "0.9rem",
                        }}
                      />
                      <span style={{ minWidth: 0 }}>
                        <strong
                          data-testid={target.resultTestId}
                          style={{ color: "var(--foreground)", display: "block", fontSize: "0.84rem", fontWeight: 900 }}
                        >
                          {target.label} {result ? result.status === "passed" ? "리포트 통과" : "리포트 미통과" : "리포트 대기"}
                        </strong>
                        <span style={{ color: "var(--muted)", display: "block", fontSize: "0.72rem", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                          {result
                            ? `${proofPlatformLabel(result.platform)} · ${result.displayMode || "unknown"} · installed=${result.installedDisplay || "missing"}`
                            : target.detail}
                        </span>
                      </span>
                    </div>
                    <textarea
                      aria-label={`${target.label} 실기기 리포트 입력`}
                      data-testid={target.inputTestId}
                      onChange={event => setProofInputs(current => ({ ...current, [target.platform]: event.target.value }))}
                      placeholder="OMR Maker PWA device check"
                      value={proofInput}
                      style={{
                        background: "var(--surface)",
                        border: "1px solid var(--border)",
                        borderRadius: "8px",
                        color: "var(--foreground)",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        fontSize: "0.72rem",
                        lineHeight: 1.45,
                        minHeight: "7rem",
                        padding: "0.75rem",
                        resize: "vertical",
                        width: "100%",
                      }}
                    />
                    {result?.url ? (
                      <div
                        data-testid={target.platform === "android" ? "pwa-proof-url" : "pwa-proof-url-ios"}
                        style={{ color: "var(--muted)", fontSize: "0.7rem", lineHeight: 1.35, overflowWrap: "anywhere" }}
                      >
                        {result.url}
                      </div>
                    ) : null}
                    {result?.errors.length ? (
                      <ul
                        data-testid={target.errorTestId}
                        style={{
                          color: "var(--error)",
                          display: "grid",
                          fontSize: "0.7rem",
                          gap: "0.35rem",
                          lineHeight: 1.35,
                          margin: 0,
                          paddingLeft: "1rem",
                        }}
                      >
                        {result.errors.slice(0, 5).map(error => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    ) : result?.status === "passed" ? (
                      <div
                        data-testid={target.errorTestId}
                        style={{ color: "var(--success)", fontSize: "0.72rem", fontWeight: 850 }}
                      >
                        installed home-screen launch verified
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
            {dualProofBundle ? (
              <section
                aria-label="통합 실기기 증거"
                data-testid="pwa-proof-bundle"
                style={{
                  background: "var(--background)",
                  border: "1px solid var(--border)",
                  borderRadius: "8px",
                  display: "grid",
                  gap: "0.7rem",
                  padding: "0.85rem",
                }}
              >
                <div style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: "0.65rem", justifyContent: "space-between" }}>
                  <span style={{ minWidth: 0 }}>
                    <strong style={{ color: "var(--foreground)", display: "block", fontSize: "0.86rem", fontWeight: 900 }}>
                      Android/iOS 통합 proof
                    </strong>
                    <span style={{ color: "var(--muted)", display: "block", fontSize: "0.72rem", lineHeight: 1.35 }}>
                      이 묶음은 npm run pwa:proof 로 재검증할 수 있습니다.
                    </span>
                  </span>
                  <span
                    aria-live="polite"
                    data-testid="pwa-proof-bundle-status"
                    style={{ color: proofBundleState === "failed" ? "var(--warning)" : "var(--success)", fontSize: "0.72rem", fontWeight: 850 }}
                  >
                    {proofBundleState === "copied" ? "복사됨" : proofBundleState === "shared" ? "공유됨" : proofBundleState === "failed" ? "직접 복사" : ""}
                  </span>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
                  <button
                    type="button"
                    onClick={copyDualProofBundle}
                    data-testid="pwa-proof-bundle-copy"
                    style={{
                      alignItems: "center",
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: "8px",
                      color: "var(--foreground)",
                      display: "inline-flex",
                      fontSize: "0.8rem",
                      fontWeight: 850,
                      gap: "0.35rem",
                      minHeight: "2.75rem",
                      padding: "0 0.85rem",
                    }}
                  >
                    {proofBundleState === "copied" ? <Check size={15} /> : <Clipboard size={15} />}
                    묶음 복사
                  </button>
                  <button
                    type="button"
                    onClick={shareDualProofBundle}
                    data-testid="pwa-proof-bundle-share"
                    style={{
                      alignItems: "center",
                      background: "var(--foreground)",
                      borderRadius: "8px",
                      color: "var(--surface)",
                      display: "inline-flex",
                      fontSize: "0.8rem",
                      fontWeight: 850,
                      gap: "0.35rem",
                      minHeight: "2.75rem",
                      padding: "0 0.85rem",
                    }}
                  >
                    <Share2 size={15} />
                    공유
                  </button>
                </div>
                <pre
                  data-testid="pwa-proof-bundle-report"
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    color: "var(--muted)",
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                    fontSize: "0.68rem",
                    lineHeight: 1.45,
                    margin: 0,
                    maxHeight: "7rem",
                    overflow: "auto",
                    padding: "0.75rem",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {dualProofBundle}
                </pre>
              </section>
            ) : null}
          </section>

          <section aria-label="PWA 체크 목록" style={{ display: "grid", gap: "0.7rem" }}>
            {snapshot
              ? snapshot.checks.map(check => <CheckRow key={check.id} check={check} />)
              : Array.from({ length: 5 }, (_, index) => (
                <article
                  key={index}
                  style={{
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    borderRadius: "8px",
                    minHeight: "4.5rem",
                    opacity: 0.55,
                  }}
                />
              ))}
          </section>

          <footer style={{ display: "grid", gap: "0.7rem", gridTemplateColumns: "repeat(2, minmax(0, 1fr))" }}>
            <Link
              href="/?role=student"
              style={{
                alignItems: "center",
                background: "var(--primary)",
                borderRadius: "8px",
                color: "white",
                display: "inline-flex",
                fontSize: "0.86rem",
                fontWeight: 900,
                justifyContent: "center",
                minHeight: "2.9rem",
                padding: "0 0.85rem",
              }}
            >
              학생 시작
            </Link>
            <Link
              href="/create"
              style={{
                alignItems: "center",
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "8px",
                color: "var(--foreground)",
                display: "inline-flex",
                fontSize: "0.86rem",
                fontWeight: 900,
                justifyContent: "center",
                minHeight: "2.9rem",
                padding: "0 0.85rem",
              }}
            >
              출제 화면
            </Link>
          </footer>
        </section>
      </div>
    </main>
  );
}
