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
const KEYBOARD_VIEWPORT_MODE = "interactive-widget=resizes-content";

function isIOSLikeDevice() {
  const platform = window.navigator.platform.toLowerCase();
  const userAgent = window.navigator.userAgent.toLowerCase();
  const touchMac = platform === "macintel" && window.navigator.maxTouchPoints > 1;

  return /iphone|ipad|ipod/.test(userAgent) || touchMac;
}

function enableSupportedKeyboardViewportMode() {
  // interactive-widget is currently a Chromium keyboard viewport extension.
  // Avoid asking Safari/WebKit to parse it, where it emits a console error and
  // ignores the value anyway.
  if (isIOSLikeDevice() || !("virtualKeyboard" in window.navigator)) return;

  const viewportMeta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!viewportMeta) return;

  const content = viewportMeta.getAttribute("content") || "";
  if (content.includes("interactive-widget=")) return;

  viewportMeta.setAttribute("content", `${content}, ${KEYBOARD_VIEWPORT_MODE}`);
}

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
    let focusFrame: number | null = null;
    let settleTimer: number | null = null;
    let previousHeight: number | null = null;

    const applyMetrics = () => {
      frame = null;
      const metrics = readViewportMetrics();
      const root = document.documentElement;
      const viewportShrank = previousHeight !== null && metrics.height < previousHeight - 1;
      previousHeight = metrics.height;

      root.style.setProperty(VIEWPORT_HEIGHT_VAR, `${metrics.height}px`);
      root.style.setProperty(VIEWPORT_WIDTH_VAR, `${metrics.width}px`);
      root.style.setProperty(VIEWPORT_OFFSET_TOP_VAR, `${metrics.offsetTop}px`);
      root.style.setProperty(VIEWPORT_OFFSET_LEFT_VAR, `${metrics.offsetLeft}px`);
      root.style.setProperty(VIEWPORT_SCALE_VAR, String(metrics.scale));
      root.style.setProperty(KEYBOARD_INSET_BOTTOM_VAR, `${metrics.keyboardInsetBottom}px`);
      root.setAttribute(KEYBOARD_STATE_ATTRIBUTE, metrics.keyboardOpen ? "open" : "closed");

      // A tablet keyboard can shrink the visible area while an editor input
      // remains focused. Keep that field in the settings pane's scroll area.
      if (viewportShrank) {
        if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
        focusFrame = window.requestAnimationFrame(() => {
          focusFrame = null;
          const active = document.activeElement;
          if (!(active instanceof HTMLElement)
            || !active.matches("input, textarea, select, [contenteditable='true']")
            || !active.closest(".create-settings-sidebar")) return;
          const rect = active.getBoundingClientRect();
          const current = readViewportMetrics();
          if (rect.top < current.offsetTop || rect.bottom > current.offsetTop + current.height) {
            active.scrollIntoView({ block: "center", inline: "nearest" });
          }
        });
      }
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

    enableSupportedKeyboardViewportMode();
    scheduleApplyMetrics();

    window.addEventListener("resize", scheduleApplyMetrics, { passive: true });
    window.addEventListener("orientationchange", scheduleSettledApplyMetrics);
    window.addEventListener("pageshow", scheduleSettledApplyMetrics, { passive: true });
    visualViewport?.addEventListener("resize", scheduleApplyMetrics, { passive: true });
    visualViewport?.addEventListener("scroll", scheduleApplyMetrics, { passive: true });
    document.addEventListener("visibilitychange", scheduleApplyMetrics);

    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
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
