import { ReactNode } from "react";

interface StatCardProps {
  title: string;
  value: string | number;
  icon?: ReactNode;
  trend?: string;
  trendUp?: boolean;
  detail?: string;
  actionLabel?: string;
  actionAriaLabel?: string;
  onAction?: () => void;
  color?: string;
}

export default function StatCard({
  title,
  value,
  icon,
  trend,
  trendUp,
  detail,
  actionLabel,
  actionAriaLabel,
  onAction,
  color = "var(--primary)",
}: StatCardProps) {
  const isVarColor = color.startsWith("var(");
  const rawHex = isVarColor ? null : color;

  const iconBg = rawHex ? `${rawHex}18` : `color-mix(in srgb, ${color}, transparent 85%)`;
  const glowBg = rawHex ? `${rawHex}10` : `color-mix(in srgb, ${color}, transparent 94%)`;
  const accentGrad = rawHex
    ? `linear-gradient(90deg, ${rawHex}, transparent)`
    : `linear-gradient(90deg, ${color}, transparent)`;

  return (
    <div
      className="bento-card col-span-1"
      style={{
        position: "relative",
        overflow: "hidden",
        padding: "1.25rem 1.4rem",
        minHeight: "auto",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        gap: "0.9rem",
      }}
    >
      {/* Top accent stripe */}
      <div
        className="stat-card-accent"
        style={{ background: accentGrad, opacity: 0.7 }}
      />

      {/* Header row: title + icon */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "0.1rem",
        }}
      >
        <span
          style={{
            color: "var(--muted)",
            fontSize: "0.72rem",
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
        {icon && (
          <div
            style={{
              color,
              background: iconBg,
              padding: "6px",
              borderRadius: "9px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {icon}
          </div>
        )}
      </div>

      {/* Value + trend (tight vertical stack) */}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
        <div
          className="numeric-emphasis"
          style={{
            fontSize: "2.4rem",
            fontWeight: 950,
            color: "var(--foreground)",
            lineHeight: 1.0,
            letterSpacing: "-0.04em",
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value}
        </div>

        {detail && (
          <p className="stat-card-detail">{detail}</p>
        )}

        {trend && (
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "5px",
              padding: "3px 9px",
              borderRadius: "var(--radius-full)",
              fontSize: "0.72rem",
              fontWeight: 700,
              color: trendUp ? "var(--success)" : "var(--error)",
              background: trendUp
                ? "rgba(16,185,129,0.1)"
                : "rgba(239,68,68,0.1)",
              border: trendUp
                ? "1px solid rgba(16,185,129,0.22)"
                : "1px solid rgba(239,68,68,0.22)",
              width: "fit-content",
            }}
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 10 10"
              fill="currentColor"
            >
              {trendUp ? (
                <path d="M5 1L9 7H1L5 1Z" />
              ) : (
                <path d="M5 9L1 3H9L5 9Z" />
              )}
            </svg>
            {trend}
          </div>
        )}

        {actionLabel && onAction && (
          <button
            type="button"
            className="stat-card-action"
            onClick={onAction}
            aria-label={actionAriaLabel || actionLabel}
          >
            {actionLabel}
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M3.5 8h9M9 4.5 12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Background glow */}
      <div
        style={{
          position: "absolute",
          bottom: "-40px",
          right: "-40px",
          width: "130px",
          height: "130px",
          background: glowBg,
          borderRadius: "50%",
          pointerEvents: "none",
          filter: "blur(20px)",
        }}
      />
    </div>
  );
}
