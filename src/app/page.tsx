"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Attempt, Group } from "@/types/omr";
import ThemeToggle from "@/components/ThemeToggle";
import { toast } from "@/components/Toast";
import { getOrCreateGuestId, loadAttempts, makeStudentId, saveSession } from "@/utils/storage";

// 6-char alphanumeric code — avoids ambiguous chars (0/O, 1/I).
function generateStartCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 6; i++) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
}

/* ─── SVG Icons ──────────────────────────────────────── */

function StudentIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {/* Mortarboard top (diamond shape) */}
      <path d="M24 8L43 18L24 28L5 18L24 8Z" strokeWidth="2.3" />
      {/* Inner cap highlight line */}
      <path d="M12 19L24 25L36 19" strokeWidth="1.5" strokeOpacity="0.4" />
      {/* Hood/cap band under the mortarboard */}
      <path d="M14 23V32C14 35.3 18.5 37 24 37C29.5 37 34 35.3 34 32V23" strokeWidth="2.3" />
      {/* Tassel cord */}
      <path d="M43 18V30" strokeWidth="2.3" />
      {/* Tassel dot */}
      <circle cx="43" cy="33" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TeacherIcon({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      {/* Book/clipboard base */}
      <path d="M10 8C10 7 10.5 6.5 11.5 6.5H34.5C35.5 6.5 36 7 36 8V36C36 37 35.5 37.5 34.5 37.5H11.5C10.5 37.5 10 37 10 36V8Z" strokeWidth="2.2" />
      {/* Book spine vertical line */}
      <path d="M10 8V36" strokeWidth="2.2" strokeOpacity="0.4" />
      {/* Content lines on book */}
      <path d="M16 15H30" strokeWidth="2.2" />
      <path d="M16 21H26" strokeWidth="2.2" />
      <path d="M16 27H28" strokeWidth="2.2" />
      {/* Pen / marker overlapping bottom-right */}
      <path d="M36 32L42 38L40 41L34 35L36 32Z" strokeWidth="2.2" />
      <path d="M34 35L31 41L37 39L36 32" strokeWidth="2.2" strokeOpacity="0.6" />
    </svg>
  );
}

function ChevronRight({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M6 12L10 8L6 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronLeft({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
      <path d="M10 12L6 8L10 4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/* ─── Page ───────────────────────────────────────────── */

export default function Home() {
  const router = useRouter();
  const [role, setRole] = useState<"none" | "teacher" | "student">("none");
  const [studentName, setStudentName] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  // Anti-spoof: require a start-code for returning students.
  const [startCode, setStartCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem("omr_groups");
    // Hydrate client-only localStorage state after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setGroups(JSON.parse(stored));
  }, []);

  // Surface the start-code field proactively for returning students.
  useEffect(() => {
    if (role !== "student" || !studentName.trim() || !selectedGroupId) {
      // Derived from client-only localStorage inputs.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNeedsCode(false);
      return;
    }
    try {
      const raw = localStorage.getItem("omr_student_codes");
      if (!raw) {
        setNeedsCode(false);
        return;
      }
      const codes: Record<string, string> = JSON.parse(raw);
      const sid = makeStudentId(studentName, selectedGroupId);
      setNeedsCode(!!codes[sid]);
    } catch {
      setNeedsCode(false);
    }
  }, [role, studentName, selectedGroupId]);

  const handleTeacherLogin = () => {
    if (password === "admin123") {
      router.push("/teacher/dashboard");
    } else {
      setError("잘못된 비밀번호입니다.");
      setTimeout(() => setError(""), 2000);
    }
  };

  const handleStudentLogin = () => {
    if (!studentName.trim() || !selectedGroupId) {
      setError("이름과 반을 모두 입력해주세요.");
      setTimeout(() => setError(""), 2000);
      return;
    }
    const group = groups.find((g) => g.id === selectedGroupId);
    const sid = makeStudentId(studentName, selectedGroupId);

    // Load existing start-code registry + attempts to decide anti-spoof path.
    let codes: Record<string, string> = {};
    try {
      const raw = localStorage.getItem("omr_student_codes");
      if (raw) codes = JSON.parse(raw);
    } catch { /* ignore */ }

    const attempts: Attempt[] = loadAttempts();

    const hasPriorAttempt = attempts.some(a => a.studentId === sid
      || (a.studentName === studentName.trim() && !a.guestId));
    const storedCode = codes[sid];

    // CASE 1: returning student — must enter their start code.
    if (storedCode && hasPriorAttempt) {
      if (!startCode.trim()) {
        setNeedsCode(true);
        setError("이미 등록된 학생입니다. 시작 코드를 입력해주세요.");
        setTimeout(() => setError(""), 2500);
        return;
      }
      if (startCode.trim().toUpperCase() !== storedCode) {
        setError("시작 코드가 일치하지 않습니다.");
        setTimeout(() => setError(""), 2500);
        return;
      }
    } else if (!storedCode) {
      // CASE 2: brand-new student — mint + show their code.
      const fresh = generateStartCode();
      codes[sid] = fresh;
      try {
        localStorage.setItem("omr_student_codes", JSON.stringify(codes));
      } catch { /* ignore quota */ }
      toast.success(
        "시작 코드 발급",
        `다음 로그인 시 이 코드를 입력하세요: ${fresh}`
      );
    }

    const session = {
      name: studentName.trim(),
      studentId: sid,
      groupId: selectedGroupId,
      groupName: group?.name || "Unknown",
    };
    saveSession(session);
    router.push("/student/dashboard");
  };

  const handleGuest = () => {
    const guestId = getOrCreateGuestId();
    const session = { name: "Guest Student", isGuest: true, guestId, groupName: "Guest Mode" };
    saveSession(session);
    router.push("/student/dashboard");
  };

  const handleBack = () => {
    setRole("none");
    setError("");
    setPassword("");
    setStudentName("");
    setSelectedGroupId("");
    setStartCode("");
    setNeedsCode(false);
  };

  return (
    <div className="layout-main center-content" style={{ position: "relative" }}>
      {/* Animated background orbs */}
      <div className="orb orb-primary" />
      <div className="orb orb-secondary" />
      <div className="orb orb-accent" />

      {/* Theme toggle */}
      <div style={{ position: "fixed", top: "1.25rem", right: "1.25rem", zIndex: 10 }}>
        <ThemeToggle />
      </div>

      <div
        className="container animate-fade-in"
        style={{ maxWidth: "960px", position: "relative", zIndex: 1, padding: "3rem 1.5rem" }}
      >
        {/* ── Hero ───────────────────────────── */}
        <div style={{ textAlign: "center", marginBottom: "4rem" }}>
          <div
            className="badge badge-primary stagger-1 animate-fade-in"
            style={{ marginBottom: "1.75rem", opacity: 0 }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <circle cx="4" cy="4" r="4" />
            </svg>
            Smart Evaluation Platform
          </div>

          <h1
            className="title-gradient stagger-2 animate-fade-in"
            style={{
              fontSize: "clamp(3.2rem, 8vw, 5.5rem)",
              lineHeight: 1.04,
              letterSpacing: "-0.045em",
              fontWeight: 900,
              marginBottom: "1.25rem",
              opacity: 0,
            }}
          >
            OMR Maker
          </h1>

          <p
            className="stagger-3 animate-fade-in"
            style={{
              fontSize: "1.15rem",
              color: "var(--muted)",
              fontWeight: 400,
              lineHeight: 1.65,
              maxWidth: "480px",
              margin: "0 auto",
              opacity: 0,
              wordBreak: "keep-all",
              wordWrap: "break-word",
            }}
          >
            교사와 학생을 위한 스마트 평가 플랫폼.
          </p>
        </div>

        {/* ── Role Selection ─────────────────── */}
        {role === "none" && (
          <div
            className="stagger-4 animate-fade-in"
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
              gap: "1.5rem",
              opacity: 0,
            }}
          >
            {/* Student */}
            <button
              onClick={() => setRole("student")}
              className="glass-panel card-hover"
              style={{
                padding: "2.75rem 2.25rem",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                cursor: "pointer",
                border: "1px solid transparent",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: "180px",
                  height: "180px",
                  background:
                    "radial-gradient(circle at top right, rgba(236,72,153,0.1), transparent 70%)",
                  pointerEvents: "none",
                }}
              />

              <div className="icon-wrap icon-wrap-secondary" style={{ marginBottom: "1.5rem" }}>
                <StudentIcon size={38} />
              </div>

              <h2
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  marginBottom: "0.5rem",
                  color: "var(--foreground)",
                  letterSpacing: "-0.02em",
                }}
              >
                학생
              </h2>
              <p
                style={{
                  color: "var(--muted)",
                  fontSize: "0.95rem",
                  lineHeight: 1.65,
                  marginBottom: "2rem",
                }}
              >
                배정된 시험에 참여하고 결과를 확인하세요.
              </p>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  color: "var(--secondary)",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  marginTop: "auto",
                }}
              >
                시작하기
                <ChevronRight />
              </div>
            </button>

            {/* Teacher */}
            <button
              onClick={() => setRole("teacher")}
              className="glass-panel card-hover"
              style={{
                padding: "2.75rem 2.25rem",
                textAlign: "left",
                display: "flex",
                flexDirection: "column",
                alignItems: "flex-start",
                cursor: "pointer",
                border: "1px solid transparent",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  position: "absolute",
                  top: 0,
                  right: 0,
                  width: "180px",
                  height: "180px",
                  background:
                    "radial-gradient(circle at top right, rgba(99,102,241,0.1), transparent 70%)",
                  pointerEvents: "none",
                }}
              />

              <div className="icon-wrap icon-wrap-primary" style={{ marginBottom: "1.5rem" }}>
                <TeacherIcon size={38} />
              </div>

              <h2
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  marginBottom: "0.5rem",
                  color: "var(--foreground)",
                  letterSpacing: "-0.02em",
                }}
              >
                교사
              </h2>
              <p
                style={{
                  color: "var(--muted)",
                  fontSize: "0.95rem",
                  lineHeight: 1.65,
                  marginBottom: "2rem",
                }}
              >
                시험을 출제하고 배포하며 학생 성취도를 분석하세요.
              </p>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  color: "var(--primary)",
                  fontSize: "0.9rem",
                  fontWeight: 700,
                  marginTop: "auto",
                }}
              >
                대시보드
                <ChevronRight />
              </div>
            </button>
          </div>
        )}

        {/* ── Login Forms ────────────────────── */}
        {role !== "none" && (
          <div
            className="glass-panel animate-slide-up"
            style={{ maxWidth: "440px", margin: "0 auto", padding: "2.75rem 2.5rem" }}
          >
            <button
              onClick={handleBack}
              style={{
                marginBottom: "2rem",
                fontSize: "0.88rem",
                color: "var(--muted)",
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                fontWeight: 600,
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--primary)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = "var(--muted)")}
            >
              <ChevronLeft />
              역할 선택으로
            </button>

            {role === "teacher" ? (
              <>
                {/* Teacher form */}
                <div style={{ marginBottom: "2.25rem" }}>
                  <span className="badge badge-primary" style={{ marginBottom: "1rem" }}>
                    <TeacherIcon size={12} />
                    교사 포털
                  </span>
                  <h2
                    style={{
                      fontSize: "1.85rem",
                      fontWeight: 800,
                      color: "var(--foreground)",
                      lineHeight: 1.2,
                      letterSpacing: "-0.03em",
                    }}
                  >
                    환영합니다
                  </h2>
                </div>

                <div style={{ marginBottom: "1.75rem" }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    비밀번호
                  </label>
                  <input
                    type="password"
                    className="input-field"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleTeacherLogin()}
                    placeholder="비밀번호 입력"
                    autoFocus
                  />
                  {error ? (
                    <p style={{ fontSize: "0.8rem", color: "var(--error)", marginTop: "0.5rem", fontWeight: 600 }}>
                      {error}
                    </p>
                  ) : (
                    <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "0.5rem", opacity: 0.75 }}>
                      Demo: admin123
                    </p>
                  )}
                </div>

                <button onClick={handleTeacherLogin} className="btn btn-primary" style={{ width: "100%" }}>
                  대시보드 입장
                </button>
              </>
            ) : (
              <>
                {/* Student form */}
                <div style={{ marginBottom: "2.25rem" }}>
                  <span className="badge badge-secondary" style={{ marginBottom: "1rem" }}>
                    <StudentIcon size={12} />
                    학생 포털
                  </span>
                  <h2
                    style={{
                      fontSize: "1.85rem",
                      fontWeight: 800,
                      color: "var(--foreground)",
                      lineHeight: 1.2,
                      letterSpacing: "-0.03em",
                    }}
                  >
                    학습 시작
                  </h2>
                </div>

                <div style={{ marginBottom: "1.1rem" }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    이름
                  </label>
                  <input
                    type="text"
                    className="input-field"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    placeholder="이름을 입력하세요"
                    autoFocus
                  />
                </div>

                <div style={{ marginBottom: "1.75rem" }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    반 선택
                  </label>
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="input-field"
                    style={{ cursor: "pointer" }}
                  >
                    <option value="">반을 선택하세요</option>
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                  {groups.length === 0 && (
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "var(--error)",
                        marginTop: "0.55rem",
                        background: "rgba(239,68,68,0.07)",
                        padding: "0.5rem 0.75rem",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid rgba(239,68,68,0.18)",
                        fontWeight: 600,
                      }}
                    >
                      등록된 반이 없습니다. 선생님께 문의하세요.
                    </div>
                  )}
                  {error && (
                    <p style={{ fontSize: "0.8rem", color: "var(--error)", marginTop: "0.5rem", fontWeight: 600 }}>
                      {error}
                    </p>
                  )}
                </div>

                {needsCode && (
                  <div style={{ marginBottom: "1.75rem" }}>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "0.55rem",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        color: "var(--muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                      }}
                    >
                      시작 코드
                    </label>
                    <input
                      type="text"
                      className="input-field"
                      value={startCode}
                      onChange={(e) => setStartCode(e.target.value.toUpperCase())}
                      onKeyDown={(e) => e.key === "Enter" && handleStudentLogin()}
                      placeholder="6자리 코드 입력"
                      maxLength={6}
                      style={{ letterSpacing: "0.25em", fontFamily: "monospace", textTransform: "uppercase" }}
                    />
                    <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.45rem", opacity: 0.85 }}>
                      이미 등록된 학생입니다. 처음 로그인 시 발급받은 코드를 입력해주세요.
                    </p>
                  </div>
                )}

                <button
                  onClick={handleStudentLogin}
                  className="btn btn-primary"
                  style={{
                    width: "100%",
                    background: "linear-gradient(135deg, var(--secondary), #c026d3)",
                    boxShadow: "0 4px 18px rgba(236,72,153,0.38)",
                    marginBottom: "0.75rem",
                  }}
                >
                  시험 시작하기
                </button>

                <div className="divider-label">
                  <span>또는</span>
                </div>

                <button
                  onClick={handleGuest}
                  className="btn"
                  style={{
                    width: "100%",
                    background: "transparent",
                    border: "1px solid var(--border)",
                    color: "var(--muted)",
                    fontSize: "0.92rem",
                  }}
                >
                  게스트로 계속하기
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
