"use client";

import { useEffect } from "react";

const VIEWPORT_HEIGHT_VAR = "--app-viewport-height";

function readViewportHeight(): number {
  return Math.max(1, Math.round(window.visualViewport?.height || window.innerHeight));
}

export default function ViewportHeightSync() {
  useEffect(() => {
    let frame: number | null = null;

    const applyHeight = () => {
      frame = null;
      document.documentElement.style.setProperty(VIEWPORT_HEIGHT_VAR, `${readViewportHeight()}px`);
    };

    const scheduleApplyHeight = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(applyHeight);
    };

    const visualViewport = window.visualViewport;

    scheduleApplyHeight();

    window.addEventListener("resize", scheduleApplyHeight, { passive: true });
    window.addEventListener("orientationchange", scheduleApplyHeight);
    visualViewport?.addEventListener("resize", scheduleApplyHeight, { passive: true });
    visualViewport?.addEventListener("scroll", scheduleApplyHeight, { passive: true });
    document.addEventListener("visibilitychange", scheduleApplyHeight);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", scheduleApplyHeight);
      window.removeEventListener("orientationchange", scheduleApplyHeight);
      visualViewport?.removeEventListener("resize", scheduleApplyHeight);
      visualViewport?.removeEventListener("scroll", scheduleApplyHeight);
      document.removeEventListener("visibilitychange", scheduleApplyHeight);
    };
  }, []);

  return null;
}
