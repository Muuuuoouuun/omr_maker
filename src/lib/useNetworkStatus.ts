"use client";

import { useSyncExternalStore } from "react";

/**
 * Browser connectivity as React state: `navigator.onLine` plus the window
 * `online` / `offline` events. `navigator.onLine === false` reliably means
 * "no network"; `true` only means "maybe online", so callers treat it as a
 * hint for UI and navigation, never as proof a request will succeed.
 */
export function readNetworkOnline(): boolean {
    if (typeof navigator === "undefined") return true;
    return navigator.onLine !== false;
}

export function subscribeToNetworkStatus(onChange: () => void): () => void {
    if (typeof window === "undefined") return () => {};
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
        window.removeEventListener("online", onChange);
        window.removeEventListener("offline", onChange);
    };
}

/** True while the browser reports a network connection. SSR assumes online. */
export function useNetworkStatus(): boolean {
    return useSyncExternalStore(subscribeToNetworkStatus, readNetworkOnline, () => true);
}
