"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const SKIP_WAITING_MESSAGE = "OMR_SKIP_WAITING";

function canReloadForServiceWorkerUpdate(pathname: string | null): boolean {
  if (!pathname) return true;
  return pathname !== "/create" && !pathname.startsWith("/solve/");
}

function askWorkerToActivate(worker: ServiceWorker | null | undefined): void {
  worker?.postMessage({ type: SKIP_WAITING_MESSAGE });
}

export default function PWARegister() {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);

  useEffect(() => {
    pathnameRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    let cleanupRegistrationListener: (() => void) | undefined;
    let reloadOnNextController = false;
    let isDisposed = false;

    const checkForUpdates = (registration: ServiceWorkerRegistration) => {
      registration.update().catch(() => {
        // Update checks are opportunistic; the installed app keeps working offline.
      });
    };

    const checkCurrentRegistrationForUpdates = () => {
      navigator.serviceWorker.getRegistration("/sw.js")
        .then(registration => {
          if (registration) checkForUpdates(registration);
        })
        .catch(() => {
          // Some restricted webviews can reject service worker reads.
        });
    };

    const requestActivation = (worker: ServiceWorker | null | undefined) => {
      if (!worker) return;
      reloadOnNextController = canReloadForServiceWorkerUpdate(pathnameRef.current);
      askWorkerToActivate(worker);
    };

    const handleControllerChange = () => {
      if (isDisposed || !reloadOnNextController) return;
      reloadOnNextController = false;
      window.location.reload();
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

          installingWorker.addEventListener("statechange", () => {
            if (installingWorker.state === "installed" && navigator.serviceWorker.controller) {
              requestActivation(registration.waiting || installingWorker);
            }
          });
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
      cleanupRegistrationListener?.();
      navigator.serviceWorker.removeEventListener("controllerchange", handleControllerChange);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  return null;
}
