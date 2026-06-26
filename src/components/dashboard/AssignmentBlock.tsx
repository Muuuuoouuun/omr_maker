import Link from "next/link";
import { Exam } from "@/types/omr";

interface AssignmentBlockProps {
  exams: Array<Exam & { attemptId?: string; hasUnreadFeedback?: boolean }>;
  type: "todo" | "done";
}

function BookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <path d="M3 3C3 3 5 2 9 2C13 2 15 3 15 3V15C15 15 13 14 9 14C5 14 3 15 3 15V3Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <line x1="9" y1="2" x2="9" y2="14" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function CheckCircleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
      <circle cx="9" cy="9" r="7" stroke="currentColor" strokeWidth="1.6" />
      <path d="M5.5 9L7.5 11L12.5 6.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CelebrationIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <path d="M8 32L20 8L32 32H8Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" opacity="0.3" />
      <circle cx="30" cy="10" r="3" stroke="currentColor" strokeWidth="2" opacity="0.5" />
      <circle cx="10" cy="14" r="2" stroke="currentColor" strokeWidth="2" opacity="0.4" />
      <path d="M16 20L20 16L24 20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function FolderIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none">
      <path d="M6 14C6 12.9 6.9 12 8 12H16L20 16H32C33.1 16 34 16.9 34 18V30C34 31.1 33.1 32 32 32H8C6.9 32 6 31.1 6 30V14Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" opacity="0.4" />
    </svg>
  );
}

export default function AssignmentBlock({ exams, type }: AssignmentBlockProps) {
  const isTodo = type === "todo";

  return (
    <div className={`bento-card ${isTodo ? "col-span-2 row-span-2" : "col-span-2 row-span-1"}`}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.25rem",
        }}
      >
        <h3
          style={{
            fontSize: "1.1rem",
            fontWeight: 700,
            display: "flex",
            alignItems: "center",
            gap: "0.6rem",
            color: "var(--foreground)",
          }}
        >
          <span
            style={{
              display: "flex",
              alignItems: "center",
              color: isTodo ? "var(--primary)" : "var(--success)",
              opacity: 0.8,
            }}
          >
            {isTodo ? <BookIcon /> : <CheckCircleIcon />}
          </span>
          {isTodo ? "미완료 과제" : "완료 기록"}
          {isTodo && exams.length > 0 && (
            <span
              style={{
                background: "var(--error)",
                color: "white",
                fontSize: "0.72rem",
                fontWeight: 700,
                padding: "2px 8px",
                borderRadius: "var(--radius-full)",
                lineHeight: 1.5,
              }}
            >
              {exams.length}
            </span>
          )}
        </h3>
      </div>

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "0.85rem",
          overflowY: "auto",
          flex: 1,
          paddingRight: "0.25rem",
        }}
      >
        {exams.length === 0 ? (
          <div
            style={{
              textAlign: "center",
              padding: "3rem 2rem",
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
            <div style={{ opacity: 0.35, color: "var(--muted)" }}>
              {isTodo ? <CelebrationIcon /> : <FolderIcon />}
            </div>
            <span style={{ fontSize: "0.9rem", fontWeight: 500 }}>
              {isTodo ? "모든 과제를 완료했습니다!" : "아직 완료한 시험이 없습니다."}
            </span>
          </div>
        ) : (
          exams.map((exam) => (
            <div
              key={exam.id}
              className={isTodo ? "card-hover" : ""}
              style={{
                padding: "1.1rem 1.25rem",
                borderRadius: "var(--radius-lg)",
                border: "1px solid var(--border)",
                background: isTodo ? "var(--surface)" : "var(--background)",
                display: "flex",
                alignItems: "center",
                gap: "1rem",
                transition: "all 0.2s",
                opacity: isTodo ? 1 : 0.75,
              }}
            >
              <div
                style={{
                  width: "44px",
                  height: "44px",
                  borderRadius: "var(--radius-md)",
                  background: isTodo
                    ? "linear-gradient(135deg, var(--primary), var(--secondary))"
                    : "var(--border)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "white",
                  fontWeight: 800,
                  fontSize: "1.1rem",
                  flexShrink: 0,
                  boxShadow: isTodo ? "0 4px 10px rgba(99,102,241,0.28)" : "none",
                }}
              >
                {exam.title.substring(0, 1)}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: "0.98rem",
                    color: "var(--foreground)",
                    marginBottom: "0.2rem",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {exam.title}
                </div>
                <div
                  style={{
                    fontSize: "0.82rem",
                    color: "var(--muted)",
                    display: "flex",
                    gap: "0.5rem",
                    alignItems: "center",
                  }}
                >
                  <span>{exam.questions.length}문항</span>
                  <span
                    style={{
                      width: "3px",
                      height: "3px",
                      background: "var(--muted)",
                      borderRadius: "50%",
                      flexShrink: 0,
                    }}
                  />
                  <span
                    className={
                      exam.accessConfig?.type === "group" ? "badge badge-primary" : "badge badge-success"
                    }
                    style={{ padding: "1px 7px", fontSize: "0.7rem" }}
                  >
                    {exam.accessConfig?.type === "group" ? "클래스" : "공개"}
                  </span>
                  {!isTodo && exam.hasUnreadFeedback && (
                    <span
                      style={{
                        color: "#4f46e5",
                        background: "#eef2ff",
                        border: "1px solid #c7d2fe",
                        borderRadius: "999px",
                        padding: "1px 7px",
                        fontSize: "0.7rem",
                        fontWeight: 900,
                        whiteSpace: "nowrap",
                      }}
                    >
                      New feedback
                    </span>
                  )}
                </div>
              </div>

              {isTodo ? (
                <Link
                  href={`/solve/${exam.id}`}
                  className="btn btn-primary"
                  style={{ padding: "0.55rem 1.1rem", fontSize: "0.88rem", flexShrink: 0 }}
                >
                  시작
                </Link>
              ) : (
                <Link
                  href={`/student/review/${exam.attemptId || exam.id}`}
                  className="btn btn-secondary"
                  style={{ padding: "0.5rem 1rem", fontSize: "0.85rem", flexShrink: 0 }}
                >
                  복습
                </Link>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
