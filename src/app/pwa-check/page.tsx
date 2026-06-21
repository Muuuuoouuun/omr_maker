"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle, Check, CheckCircle2, Clipboard, ExternalLink, RefreshCcw, Share2, Smartphone } from "lucide-react";
import { QRCodeCanvas } from "qrcode.react";

type CheckTone = "pass" | "warn" | "fail";

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

const CHECK_TONE_META: Record<CheckTone, { background: string; color: string; icon: typeof CheckCircle2; label: string }> = {
  pass: { background: "rgba(16, 185, 129, 0.1)", color: "var(--success)", icon: CheckCircle2, label: "통과" },
  warn: { background: "rgba(245, 158, 11, 0.12)", color: "var(--warning)", icon: AlertTriangle, label: "확인" },
  fail: { background: "rgba(239, 68, 68, 0.1)", color: "var(--error)", icon: AlertTriangle, label: "조치" },
};

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
  const checks = snapshot.checks
    .map(check => `- ${check.id}=${check.tone}:${check.value} (${check.detail})`)
    .join("\n");

  return [
    "OMR Maker PWA device check",
    `url=${url}`,
    `checkedAt=${snapshot.checkedAt}`,
    `verdict=${verdict.label}`,
    `displayMode=${snapshot.displayMode}`,
    `displayEvidence=${snapshot.displayModeEvidence}`,
    `summary=${summary.passes} pass, ${summary.warnings} warn, ${summary.fails} fail`,
    `userAgent=${snapshot.userAgent}`,
    checks,
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

async function collectRuntimeSnapshot(): Promise<RuntimeSnapshot> {
  const displayModeState = readDisplayModeState();
  const displayMode = displayModeState.mode;
  const manifest = await readManifestSummary();
  const serviceWorker = await readServiceWorkerSummary();
  const viewport = document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "";
  const androidCapable = [...document.querySelectorAll('meta[name="mobile-web-app-capable"]')]
    .some(meta => meta.getAttribute("content") === "yes");
  const appleCapable = [...document.querySelectorAll('meta[name="apple-mobile-web-app-capable"]')]
    .some(meta => meta.getAttribute("content") === "yes");
  const hasHorizontalOverflow = document.documentElement.scrollWidth > document.documentElement.clientWidth;
  const promptCount = document.querySelectorAll(".mobile-install-prompt").length;
  const localStorageOk = canUseStorage(() => window.localStorage);
  const sessionStorageOk = canUseStorage(() => window.sessionStorage);

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
        detail: `Android ${androidCapable ? "yes" : "no"} · iOS ${appleCapable ? "yes" : "no"}`,
        id: "mobile-meta",
        label: "모바일 메타",
        tone: androidCapable && appleCapable ? "pass" : "fail",
        value: androidCapable && appleCapable ? "준비" : "누락",
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
  const [copyState, setCopyState] = useState<"copied" | "failed" | "idle">("idle");
  const [handoffState, setHandoffState] = useState<"copied" | "failed" | "idle" | "shared">("idle");
  const [handoffUrl, setHandoffUrl] = useState("");

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

  const summary = useMemo(() => snapshot ? checkSummary(snapshot.checks) : { fails: 0, passes: 0, warnings: 0 }, [snapshot]);
  const verdict = useMemo(() => deviceVerdict(snapshot, summary), [snapshot, summary]);
  const reportText = useMemo(() => snapshot ? buildDeviceReport(snapshot, summary) : "", [snapshot, summary]);
  const verdictMeta = CHECK_TONE_META[verdict.tone];
  const VerdictIcon = verdictMeta.icon;

  const copyReport = useCallback(async () => {
    if (!reportText) return;
    try {
      await copyText(reportText);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [reportText]);

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

  return (
    <main className="layout-main pwa-check-page" style={{ background: "var(--background)" }}>
      <div className="container" style={{ maxWidth: 760, paddingBottom: "2rem", paddingTop: "max(1.25rem, env(safe-area-inset-top))" }}>
        <section
          style={{
            display: "grid",
            gap: "1rem",
            margin: "0 auto",
            minHeight: "calc(100dvh - 3.5rem)",
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
                {copyState === "copied" ? "복사됨" : copyState === "failed" ? "직접 복사" : ""}
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
