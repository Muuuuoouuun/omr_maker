"use client";

import { useEffect } from "react";

export default function PWARegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then(registration => {
        registration.update().catch(() => {
          // Update checks are opportunistic; registration itself already succeeded.
        });
      })
      .catch(error => {
        console.warn("Service worker registration failed", error);
      });
  }, []);

  return null;
}
