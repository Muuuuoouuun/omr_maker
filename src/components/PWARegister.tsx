"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import { showToast } from "@/components/Toast";

const SKIP_WAITING_MESSAGE = "OMR_SKIP_WAITING";
const DEFERRED_UPDATE_KEY = "omr_pwa_deferred_update_v1";

function isActiveWorkScreen(pathname: string): boolean {
  return pathname === "/create"
    || pathname.startsWith("/solve/")
    || pathname.startsWith("/teacher/exam/")
    || pathname.startsWith("/teacher/live")
    || pathname.startsWith("/teacher/billing");
}

function canReloadForServiceWorkerUpdate(pathname: string | null): boolean {
  if (!pathname) return true;
  return !isActiveWorkScreen(pathname);
}

function askWorkerToActivate(worker: ServiceWorker | null | undefined): void {
  worker?.postMessage({ type: SKIP_WAITING_MESSAGE });
}

function hasDeferredUpdate(): boolean {
  try {
    return window.sessionStorage.getItem(DEFERRED_UPDATE_KEY) === "1";
  } catch {
    return false;
  }
}

function rememberDeferredUpdate(): void {
  try {
    window.sessionStorage.setItem(DEFERRED_UPDATE_KEY, "1");
  } catch {
    // Restricted webviews can reject sessionStorage; the toast still explains the next step.
  }
}

function clearDeferredUpdate(): void {
  try {
    window.sessionStorage.removeItem(DEFERRED_UPDATE_KEY);
  } catch {
    // Storage access is best-effort in installed webviews.
  }
}

export default function PWARegister() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;

    if (process.env.NODE_ENV !== "production") return;
    if (!canReloadForServiceWorkerUpdate(pathname)) return;
    if (!hasDeferredUpdate()) return;

    clearDeferredUpdate();
    window.location.reload();
  }, [pathname]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cleanupRegistrationListener: (() => void) | undefined;
    let cleanupInstallingWorkerListener: (() => void) | undefined;
    let reloadOnNextController = false;
    let notifyOnNextController = false;
    let hasShownDeferredUpdateNotice = false;
    let isDisposed = false;

    const checkForUpdates = (registration: ServiceWorkerRegistration) => {
      registration.update().catch(() => {
        // Update checks are opportunistic; the installed app keeps working offline.
      });
    };

    const checkCurrentRegistrationForUpdates = () => {
      navigator.serviceWorker.getRegistration("/sw.js")
        .then(registration => {
          if (!isDisposed && registration) checkForUpdates(registration);
        })
        .catch(() => {
          // Some restricted webviews can reject service worker reads.
        });
    };

    const requestActivation = (worker: ServiceWorker | null | undefined) => {
      if (!worker) return;
      const shouldReload = canReloadForServiceWorkerUpdate(pathnameRef.current);
      reloadOnNextController = shouldReload;
      notifyOnNextController = !shouldReload && Boolean(navigator.serviceWorker.controller);
      askWorkerToActivate(worker);
    };

    const handleControllerChange = () => {
      if (isDisposed) return;
      if (reloadOnNextController) {
        reloadOnNextController = false;
        notifyOnNextController = false;
        clearDeferredUpdate();
        window.location.reload();
        return;
      }
      if (notifyOnNextController && !hasShownDeferredUpdateNotice) {
        notifyOnNextController = false;
        hasShownDeferredUpdateNotice = true;
        rememberDeferredUpdate();
        showToast(
          "info",
          "새 버전 준비됨",
          "현재 작업은 유지됩니다. 제출하거나 저장한 뒤 안전한 화면으로 이동하면 최신 앱으로 전환됩니다.",
          6500,
        );
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      checkCurrentRegistrationForUpdates();
    };

    const handleOnline = () => {
      checkCurrentRegistrationForUpdates();
    };

    navigator.serviceWorker.addEventListener("controllerchange", handleControllerChange);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("online", handleOnline);

    navigator.serviceWorker
      .register("/sw.js")
      .then(registration => {
        if (isDisposed) return;

        const handleUpdateFound = () => {
          const installingWorker = registration.installing;
          if (!installingWorker) return;

          if (navigator.serviceWorker.controller) {
            reloadOnNextController = canReloadForServiceWorkerUpdate(pathnameRef.current);
          }

          cleanupInstallingWorkerListener?.();
          const handleStateChange = () => {
            if (isDisposed) return;
            if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
              requestActivation(registration.waiting || installingWorker);
            }
          };
          installingWorker.addEventListener("statechange", handleStateChange);
          cleanupInstallingWorkerListener = () => installingWorker.removeEventListener("statechange", handleStateChange);
        };

        registration.addEventListener("updatefound", handleUpdateFound);
        cleanupRegistrationListener = () => registration.removeEventListener("updatefound", handleUpdateFound);
        requestActivation(registration.waiting);
        checkForUpdates(registration);
      })
      .catch(error => {
        console.warn("Service worker registration failed", error);
      });

    return () => {
      isDisposed = true;
      cleanupInstallingWorkerListener?.();
      cleanupRegistrationListener?.();
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  return null;
}
