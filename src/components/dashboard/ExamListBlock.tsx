import Link from "next/link";
import { Exam } from "@/types/omr";
import { formatKoreanDate } from "@/lib/pure";

interface ExamListBlockProps {
  exams: Exam[];
}

function ArrowRightIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M3 7H11M8 4L11 7L8 10"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
      <path
        d="M7 2V12M2 7H12"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" opacity="0.35">
      <path
        d="M8 4H20L26 10V28H8V4Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M20 4V10H26"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <line x1="12" y1="16" x2="22" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <line x1="12" y1="21" x2="18" y2="21" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/* Pastel gradients cycling per exam index */
const GRADIENTS = [
  "linear-gradient(135deg, #6366f1, #8b5cf6)",
  "linear-gradient(135deg, #ec4899, #f43f5e)",
  "linear-gradient(135deg, #0ea5e9, #6366f1)",
  "linear-gradient(135deg, #10b981, #0ea5e9)",
  "linear-gradient(135deg, #f59e0b, #ef4444)",
];

export default function ExamListBlock({ exams }: ExamListBlockProps) {
  return (
    <div
      className="bento-card col-span-2"
      style={{ padding: 0, overflow: "hidden", minHeight: "auto" }}
    >
      {/* ── Sticky Header ──────────────────────────────── */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "1.4rem 1.6rem 1rem",
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
        }}
      >
        <div>
          <h3
            style={{
              fontSize: "1rem",
              fontWeight: 700,
              color: "var(--foreground)",
              letterSpacing: "-0.01em",
            }}
          >
            최근 시험
          </h3>
          <p
            style={{
              fontSize: "0.75rem",
              color: "var(--muted)",
              marginTop: "1px",
              fontWeight: 500,
            }}
          >
            {exams.length > 0 ? `총 ${exams.length}개의 시험` : "아직 시험 없음"}
          </p>
        </div>
        <Link
          href="/create"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.4rem",
            fontSize: "0.82rem",
            fontWeight: 700,
            color: "var(--primary)",
            background: "rgba(99,102,241,0.08)",
            border: "1px solid rgba(99,102,241,0.18)",
            padding: "0.45rem 0.9rem",
            borderRadius: "var(--radius-full)",
            transition: "all 0.2s",
            letterSpacing: "-0.01em",
            minHeight: 44,
          }}
        >
          <PlusIcon />
          새 시험
        </Link>
      </div>

      {/* ── Scrollable body + bottom fade ────────────── */}
      <div className="scroll-fade-wrap" style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div
          className="scroll-custom"
          style={{
            overflowY: "auto",
            maxHeight: "240px",
            padding: "0.65rem 1.6rem 2.5rem",
            display: "flex",
            flexDirection: "column",
            gap: "0.55rem",
          }}
        >
          {exams.length === 0 ? (
            <div
              style={{
                textAlign: "center",
                padding: "3.5rem 2rem",
                color: "var(--muted)",
                background: "var(--background)",
                borderRadius: "var(--radius-lg)",
                border: "1px dashed var(--border)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: "0.75rem",
              }}
            >
              <FileIcon />
              <span style={{ fontSize: "0.9rem", fontWeight: 500 }}>
                아직 출제한 시험이 없습니다
              </span>
            </div>
          ) : (
            exams.slice(0, 8).map((exam, idx) => (
              <div
                key={exam.id}
                className="card-hover"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "1rem",
                  padding: "0.85rem 1rem",
                  borderRadius: "var(--radius-lg)",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  transition: "all 0.2s",
                  position: "relative",
                }}
              >
                {/* Gradient avatar */}
                <div
                  style={{
                    width: "40px",
                    height: "40px",
                    borderRadius: "var(--radius-md)",
                    background: GRADIENTS[idx % GRADIENTS.length],
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "white",
                    fontWeight: 900,
                    fontSize: "1rem",
                    flexShrink: 0,
                    boxShadow: "0 4px 10px rgba(0,0,0,0.15)",
                    letterSpacing: "-0.02em",
                  }}
                >
                  {exam.title.replace(/^\[.*?\]\s*/, "").charAt(0) ||
                    exam.title.charAt(0)}
                </div>

                {/* Text */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 700,
                      fontSize: "0.9rem",
                      color: "var(--foreground)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      letterSpacing: "-0.01em",
                    }}
                  >
                    {exam.title}
                  </div>
                  <div
                    style={{
                      fontSize: "0.75rem",
                      color: "var(--muted)",
                      marginTop: "2px",
                      fontWeight: 500,
                    }}
                  >
                    {formatKoreanDate(exam.createdAt)}
                  </div>
                </div>

                {/* Meta */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "0.75rem",
                    flexShrink: 0,
                  }}
                >
                  <div
                    style={{
                      textAlign: "right",
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: "3px",
                    }}
                  >
                    <span
                      style={{
                        fontSize: "0.8rem",
                        fontWeight: 700,
                        color: "var(--foreground)",
                      }}
                    >
                      {exam.questions.length}
                      <span
                        style={{
                          fontWeight: 500,
                          color: "var(--muted)",
                          marginLeft: "2px",
                          fontSize: "0.72rem",
                        }}
                      >
                        문항
                      </span>
                    </span>
                    <span
                      className={
                        exam.accessConfig?.type === "group"
                          ? "badge badge-primary"
                          : "badge badge-success"
                      }
                      style={{ padding: "1px 7px", fontSize: "0.68rem" }}
                    >
                      {exam.accessConfig?.type === "group" ? "클래스" : "공개"}
                    </span>
                  </div>

                  <Link
                    href={`/teacher/exam/${exam.id}`}
                    aria-label={`${exam.title} 시험 상세 보기`}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "44px",
                      height: "44px",
                      borderRadius: "var(--radius-md)",
                      color: "var(--muted)",
                      background: "var(--background)",
                      border: "1px solid var(--border)",
                      transition: "all 0.2s",
                      flexShrink: 0,
                    }}
                    onMouseEnter={(e) => {
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--primary)";
                      (e.currentTarget as HTMLElement).style.borderColor =
                        "rgba(99,102,241,0.4)";
                      (e.currentTarget as HTMLElement).style.background =
                        "rgba(99,102,241,0.06)";
                    }}
                    onMouseLeave={(e) => {
                      (e.currentTarget as HTMLElement).style.color =
                        "var(--muted)";
                      (e.currentTarget as HTMLElement).style.borderColor =
                        "var(--border)";
                      (e.currentTarget as HTMLElement).style.background =
                        "var(--background)";
                    }}
                  >
                    <ArrowRightIcon />
                  </Link>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Footer ─────────────────────────────────────── */}
      {exams.length > 5 && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            padding: "0.75rem 1.6rem",
            display: "flex",
            justifyContent: "center",
            background: "var(--surface)",
            position: "relative",
            zIndex: 3,
          }}
        >
          <Link
            href="/teacher/dashboard?tab=exam"
            style={{
              fontSize: "0.8rem",
              color: "var(--muted)",
              fontWeight: 600,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.3rem",
              minHeight: "44px",
              padding: "0 0.65rem",
              transition: "color 0.2s",
            }}
            onMouseEnter={(e) =>
              ((e.currentTarget as HTMLElement).style.color = "var(--primary)")
            }
            onMouseLeave={(e) =>
              ((e.currentTarget as HTMLElement).style.color = "var(--muted)")
            }
          >
            전체 보기
            <ArrowRightIcon />
          </Link>
        </div>
      )}
    </div>
  );
}
