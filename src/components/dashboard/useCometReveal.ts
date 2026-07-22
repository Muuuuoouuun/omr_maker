"use client";

import { RefObject, useEffect } from "react";

interface CometRevealOptions {
    /** Comet head/tail color (CSS color string). */
    color?: string;
    /** How long the line-draw takes. */
    durationMs?: number;
    /** Delay before the draw starts. */
    delayMs?: number;
    /** Show the expanding ping halo on the final point. */
    endPing?: boolean;
    /** Re-run the reveal when this changes (e.g. data identity). */
    replayKey?: unknown;
    enabled?: boolean;
}

/** Matches the CSS easing used for the line draw (easeOutCubic). */
function easeOutCubic(t: number): number {
    return 1 - Math.pow(1 - t, 3);
}

const LINE_EASING = "cubic-bezier(0.33, 1, 0.68, 1)";
const SPRING_EASING = "cubic-bezier(0.34, 1.56, 0.64, 1)";
const TAIL_COUNT = 5;
const TAIL_LAG_MS = 42;

/**
 * 시안 B — comet line draw. Attach to a container wrapping a recharts chart
 * whose primary series carries className="comet-target" and
 * isAnimationActive={false}. The hook then owns the reveal:
 *  - draws the line via stroke-dashoffset (WAAPI),
 *  - flies a glowing comet head + trailing tail along the path,
 *  - fades the area fill in behind the draw,
 *  - pops the data dots in staggered,
 *  - pulses a ping halo on the final point.
 * Skips entirely (leaving the fully-drawn static chart recharts rendered) for
 * prefers-reduced-motion and hidden tabs, where rAF is throttled.
 */
export default function useCometReveal(
    containerRef: RefObject<HTMLElement | null>,
    {
        color = "var(--primary)",
        durationMs = 1150,
        delayMs = 150,
        endPing = true,
        replayKey,
        enabled = true,
    }: CometRevealOptions = {},
) {
    useEffect(() => {
        if (!enabled) return;
        const container = containerRef.current;
        if (!container) return;
        if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
        if (document.hidden) return;

        let cancelled = false;
        let rafId = 0;
        const cleanups: Array<() => void> = [];

        // recharts renders the SVG asynchronously behind ResponsiveContainer, so
        // poll a few frames until the target path exists (bail after ~1.2s).
        let attempts = 0;
        const findAndRun = () => {
            if (cancelled) return;
            const path = container.querySelector<SVGPathElement>(
                ".comet-target path.recharts-line-curve, .comet-target path.recharts-area-curve",
            );
            if (!path) {
                if (attempts++ < 72) rafId = requestAnimationFrame(findAndRun);
                return;
            }
            run(path);
        };

        const run = (path: SVGPathElement) => {
            const totalLength = path.getTotalLength();
            if (!Number.isFinite(totalLength) || totalLength <= 0) return;
            const svg = path.ownerSVGElement;
            const parent = path.parentNode as SVGElement | null;
            if (!svg || !parent) return;

            // 1) Line draw.
            path.style.strokeDasharray = `${totalLength}`;
            path.style.strokeDashoffset = `${totalLength}`;
            const drawAnim = path.animate(
                [{ strokeDashoffset: totalLength }, { strokeDashoffset: 0 }],
                { duration: durationMs, delay: delayMs, easing: LINE_EASING, fill: "both" },
            );
            drawAnim.onfinish = () => {
                // Clear the dash so native rendering (and any recharts re-render
                // diffing) returns to a pristine solid stroke.
                path.style.strokeDasharray = "";
                path.style.strokeDashoffset = "";
            };
            cleanups.push(() => {
                drawAnim.cancel();
                path.style.strokeDasharray = "";
                path.style.strokeDashoffset = "";
            });

            // 2) Comet head + tail, flown along the path with the same easing.
            const ns = "http://www.w3.org/2000/svg";
            const cometGroup = document.createElementNS(ns, "g");
            cometGroup.setAttribute("pointer-events", "none");
            const tail: SVGCircleElement[] = [];
            for (let i = TAIL_COUNT; i >= 1; i--) {
                const c = document.createElementNS(ns, "circle");
                c.setAttribute("r", `${1.6 + (TAIL_COUNT - i) * 0.7}`);
                c.setAttribute("fill", color);
                c.setAttribute("opacity", `${0.12 + (TAIL_COUNT - i) * 0.08}`);
                cometGroup.appendChild(c);
                tail.push(c);
            }
            const head = document.createElementNS(ns, "circle");
            head.setAttribute("r", "4.6");
            head.setAttribute("fill", color);
            head.setAttribute("opacity", "0.95");
            cometGroup.appendChild(head);
            parent.appendChild(cometGroup);
            cleanups.push(() => cometGroup.remove());

            const startTime = performance.now() + delayMs;
            const place = (el: SVGCircleElement, progress: number) => {
                const pt = path.getPointAtLength(Math.max(0, Math.min(1, progress)) * totalLength);
                el.setAttribute("cx", `${pt.x}`);
                el.setAttribute("cy", `${pt.y}`);
            };
            const frame = (now: number) => {
                if (cancelled) return;
                const elapsed = now - startTime;
                if (elapsed < 0) {
                    // Pre-delay: park everything at the start point, invisible.
                    cometGroup.setAttribute("opacity", "0");
                    rafId = requestAnimationFrame(frame);
                    return;
                }
                cometGroup.setAttribute("opacity", "1");
                place(head, easeOutCubic(Math.min(1, elapsed / durationMs)));
                tail.forEach((c, idx) => {
                    const lag = (TAIL_COUNT - idx) * TAIL_LAG_MS;
                    place(c, easeOutCubic(Math.max(0, Math.min(1, (elapsed - lag) / durationMs))));
                });
                if (elapsed < durationMs + TAIL_COUNT * TAIL_LAG_MS) {
                    rafId = requestAnimationFrame(frame);
                } else {
                    // Arrival: fade the comet out, leaving the end dot/ping.
                    const fade = cometGroup.animate(
                        [{ opacity: 1 }, { opacity: 0 }],
                        { duration: 260, easing: "ease-out", fill: "forwards" },
                    );
                    fade.onfinish = () => cometGroup.remove();
                }
            };
            rafId = requestAnimationFrame(frame);

            // 3) Area fill fade-in behind the draw.
            const area = container.querySelector<SVGPathElement>(".comet-target path.recharts-area-area");
            if (area) {
                const areaAnim = area.animate(
                    [{ opacity: 0 }, { opacity: 1 }],
                    { duration: 650, delay: delayMs + durationMs * 0.6, easing: "ease-out", fill: "both" },
                );
                cleanups.push(() => {
                    areaAnim.cancel();
                });
            }

            // 4) Data dots pop in staggered as the head passes. (recharts v3
            // renders dots in a sibling z-index layer, not inside the series
            // layer that carries `comet-target` — so query container-wide. A
            // second animated series' dots don't exist in the DOM yet at this
            // point, so only the comet series' dots are caught.)
            const dots = Array.from(container.querySelectorAll<SVGElement>(
                ".recharts-line-dots circle, .recharts-area-dots circle",
            ));
            dots.forEach((dot, i) => {
                dot.style.transformBox = "fill-box";
                dot.style.transformOrigin = "center";
                const pop = dot.animate(
                    [{ transform: "scale(0)" }, { transform: "scale(1)" }],
                    {
                        duration: 480,
                        delay: delayMs + durationMs * 0.55 + i * 60,
                        easing: SPRING_EASING,
                        fill: "both",
                    },
                );
                cleanups.push(() => pop.cancel());
            });

            // 5) Ping halo on the final point.
            if (endPing) {
                const endPoint = path.getPointAtLength(totalLength);
                const ping = document.createElementNS(ns, "circle");
                ping.setAttribute("cx", `${endPoint.x}`);
                ping.setAttribute("cy", `${endPoint.y}`);
                ping.setAttribute("r", "6");
                ping.setAttribute("fill", "none");
                ping.setAttribute("stroke", color);
                ping.setAttribute("stroke-width", "2");
                ping.setAttribute("opacity", "0");
                ping.setAttribute("pointer-events", "none");
                ping.style.transformBox = "fill-box";
                ping.style.transformOrigin = "center";
                parent.appendChild(ping);
                const pingAnim = ping.animate(
                    [
                        { transform: "scale(0.4)", opacity: 0.7 },
                        { transform: "scale(2.4)", opacity: 0 },
                    ],
                    {
                        duration: 1000,
                        delay: delayMs + durationMs,
                        iterations: 2,
                        easing: "ease-out",
                    },
                );
                pingAnim.onfinish = () => ping.remove();
                cleanups.push(() => ping.remove());
            }
        };

        rafId = requestAnimationFrame(findAndRun);

        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
            cleanups.forEach(fn => fn());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [replayKey, enabled, color, durationMs, delayMs, endPing]);
}
