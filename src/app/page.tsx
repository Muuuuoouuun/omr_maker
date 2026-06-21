"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import ThemeToggle from "@/components/ThemeToggle";
import { toast } from "@/components/Toast";
import { verifyTeacherPassword } from "@/app/actions/auth";
import { formatRegionScopedLabel } from "@/lib/dashboardSelection";
import { readLocalAttempts } from "@/lib/omrPersistence";
import { readRosterGroups, readRosterStudents, type RosterGroup, type RosterStudent } from "@/lib/rosterStorage";
import { TEACHER_AUTH_DEPLOYMENT_HELP, shouldShowTeacherDeploymentHelp } from "@/lib/teacherAuthMessages";
import {
  hasStudentStartCode,
  normalizeStartCodeInput,
  readStudentCodes,
  resolveStudentIdentity,
  resolveStudentStartCodeLogin,
  writeStudentCodes,
} from "@/lib/studentCodes";
import {
  consumePendingGuestMerge,
  getSession,
  getOrCreateGuestId,
  mergeGuestAttempts,
  previewGuestMerge,
  readPendingGuestMerge,
  saveSession,
  type GuestMergePreview,
  type StudentSession,
} from "@/utils/storage";
import { normalizeTeacherRedirectPath, saveTeacherSessionWithIdentity } from "@/lib/teacherSession";

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

function cleanText(value: string | undefined): string {
  return value?.trim() || "";
}

function resolveSessionRegion(params: {
  name: string;
  selectedGroupId: string;
  groupName: string;
  studentId: string;
  groups: RosterGroup[];
  students: RosterStudent[];
}): Pick<StudentSession, "regionId" | "regionName"> {
  const group = params.groups.find(item => item.id === params.selectedGroupId || item.name === params.groupName);
  const groupRegion = cleanText(group?.region);
  const matchingStudents = params.students.filter(item => item.name.trim() === params.name && item.group === params.groupName);
  const student = params.students.find(item => item.id === params.studentId)
    || (groupRegion ? matchingStudents.find(item => cleanText(item.region) === groupRegion) : undefined)
    || matchingStudents[0];
  const regionName = cleanText(student?.region) || cleanText(group?.region);

  return regionName ? { regionId: regionName, regionName } : {};
}

export default function Home() {
  const router = useRouter();
  const [role, setRole] = useState<"none" | "teacher" | "student">("none");
  const [studentName, setStudentName] = useState("");
  const [studentLookup, setStudentLookup] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groups, setGroups] = useState<RosterGroup[]>([]);
  const [teacherIdentifier, setTeacherIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [pendingGuestPreview, setPendingGuestPreview] = useState<GuestMergePreview | null>(null);
  const [recentStudentSession, setRecentStudentSession] = useState<StudentSession | null>(null);
  // Anti-spoof: require a start-code for returning students.
  const [startCode, setStartCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [needsStudentLookup, setNeedsStudentLookup] = useState(false);

  useEffect(() => {
    try {
      // Hydrate client-only localStorage state after mount.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroups(readRosterGroups(localStorage));
      const restoredSession = getSession();
      setRecentStudentSession(restoredSession && !restoredSession.isGuest ? restoredSession : null);
    } catch {
      // Keep the empty group list and show the existing teacher-contact message.
    }

    const requestedRole = new URLSearchParams(window.location.search).get("role");
    if (requestedRole === "student" || requestedRole === "teacher") {
      setRole(requestedRole);
    }
  }, []);

  // Surface the start-code field proactively for returning students.
  useEffect(() => {
    if (role !== "student" || !studentName.trim() || !selectedGroupId) {
      // Derived from client-only localStorage inputs.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setNeedsCode(false);
      setNeedsStudentLookup(false);
      return;
    }
    try {
      const codes = readStudentCodes(localStorage);
      const students = readRosterStudents(localStorage);
      const identity = resolveStudentIdentity({
        name: studentName,
        selectedGroupId,
        groups,
        students,
        studentLookup,
      });
      const lookupRequired = identity.requiresStudentLookup || identity.lookupMismatch;
      setNeedsStudentLookup(lookupRequired);
      if (lookupRequired) {
        setNeedsCode(false);
        return;
      }
      setNeedsCode(hasStudentStartCode(codes, identity.studentId, identity.legacyStudentId));
    } catch {
      setNeedsCode(false);
      setNeedsStudentLookup(false);
    }
  }, [role, studentName, studentLookup, selectedGroupId, groups]);

  useEffect(() => {
    if (role !== "student") {
      // Derived from localStorage after role selection.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingGuestPreview(null);
      return;
    }
    try {
      const pending = readPendingGuestMerge();
      const preview = pending ? previewGuestMerge(pending.guestId) : null;
      setPendingGuestPreview(preview && preview.mergeableCount > 0 ? preview : null);
    } catch {
      setPendingGuestPreview(null);
    }
  }, [role]);

  const handleTeacherLogin = async () => {
    try {
      const identifier = teacherIdentifier.trim();
      if (!identifier || !password.trim()) {
        setError("아이디와 비밀번호를 모두 입력해주세요.");
        setTimeout(() => setError(""), 2000);
        return;
      }

      const res = await verifyTeacherPassword(identifier, password);
      if (res.success && res.token) {
        const saved = saveTeacherSessionWithIdentity(res.token, res.teacher);
        if (!saved) {
          setError("브라우저 세션 저장을 사용할 수 없습니다.");
          setTimeout(() => setError(""), 2000);
          return;
        }
        const next = normalizeTeacherRedirectPath(new URLSearchParams(window.location.search).get("next"));
        router.push(next);
      } else {
        setError(res.error || "잘못된 비밀번호입니다.");
        setTimeout(() => setError(""), 2000);
      }
    } catch {
      setError("서버 인증 도중 오류가 발생했습니다.");
      setTimeout(() => setError(""), 2000);
    }
  };

  const handleStudentLogin = () => {
    const trimmedName = studentName.trim();
    if (!trimmedName || !selectedGroupId) {
      setError("이름과 반을 모두 입력해주세요.");
      setTimeout(() => setError(""), 2000);
      return;
    }
    const students = readRosterStudents(localStorage);
    const identity = resolveStudentIdentity({
      name: trimmedName,
      selectedGroupId,
      groups,
      students,
      studentLookup,
    });
    if (identity.lookupMismatch) {
      setNeedsStudentLookup(true);
      setError("학생번호 또는 이메일이 명단과 일치하지 않습니다.");
      setTimeout(() => setError(""), 2500);
      return;
    }
    if (identity.requiresStudentLookup) {
      setNeedsStudentLookup(true);
      setError("동명이인이 있습니다. 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.");
      setTimeout(() => setError(""), 3000);
      return;
    }
    const regionSnapshot = resolveSessionRegion({
      name: trimmedName,
      selectedGroupId,
      groupName: identity.groupName,
      studentId: identity.studentId,
      groups,
      students,
    });

    // Load existing start-code registry + attempts to decide anti-spoof path.
    const codes = readStudentCodes(localStorage);
    const attempts = readLocalAttempts();

    const hasPriorAttempt = attempts.some(a => a.studentId === identity.studentId
      || a.studentId === identity.legacyStudentId
      || (
        a.studentName === trimmedName
        && !a.guestId
        && (!a.groupName || a.groupName === identity.groupName || a.groupId === identity.groupId)
      ));

    const codeDecision = resolveStudentStartCodeLogin({
      studentId: identity.studentId,
      legacyStudentId: identity.legacyStudentId,
      codes,
      hasPriorAttempt,
      providedCode: startCode,
    });

    if (codeDecision.codesChanged && !writeStudentCodes(localStorage, codeDecision.codes)) {
      setError("시작 코드 저장에 실패했습니다. 브라우저 저장소를 확인해주세요.");
      setTimeout(() => setError(""), 2500);
      return;
    }

    if (codeDecision.status === "code_required") {
      setNeedsCode(true);
      setError("이미 등록된 학생입니다. 시작 코드를 입력해주세요.");
      setTimeout(() => setError(""), 2500);
      return;
    }

    if (codeDecision.status === "code_mismatch") {
      setError("시작 코드가 일치하지 않습니다.");
      setTimeout(() => setError(""), 2500);
      return;
    }

    if (codeDecision.status === "new_code_issued") {
      toast.success(
        "시작 코드 발급",
        `다음 로그인 시 이 코드를 입력하세요: ${codeDecision.code}`
      );
    }

    const session: StudentSession = {
      name: trimmedName,
      studentId: identity.studentId,
      loginId: identity.legacyStudentId,
      groupId: selectedGroupId,
      groupName: identity.groupName,
      ...regionSnapshot,
      isGuest: false,
      identityType: "temporary",
    };

    const pendingGuestMerge = consumePendingGuestMerge();
    if (pendingGuestMerge) {
      const mergedCount = mergeGuestAttempts(pendingGuestMerge.guestId, {
        studentId: identity.studentId,
        name: trimmedName,
        groupId: selectedGroupId,
        groupName: identity.groupName,
        ...regionSnapshot,
        identityType: "temporary",
      });
      if (mergedCount > 0) {
        toast.success("게스트 기록 연결됨", `${mergedCount}개의 시험 기록을 학생 기록으로 저장했습니다.`);
      } else {
        toast.info("연결할 새 게스트 기록 없음", "이후 제출 기록은 학생 기록으로 저장됩니다.");
      }
    }

    saveSession(session);
    router.push("/student/dashboard");
  };

  const handleGuest = () => {
    const guestId = getOrCreateGuestId();
    const session: StudentSession = {
      studentId: `guest:${guestId}`,
      name: "Guest Student",
      isGuest: true,
      identityType: "guest",
      guestId,
      groupName: "Guest Mode",
    };
    saveSession(session);
    localStorage.setItem("omr_guest_id", guestId);
    router.push("/student/dashboard");
  };

  const handleContinueRecentStudent = () => {
    const restoredSession = getSession();
    if (restoredSession && !restoredSession.isGuest) {
      router.push("/student/dashboard");
      return;
    }
    setRecentStudentSession(null);
    toast.info("최근 학생 정보 없음", "이름과 반으로 다시 로그인해주세요.");
  };

  const handleBack = () => {
    setRole("none");
    setError("");
    setPassword("");
    setTeacherIdentifier("");
    setStudentName("");
    setStudentLookup("");
    setSelectedGroupId("");
    setStartCode("");
    setNeedsCode(false);
    setNeedsStudentLookup(false);
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
          <Image
            src="/logo.png"
            alt=""
            width={112}
            height={112}
            priority
            className="stagger-1 animate-fade-in"
            style={{
              width: 112,
              height: 112,
              objectFit: "contain",
              margin: "0 auto 1.25rem",
              opacity: 0,
              filter: "drop-shadow(0 18px 35px rgba(15, 23, 42, 0.14))",
            }}
          />
          <div
            className="badge badge-primary stagger-2 animate-fade-in"
            style={{ marginBottom: "1.75rem", opacity: 0 }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <circle cx="4" cy="4" r="4" />
            </svg>
            Smart Evaluation Platform
          </div>

          <h1
            className="title-gradient stagger-3 animate-fade-in"
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
            className="stagger-4 animate-fade-in"
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
              type="button"
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
              type="button"
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

        {role === "none" && recentStudentSession && (
          <div
            className="glass-panel animate-fade-in"
            style={{
              margin: "1.5rem auto 0",
              maxWidth: "560px",
              padding: "1rem 1.1rem",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "1rem",
              flexWrap: "wrap",
              border: "1px solid rgba(236,72,153,0.18)",
              background: "rgba(236,72,153,0.06)",
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: "0.82rem", fontWeight: 850, color: "var(--secondary)", marginBottom: "0.2rem" }}>
                최근 학생
              </div>
              <div style={{ fontSize: "0.94rem", fontWeight: 800, color: "var(--foreground)" }}>
                {recentStudentSession.name}
                <span style={{ color: "var(--muted)", fontWeight: 600 }}>
                  {" · "}{recentStudentSession.regionName ? `${recentStudentSession.regionName} ` : ""}{recentStudentSession.groupName || "반 미지정"}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={handleContinueRecentStudent}
              className="btn btn-primary"
              style={{
                background: "linear-gradient(135deg, var(--secondary), #c026d3)",
                boxShadow: "0 4px 18px rgba(236,72,153,0.25)",
                padding: "0.65rem 1rem",
                fontSize: "0.88rem",
                flexShrink: 0,
              }}
            >
              이어가기
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

                <div style={{ marginBottom: "1.05rem" }}>
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
                    아이디 또는 이메일
                  </label>
                  <input
                    type="text"
                    className="input-field"
                    value={teacherIdentifier}
                    onChange={(e) => setTeacherIdentifier(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleTeacherLogin()}
                    placeholder="admin 또는 teacher@example.com"
                    autoFocus
                    autoComplete="username"
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
                    비밀번호
                  </label>
                  <input
                    type="password"
                    className="input-field"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleTeacherLogin()}
                    placeholder="비밀번호 입력"
                    autoComplete="current-password"
                  />
                  {error ? (
                    <div style={{ marginTop: "0.5rem", display: "grid", gap: "0.35rem" }}>
                      <p style={{ fontSize: "0.8rem", color: "var(--error)", fontWeight: 600 }}>
                        {error}
                      </p>
                      {shouldShowTeacherDeploymentHelp(error) && (
                        <p style={{ fontSize: "0.75rem", color: "var(--muted)", lineHeight: 1.45, wordBreak: "keep-all" }}>
                          {TEACHER_AUTH_DEPLOYMENT_HELP}
                        </p>
                      )}
                    </div>
                  ) : (
                    <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "0.5rem", opacity: 0.75 }}>
                      교사용 계정 정보를 입력하세요.
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

                <div style={{ marginBottom: "1.1rem" }}>
                  <label
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "0.75rem",
                      fontWeight: 700,
                      color: needsStudentLookup ? "var(--warning)" : "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    학생번호 또는 이메일
                  </label>
                  <input
                    type="text"
                    className="input-field"
                    value={studentLookup}
                    onChange={(e) => setStudentLookup(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleStudentLogin()}
                    placeholder="동명이인일 때 입력"
                    autoComplete="email"
                    style={{
                      borderColor: needsStudentLookup ? "rgba(245,158,11,0.45)" : undefined,
                    }}
                  />
                  <p style={{
                    fontSize: "0.75rem",
                    color: needsStudentLookup ? "var(--warning)" : "var(--muted)",
                    marginTop: "0.45rem",
                    lineHeight: 1.45,
                    wordBreak: "keep-all",
                  }}>
                    {needsStudentLookup
                      ? "같은 이름의 학생이 있습니다. 명단 이메일이나 선생님이 알려준 학생번호를 입력하세요."
                      : "선택 입력입니다. 같은 이름이 있는 반에서만 확인용으로 사용합니다."}
                  </p>
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
                        {formatRegionScopedLabel(g.name, g.region)}
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

                {pendingGuestPreview && (
                  <div
                    style={{
                      marginBottom: "1.25rem",
                      padding: "0.85rem 0.95rem",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid rgba(99,102,241,0.2)",
                      background: "rgba(99,102,241,0.08)",
                      color: "var(--foreground)",
                    }}
                  >
                    <div style={{ fontSize: "0.82rem", fontWeight: 850, color: "var(--primary)", marginBottom: "0.25rem" }}>
                      게스트 기록 연결 예정
                    </div>
                    <p style={{ fontSize: "0.78rem", color: "var(--muted)", lineHeight: 1.55, wordBreak: "keep-all" }}>
                      로그인하면 이 기기의 게스트 제출 {pendingGuestPreview.mergeableCount}건을 학생 기록에 합칩니다.
                      {pendingGuestPreview.examTitles.length > 0 ? ` 대상: ${pendingGuestPreview.examTitles.join(", ")}` : ""}
                    </p>
                  </div>
                )}

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
                      onChange={(e) => setStartCode(normalizeStartCodeInput(e.target.value))}
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
