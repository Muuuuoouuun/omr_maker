"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Splits a stat value into a leading number + surrounding text so it can be
 * counted up. Returns null when the value isn't a single clean number
 * (e.g. "1분 30초", or a range) — those should render statically.
 */
export function parseCountableValue(value: string | number):
    | { num: number; prefix: string; suffix: string; decimals: number }
    | null {
    if (typeof value === "number") {
        return Number.isFinite(value)
            ? { num: value, prefix: "", suffix: "", decimals: Number.isInteger(value) ? 0 : 1 }
            : null;
    }
    const match = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(value.trim());
    if (!match) return null;
    const [, prefix, rawNum, suffix] = match;
    // A digit left in the suffix means there's a second number (a range/compound
    // value) — counting only the first would misrepresent it, so skip.
    if (/\d/.test(suffix)) return null;
    const numStr = rawNum.replace(/,/g, "");
    const decimals = numStr.includes(".") ? numStr.split(".")[1].length : 0;
    return { num: parseFloat(numStr), prefix, suffix, decimals };
}

interface CountUpProps {
    /** Target value to count up to. */
    value: number;
    decimals?: number;
    durationMs?: number;
    delayMs?: number;
    prefix?: string;
    suffix?: string;
}

/**
 * Animates a number from 0 up to `value` on mount (easeOutCubic). Used by the
 * KPI stat cards/tiles so their figures roll up as the card springs in.
 * Honors prefers-reduced-motion by snapping straight to the final value, and
 * renders `0` identically on server + first client paint so there's no
 * hydration mismatch before the effect starts.
 */
export default function CountUp({
    value,
    decimals = 0,
    durationMs = 900,
    delayMs = 0,
    prefix = "",
    suffix = "",
}: CountUpProps) {
    const [display, setDisplay] = useState(0);
    const rafRef = useRef<number | null>(null);

    useEffect(() => {
        const reduce =
            typeof window !== "undefined" &&
            window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
        // requestAnimationFrame is throttled/paused while the tab is hidden, so a
        // dashboard that loads in a background tab would otherwise sit stuck at 0.
        // Snap straight to the final value in that case (and for reduced motion).
        if (reduce || !Number.isFinite(value) || (typeof document !== "undefined" && document.hidden)) {
            const timeoutId = window.setTimeout(() => setDisplay(value), 0);
            return () => window.clearTimeout(timeoutId);
        }

        const startTime = performance.now() + delayMs;
        const tick = (now: number) => {
            if (now < startTime) {
                rafRef.current = requestAnimationFrame(tick);
                return;
            }
            const t = Math.min(1, (now - startTime) / durationMs);
            const eased = 1 - Math.pow(1 - t, 3);
            setDisplay(value * eased);
            if (t < 1) {
                rafRef.current = requestAnimationFrame(tick);
            } else {
                setDisplay(value);
            }
        };
        rafRef.current = requestAnimationFrame(tick);

        return () => {
            if (rafRef.current) cancelAnimationFrame(rafRef.current);
        };
    }, [value, durationMs, delayMs]);

    const formatted = display.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
    });

    return (
        <>
            {prefix}
            {formatted}
            {/* Korean unit suffixes (점/명/개) must not inherit the parent's tight
                tabular-digit letter-spacing (some callers use -0.045em to -0.06em) —
                that convention is for Latin/numeric display, not Hangul. */}
            <span style={{ letterSpacing: "normal" }}>{suffix}</span>
        </>
    );
}
