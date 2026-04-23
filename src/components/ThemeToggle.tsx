"use client";

import { useEffect, useState } from "react";

type Theme = "light" | "dark";

export default function ThemeToggle({ size = "default" }: { size?: "small" | "default" }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    // Read current theme from DOM (set by inline script in layout).
    // Note: the inline script has already resolved 'auto' to a concrete 'light'/'dark'
    // before we run here, so this read is always a concrete theme.
    const current =
      (document.documentElement.getAttribute("data-theme") as Theme) || "light";
    // Hydrate client-resolved theme after the layout script has run.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(current);
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try {
      // Toggling explicitly commits to light/dark, overriding any prior 'auto'.
      localStorage.setItem("omr_theme", next);
    } catch {
      /* ignore */
    }
  };

  if (!mounted) {
    return (
      <div
        style={{
          width: size === "small" ? "32px" : "36px",
          height: size === "small" ? "32px" : "36px",
        }}
      />
    );
  }

  const isDark = theme === "dark";
  const btnSize = size === "small" ? 32 : 36;
  const iconSize = size === "small" ? 16 : 18;

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? "라이트 모드로 전환" : "다크 모드로 전환"}
      title={isDark ? "라이트 모드" : "다크 모드"}
      style={{
        width: `${btnSize}px`,
        height: `${btnSize}px`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        borderRadius: "var(--radius-full)",
        background: "var(--background)",
        border: "1px solid var(--border)",
        color: "var(--foreground)",
        cursor: "pointer",
        transition: "all 0.2s",
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "rgba(99,102,241,0.4)";
        e.currentTarget.style.color = "var(--primary)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--border)";
        e.currentTarget.style.color = "var(--foreground)";
      }}
    >
      {isDark ? (
        <svg width={iconSize} height={iconSize} viewBox="0 0 20 20" fill="none">
          {/* Sun */}
          <circle cx="10" cy="10" r="3.5" stroke="currentColor" strokeWidth="1.7" />
          <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
            <line x1="10" y1="2" x2="10" y2="4" />
            <line x1="10" y1="16" x2="10" y2="18" />
            <line x1="2" y1="10" x2="4" y2="10" />
            <line x1="16" y1="10" x2="18" y2="10" />
            <line x1="4.2" y1="4.2" x2="5.6" y2="5.6" />
            <line x1="14.4" y1="14.4" x2="15.8" y2="15.8" />
            <line x1="4.2" y1="15.8" x2="5.6" y2="14.4" />
            <line x1="14.4" y1="5.6" x2="15.8" y2="4.2" />
          </g>
        </svg>
      ) : (
        <svg width={iconSize} height={iconSize} viewBox="0 0 20 20" fill="none">
          {/* Moon */}
          <path
            d="M16.5 11.5A7 7 0 0 1 8.5 3.5a7 7 0 1 0 8 8z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}
