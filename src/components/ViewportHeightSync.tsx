"use client";

import { useEffect } from "react";

const VIEWPORT_HEIGHT_VAR = "--app-viewport-height";
const VIEWPORT_WIDTH_VAR = "--app-viewport-width";
const VIEWPORT_OFFSET_TOP_VAR = "--app-visual-viewport-offset-top";
const VIEWPORT_OFFSET_LEFT_VAR = "--app-visual-viewport-offset-left";
const VIEWPORT_SCALE_VAR = "--app-visual-viewport-scale";
const KEYBOARD_INSET_BOTTOM_VAR = "--app-keyboard-inset-bottom";
const KEYBOARD_STATE_ATTRIBUTE = "data-app-keyboard";
const KEYBOARD_OPEN_THRESHOLD = 80;

function readViewportMetrics() {
  const visualViewport = window.visualViewport;
  const layoutHeight = Math.max(1, Math.round(window.innerHeight));
  const height = Math.max(1, Math.round(visualViewport?.height || layoutHeight));
  const width = Math.max(1, Math.round(visualViewport?.width || window.innerWidth));
  const offsetTop = Math.max(0, Math.round(visualViewport?.offsetTop || 0));
  const offsetLeft = Math.max(0, Math.round(visualViewport?.offsetLeft || 0));
  const scale = visualViewport?.scale || 1;
  const keyboardInsetBottom = Math.max(0, Math.round(layoutHeight - height - offsetTop));

  return {
    height,
    keyboardInsetBottom,
    keyboardOpen: keyboardInsetBottom >= KEYBOARD_OPEN_THRESHOLD,
    offsetLeft,
    offsetTop,
    scale,
    width,
  };
}

export default function ViewportHeightSync() {
  useEffect(() => {
    let frame: number | null = null;
    let settleTimer: number | null = null;

    const applyMetrics = () => {
      frame = null;
      const metrics = readViewportMetrics();
      const root = document.documentElement;

      root.style.setProperty(VIEWPORT_HEIGHT_VAR, `${metrics.height}px`);
      root.style.setProperty(VIEWPORT_WIDTH_VAR, `${metrics.width}px`);
      root.style.setProperty(VIEWPORT_OFFSET_TOP_VAR, `${metrics.offsetTop}px`);
      root.style.setProperty(VIEWPORT_OFFSET_LEFT_VAR, `${metrics.offsetLeft}px`);
      root.style.setProperty(VIEWPORT_SCALE_VAR, String(metrics.scale));
      root.style.setProperty(KEYBOARD_INSET_BOTTOM_VAR, `${metrics.keyboardInsetBottom}px`);
      root.setAttribute(KEYBOARD_STATE_ATTRIBUTE, metrics.keyboardOpen ? "open" : "closed");
    };

    const scheduleApplyMetrics = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(applyMetrics);
    };

    const scheduleSettledApplyMetrics = () => {
      scheduleApplyMetrics();
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(scheduleApplyMetrics, 180);
    };

    const visualViewport = window.visualViewport;

    scheduleApplyMetrics();

    window.addEventListener("resize", scheduleApplyMetrics, { passive: true });
    window.addEventListener("orientationchange", scheduleSettledApplyMetrics);
    window.addEventListener("pageshow", scheduleSettledApplyMetrics, { passive: true });
    visualViewport?.addEventListener("resize", scheduleApplyMetrics, { passive: true });
    visualViewport?.addEventListener("scroll", scheduleApplyMetrics, { passive: true });
    document.addEventListener("visibilitychange", scheduleApplyMetrics);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      window.removeEventListener("resize", scheduleApplyMetrics);
      window.removeEventListener("orientationchange", scheduleSettledApplyMetrics);
      window.removeEventListener("pageshow", scheduleSettledApplyMetrics);
      visualViewport?.removeEventListener("resize", scheduleApplyMetrics);
      visualViewport?.removeEventListener("scroll", scheduleApplyMetrics);
      document.removeEventListener("visibilitychange", scheduleApplyMetrics);
    };
  }, []);

  return null;
}
