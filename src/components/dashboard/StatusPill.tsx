import { CSSProperties, ReactNode } from "react";
import type { AttemptGradingSource } from "@/lib/premiumAnalytics";

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

type StatusPillTone = "primary" | "success" | "warning" | "error" | "grade" | "retake" | "muted";
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

const GRADING_EVIDENCE_COPY: Partial<Record<AttemptGradingSource, { label: string; detail: string }>> = {
  legacy_derived_current_exam: {
    label: "과거 기록 · 현재 시험지 기준 참고 채점",
    detail: "문항별 제출 채점 결과가 저장되기 전 기록으로, 현재 시험지에서 산출한 참고값입니다.",
  },
  stored_totals_only: {
    label: "문항별 채점 근거 불완전",
    detail: "문항별 결과 없이 제출 당시 저장된 총점만 표시합니다.",
  },
  incomplete_or_invalid: {
    label: "채점 근거 확인 필요",
    detail: "불완전한 문항 결과는 현재 시험지와 섞지 않고 미채점으로 표시합니다.",
  },
};

export function GradingEvidenceNote({ source }: { source?: AttemptGradingSource }) {
  const notice = source ? GRADING_EVIDENCE_COPY[source] : undefined;
  if (!notice) return null;

  return (
    <div
      role="note"
      aria-label="채점 근거 안내"
      className="grading-evidence-note"
    >
      <strong>{notice.label}</strong>
      <span>{notice.detail}</span>
    </div>
  );
}

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
  const isTwoLine = Boolean(detail);

  return (
    <span
      className={`status-pill is-${tone} is-${variant} is-${size}${className ? ` ${className}` : ""}`}
      style={style}
    >
      {icon && (
        <span className="status-pill-icon">
          {icon}
        </span>
      )}
      {isTwoLine ? (
        <span className="status-pill-copy">
          <span className="status-pill-label">{label}</span>
          <span className="status-pill-detail">{detail}</span>
        </span>
      ) : (
        <span className="status-pill-label">{label}</span>
      )}
    </span>
  );
}
