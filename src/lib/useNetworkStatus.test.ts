import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readNetworkOnline, subscribeToNetworkStatus } from "./useNetworkStatus";

afterEach(() => vi.unstubAllGlobals());

describe("network status", () => {
    it("reads navigator.onLine and assumes online without a navigator", () => {
        vi.stubGlobal("navigator", undefined);
        expect(readNetworkOnline()).toBe(true);
        vi.stubGlobal("navigator", { onLine: false });
        expect(readNetworkOnline()).toBe(false);
        vi.stubGlobal("navigator", { onLine: true });
        expect(readNetworkOnline()).toBe(true);
    });

    it("subscribes to online and offline events and cleans up", () => {
        const target = new EventTarget();
        vi.stubGlobal("window", target);
        const onChange = vi.fn();
        const unsubscribe = subscribeToNetworkStatus(onChange);
        target.dispatchEvent(new Event("offline"));
        target.dispatchEvent(new Event("online"));
        expect(onChange).toHaveBeenCalledTimes(2);
        unsubscribe();
        target.dispatchEvent(new Event("offline"));
        expect(onChange).toHaveBeenCalledTimes(2);
    });

    it("routes every solve-page review navigation through the offline-aware helper", () => {
        const solve = readFileSync(path.join(process.cwd(), "src/app/solve/[id]/page.tsx"), "utf8");
        expect(solve).not.toMatch(/router\.push\(`\/student\/review\//);
        expect(solve.match(/navigateToReview\(/g)?.length).toBe(6);
        expect(solve).toContain('setSubmissionProgress("review_waiting_online")');
        expect(solve).toContain('window.addEventListener("online", openWaitingReview)');
        expect(solve).toContain('<Link href="/student/history"');
        const bannerStart = solve.indexOf('className="solve-offline-banner-region"');
        expect(bannerStart).toBeGreaterThan(0);
        const bannerTag = solve.slice(bannerStart, solve.indexOf(">", bannerStart));
        expect(bannerTag).toContain('aria-live="polite"');
        expect(bannerTag).not.toContain("role=");
        expect(solve).toContain("{!isOnline && (");
        expect(solve).toContain("solveSaveStatusChip({ saveState: draftSaveState, online: isOnline })");
    });
});
