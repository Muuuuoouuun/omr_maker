// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CountUp, { shouldReduceCountUpMotion } from "./CountUp";

type MotionListener = (event: MediaQueryListEvent) => void;

let osPrefersReducedMotion = false;
const motionListeners = new Set<MotionListener>();

function notifyMotionPreference() {
    const event = { matches: osPrefersReducedMotion } as MediaQueryListEvent;
    for (const listener of motionListeners) listener(event);
}

beforeEach(() => {
    osPrefersReducedMotion = false;
    motionListeners.clear();
    document.documentElement.removeAttribute("data-motion");
    Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: vi.fn(() => ({
            matches: osPrefersReducedMotion,
            media: "(prefers-reduced-motion: reduce)",
            onchange: null,
            addEventListener: (_type: string, listener: MotionListener) => motionListeners.add(listener),
            removeEventListener: (_type: string, listener: MotionListener) => motionListeners.delete(listener),
            addListener: vi.fn(),
            removeListener: vi.fn(),
            dispatchEvent: vi.fn(),
        })),
    });
});
afterEach(() => {
    cleanup();
    document.documentElement.removeAttribute("data-motion");
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("CountUp motion preference", () => {
    it("treats either the OS or the app motion setting as reduced motion", () => {
        expect(shouldReduceCountUpMotion(false, "off")).toBe(true);
        expect(shouldReduceCountUpMotion(true, "on")).toBe(true);
        expect(shouldReduceCountUpMotion(false, "on")).toBe(false);
        expect(shouldReduceCountUpMotion(false, null)).toBe(false);
    });

    it("marks reduced motion ready only after committing the final value", async () => {
        vi.useFakeTimers();
        document.documentElement.setAttribute("data-motion", "off");

        const { container } = render(<CountUp value={24} suffix="명" />);
        const countUp = container.querySelector("[data-count-up-value]");

        expect(countUp).not.toHaveAttribute("data-count-up-ready");
        expect(countUp).toHaveAttribute("data-count-up-motion", "reduced");

        await act(async () => {
            await vi.runOnlyPendingTimersAsync();
        });

        expect(countUp).toHaveAttribute("data-count-up-ready", "true");
        expect(countUp).toHaveAttribute("data-count-up-raf", "idle");
        expect(countUp).toHaveTextContent("24명");
        vi.useRealTimers();
    });

    it("marks animated motion ready only after its scheduled RAF starts", async () => {
        const scheduled: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
            scheduled.push(callback);
            return scheduled.length;
        }));
        vi.stubGlobal("cancelAnimationFrame", vi.fn());

        const { container } = render(<CountUp value={24} />);
        const countUp = container.querySelector("[data-count-up-value]");

        expect(countUp).not.toHaveAttribute("data-count-up-ready");
        expect(scheduled).toHaveLength(1);
        await act(async () => scheduled[0](performance.now()));
        await waitFor(() => expect(countUp).toHaveAttribute("data-count-up-ready", "true"));
        expect(countUp).toHaveAttribute("data-count-up-motion", "animated");

        await act(async () => {
            osPrefersReducedMotion = true;
            notifyMotionPreference();
        });
        await waitFor(() => expect(countUp).toHaveAttribute("data-count-up-ready", "true"));
        expect(countUp).toHaveAttribute("data-count-up-motion", "reduced");
    });
});
