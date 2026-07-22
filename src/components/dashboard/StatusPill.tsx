import { CSSProperties, ReactNode } from "react";

/**
 * Shared pill/chip primitive for short status labels — sync state, exam
 * correctness counts, provider status, section tags, etc. Replaces the 50+
 * hand-rolled `style={{}}` pill objects scattered across the dashboard
 * (rounded-full shape, tinted border+background+color triplet, short label,
 * sometimes an icon, sometimes a muted detail line underneath).
 *
 * Tone colors mirror the border/background/color convention already in wide
 * use app-wide (see the `--primary` / `--success` / `--warning` / `--error` /
 * `--grade-red` / `--muted` tokens in src/app/globals.css :root) — this
 * component doesn't invent any new colors, it just centralizes the existing
 * triplets so call sites stop re-typing them.
 *
 * Covers three observed shapes via props rather than three components:
 *  - size="sm", no icon/detail  → bare tag/section-label pill (single line).
 *  - size="md" + icon + detail  → icon + bold label + muted detail, stacked.
 *  - variant="outline"          → border + color only, no background fill.
 */

type StatusPillTone = "primary" | "success" | "warning" | "error" | "grade" | "muted";
type StatusPillVariant = "filled" | "outline";
type StatusPillSize = "sm" | "md";

interface StatusPillProps {
  /** Color triplet to use. Defaults to "primary". */
  tone?: StatusPillTone;
  /** Main label text (the bold line). */
  label: string;
  /** Optional smaller muted line rendered under the label — switches the
   *  pill into its two-line shape when present. */
  detail?: string;
  /** Optional leading icon. Size it yourself when passing it in (e.g.
   *  `<RefreshCw size={13} />`) — the pill doesn't resize icons for you. */
  icon?: ReactNode;
  /** "filled" keeps the tinted background (default). "outline" drops the
   *  background fill and keeps only the border + text color. */
  variant?: StatusPillVariant;
  /** "sm" is the bare tag/section-label shape (tighter padding, no detail
   *  line expected). "md" (default) is the icon + label(+detail) shape. */
  size?: StatusPillSize;
  className?: string;
  style?: CSSProperties;
}

const TONE_STYLES: Record<StatusPillTone, { color: string; background: string; border: string }> = {
  primary: { color: "var(--primary)", background: "rgba(99,102,241,0.1)", border: "rgba(99,102,241,0.24)" },
  success: { color: "var(--success)", background: "rgba(16,185,129,0.1)", border: "rgba(16,185,129,0.22)" },
  warning: { color: "var(--warning)", background: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.28)" },
  error: { color: "var(--error)", background: "rgba(239,68,68,0.1)", border: "rgba(239,68,68,0.24)" },
  grade: { color: "var(--grade-red)", background: "var(--grade-red-soft)", border: "var(--grade-red-line)" },
  muted: { color: "var(--muted)", background: "rgba(100,116,139,0.1)", border: "rgba(100,116,139,0.22)" },
};

export default function StatusPill({
  tone = "primary",
  label,
  detail,
  icon,
  variant = "filled",
  size = "md",
  className,
  style,
}: StatusPillProps) {
  const { color, background, border } = TONE_STYLES[tone];
  const isTwoLine = Boolean(detail);

  return (
    <span
      className={className}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: size === "sm" ? "0.3rem" : "0.4rem",
        padding: size === "sm" ? "0.24rem 0.6rem" : "0.35rem 0.55rem",
        borderRadius: "var(--radius-full)",
        border: `1px solid ${border}`,
        background: variant === "outline" ? "transparent" : background,
        color,
        minWidth: 0,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {icon && (
        <span style={{ display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
          {icon}
        </span>
      )}
      {isTwoLine ? (
        <span style={{ display: "grid", gap: 0, minWidth: 0 }}>
          <span style={{ fontSize: "0.7rem", fontWeight: 800, lineHeight: 1.05, whiteSpace: "nowrap" }}>
            {label}
          </span>
          <span style={{ fontSize: "0.63rem", color: "var(--muted)", lineHeight: 1.1, whiteSpace: "nowrap" }}>
            {detail}
          </span>
        </span>
      ) : (
        <span
          style={{
            fontSize: size === "sm" ? "0.72rem" : "0.7rem",
            fontWeight: size === "sm" ? 900 : 800,
            lineHeight: size === "sm" ? 1 : 1.05,
          }}
        >
          {label}
        </span>
      )}
    </span>
  );
}
