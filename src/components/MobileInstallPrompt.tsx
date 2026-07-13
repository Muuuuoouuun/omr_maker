"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { Activity, Download, Share2, Smartphone, X } from "lucide-react";
import { usePathname } from "next/navigation";

const DISMISS_KEY = "omr_install_prompt_dismissed_v1";

type InstallPromptOutcome = "accepted" | "dismissed";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: InstallPromptOutcome; platform: string }>;
}

function isStandaloneDisplay(): boolean {
  if (typeof window === "undefined") return false;

  return window.matchMedia("(display-mode: standalone)").matches
    || window.matchMedia("(display-mode: fullscreen)").matches
    || ("standalone" in window.navigator && Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone));
}

function isIOSDevice(): boolean {
  if (typeof window === "undefined") return false;

  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();
  const touchMac = platform === "macintel" && window.navigator.maxTouchPoints > 1;

  return /iphone|ipad|ipod/.test(userAgent) || touchMac;
}

function isMobileViewport(): boolean {
  if (typeof window === "undefined") return false;

  return window.matchMedia("(max-width: 820px), (pointer: coarse)").matches;
}

function isPromptDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberPromptDismissed(): void {
  try {
    window.localStorage.setItem(DISMISS_KEY, "1");
  } catch {
    // Storage can be unavailable in private browsing or restricted webviews.
  }
}

export default function MobileInstallPrompt() {
  const pathname = usePathname();
  const descriptionId = useId();
  const isSuppressedPath = pathname === "/create" || pathname === "/pwa-check" || pathname.startsWith("/solve/");
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [showIOSPrompt, setShowIOSPrompt] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  // Register the install listeners unconditionally on mount. Chrome fires
  // beforeinstallprompt once shortly after load, so if a student lands directly
  // on a suppressed path (e.g. /solve/[id]) we must still capture the deferred
  // prompt — otherwise the event is lost for the whole session. Suppression and
  // the eligibility checks (standalone / dismissed / viewport) only gate whether
  // the banner becomes visible; render already re-applies isSuppressedPath.
  useEffect(() => {
    if (typeof window === "undefined") return;

    const canBecomeVisible = () =>
      !isStandaloneDisplay() && !isPromptDismissed() && isMobileViewport();

    let capturedPrompt = false;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      const installEvent = event as BeforeInstallPromptEvent;
      capturedPrompt = true;
      setDeferredPrompt(installEvent);
      if (canBecomeVisible()) {
        window.setTimeout(() => setIsVisible(true), 900);
      }
    };

    const handleAppInstalled = () => {
      rememberPromptDismissed();
      setIsVisible(false);
      setShowIOSPrompt(false);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    const iosTimer = window.setTimeout(() => {
      if (!capturedPrompt && isIOSDevice() && canBecomeVisible()) {
        setShowIOSPrompt(true);
        setIsVisible(true);
      }
    }, 1200);

    return () => {
      window.clearTimeout(iosTimer);
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    rememberPromptDismissed();
    setIsVisible(false);
    setShowIOSPrompt(false);
    setDeferredPrompt(null);
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === "accepted") {
      rememberPromptDismissed();
      setIsVisible(false);
      setShowIOSPrompt(false);
    }
    setDeferredPrompt(null);
  }, [deferredPrompt]);

  if (isSuppressedPath || !isVisible || (!deferredPrompt && !showIOSPrompt)) return null;

  return (
    <aside className="mobile-install-prompt" aria-label="앱 설치 안내" aria-describedby={descriptionId} aria-live="polite">
      <div className="mobile-install-prompt__icon" aria-hidden="true">
        <Smartphone size={19} />
      </div>
      <div className="mobile-install-prompt__copy">
        <strong>앱으로 설치</strong>
        <span id={descriptionId}>
          {showIOSPrompt
            ? "공유 메뉴에서 홈 화면에 추가를 선택하세요."
            : "홈 화면에서 바로 열 수 있어요."}
        </span>
      </div>
      <div className="mobile-install-prompt__actions">
        {deferredPrompt ? (
          <button type="button" className="mobile-install-prompt__action" onClick={install}>
            <Download size={16} />
            <span>설치</span>
          </button>
        ) : (
          <div className="mobile-install-prompt__hint" aria-hidden="true">
            <Share2 size={16} />
          </div>
        )}
        <Link href="/pwa-check" className="mobile-install-prompt__check" aria-label="앱 상태 체크" title="앱 상태 체크">
          <Activity size={16} />
          <span>체크</span>
        </Link>
      </div>
      <button type="button" className="mobile-install-prompt__close" onClick={dismiss} aria-label="앱 설치 안내 닫기">
        <X size={16} />
      </button>
    </aside>
  );
}
