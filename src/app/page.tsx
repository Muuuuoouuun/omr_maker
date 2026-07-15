"use client";

import { useState, useEffect, useMemo, useRef, type MouseEvent } from "react";
import { useRouter } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import ThemeToggle from "@/components/ThemeToggle";
import { toast } from "@/components/Toast";
import { verifyTeacherPassword } from "@/app/actions/auth";
import {
  issueGuestSession,
  issueStudentSession,
  loadStudentLoginDirectory,
  type StudentSessionIssueStatus,
} from "@/app/actions/studentSession";
import { formatRegionScopedLabel } from "@/lib/dashboardSelection";
import { seedLocalTestStudentAccounts } from "@/lib/localTestAccounts";
import { readLocalAttempts, syncMergedGuestAttempts } from "@/lib/omrPersistence";
import {
  readRosterGroups,
  readRosterStudents,
  scopedGroupKeyForStudentId,
  type RosterGroup,
  type RosterStudent,
} from "@/lib/rosterStorage";
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
  guestLoginIdFor,
  mergeGuestAttempts,
  previewGuestMerge,
  readPendingGuestMerge,
  saveSession,
  type GuestMergePreview,
  type StudentSession,
} from "@/utils/storage";
import { normalizeStudentRedirectPath } from "@/lib/studentRedirect";
import { normalizeTeacherRedirectPath, saveTeacherSessionWithIdentity } from "@/lib/teacherSession";
import { setCurrentPlan } from "@/utils/plans";

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

type StudentLoginGroupOption = Pick<RosterGroup, "id" | "name" | "region">;

function groupOptionKey(name: string | undefined, region?: string): string {
  return `${cleanText(region).toLocaleLowerCase("ko-KR")}::${cleanText(name).toLocaleLowerCase("ko-KR")}`;
}

function buildStudentLoginGroupOptions(
  groups: StudentLoginGroupOption[],
  students: RosterStudent[],
): StudentLoginGroupOption[] {
  const options = new Map<string, StudentLoginGroupOption>();

  for (const group of groups) {
    const name = cleanText(group.name);
    if (!name) continue;
    const id = cleanText(group.id) || name;
    const region = cleanText(group.region);
    options.set(groupOptionKey(name, region), region ? { id, name, region } : { id, name });
  }

  for (const student of students) {
    const name = cleanText(student.group);
    if (!name) continue;
    const region = cleanText(student.region);
    const key = groupOptionKey(name, region);
    if (options.has(key)) continue;
    const scopedGroupId = scopedGroupKeyForStudentId(student.id);
    const id = scopedGroupId || (region ? `${region}/${name}` : name);
    options.set(key, region ? { id, name, region } : { id, name });
  }

  return Array.from(options.values()).sort((a, b) =>
    formatRegionScopedLabel(a.name, a.region).localeCompare(formatRegionScopedLabel(b.name, b.region), "ko")
  );
}

function normalizedGroupCode(value: string | undefined): string {
  return cleanText(value).toLocaleLowerCase("ko-KR");
}

function resolveGuestGroupCode(
  code: string,
  groups: StudentLoginGroupOption[],
): StudentLoginGroupOption | null {
  const trimmedCode = cleanText(code);
  const normalizedCode = normalizedGroupCode(trimmedCode);
  if (!normalizedCode) return null;

  const matchedGroup = groups.find(group => {
    const candidates = [
      group.id,
      group.name,
      formatRegionScopedLabel(group.name, group.region),
      group.region ? `${group.region}/${group.name}` : "",
    ];
    return candidates.some(candidate => normalizedGroupCode(candidate) === normalizedCode);
  });

  if (matchedGroup) return matchedGroup;
  return { id: trimmedCode, name: trimmedCode };
}

function resolveSessionRegion(params: {
  name: string;
  selectedGroupId: string;
  groupName: string;
  studentId: string;
  groups: StudentLoginGroupOption[];
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

function studentLoginErrorMessage(status: StudentSessionIssueStatus): string {
  if (status === "rate_limited") return "로그인 시도가 많아 잠시 잠겼습니다. 10분 뒤 다시 시도해주세요.";
  if (status === "code_not_issued") return "시작 코드가 아직 서버에 연결되지 않았습니다. 선생님에게 코드 재발급을 요청해주세요.";
  if (status === "invalid_workspace") return "학생 초대 링크가 올바르지 않습니다. 선생님에게 새 링크를 요청해주세요.";
  if (status === "invalid_credentials") return "이름, 반, 학생번호(또는 이메일), 시작 코드를 다시 확인해주세요.";
  if (status === "unauthenticated") return "학생 세션을 시작하지 못했습니다. 다시 로그인해주세요.";
  return "학생 계정을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";
}

export default function Home() {
  const router = useRouter();
  const [role, setRole] = useState<"none" | "teacher" | "student">("none");
  const [studentName, setStudentName] = useState("");
  const [studentLookup, setStudentLookup] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [guestGroupCode, setGuestGroupCode] = useState("");
  const [groups, setGroups] = useState<RosterGroup[]>([]);
  const [rosterStudents, setRosterStudents] = useState<RosterStudent[]>([]);
  const [teacherIdentifier, setTeacherIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const studentNameInputRef = useRef<HTMLInputElement>(null);
  const [pendingGuestPreview, setPendingGuestPreview] = useState<GuestMergePreview | null>(null);
  const [recentStudentSession, setRecentStudentSession] = useState<StudentSession | null>(null);
  // Anti-spoof: require a start-code for returning students.
  const [startCode, setStartCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  // A newly issued start code acts as the student's password on their next
  // login, so it must be shown persistently (not a 3s toast) until acknowledged.
  const [issuedCodeModal, setIssuedCodeModal] = useState<{ code: string; next: string } | null>(null);
  const [copiedIssuedCode, setCopiedIssuedCode] = useState(false);
  const [needsStudentLookup, setNeedsStudentLookup] = useState(false);
  const [workspaceId, setWorkspaceId] = useState("");
  const [studentDirectoryStatus, setStudentDirectoryStatus] = useState<"local" | "loading" | "remote" | "degraded_local" | "error">("local");
  const [studentLoginPending, setStudentLoginPending] = useState(false);
  const studentGroupOptions = useMemo(
    () => buildStudentLoginGroupOptions(groups, rosterStudents),
    [groups, rosterStudents],
  );
  const requiresServerStudentVerification = !!workspaceId && studentDirectoryStatus !== "degraded_local";

  const studentRedirectPath = () => {
    if (typeof window === "undefined") return "/student/dashboard";
    return normalizeStudentRedirectPath(new URLSearchParams(window.location.search).get("next"));
  };

  useEffect(() => {
    let cancelled = false;
    let localGroups: RosterGroup[] = [];
    try {
      // Hydrate client-only localStorage state after mount.
      seedLocalTestStudentAccounts(localStorage);
      localGroups = readRosterGroups(localStorage);
      setGroups(localGroups);
      setRosterStudents(readRosterStudents(localStorage));
      const restoredSession = getSession();
      setRecentStudentSession(restoredSession && !restoredSession.isGuest ? restoredSession : null);
    } catch {
      // Keep the empty group list and show the existing teacher-contact message.
    }

    const query = new URLSearchParams(window.location.search);
    const requestedRole = query.get("role");
    if (requestedRole === "student" || requestedRole === "teacher") {
      setRole(requestedRole);
    }
    const requestedWorkspace = query.get("workspace")?.trim() || "";
    setWorkspaceId(requestedWorkspace);
    if (requestedWorkspace) {
      setGroups([]);
      setStudentDirectoryStatus("loading");
      void loadStudentLoginDirectory(requestedWorkspace).then(result => {
        if (cancelled) return;
        if (result.status === "ok") {
          const remoteGroups = (result.groups || []).map((group, index) => ({
            ...group,
            count: 0,
            avgScore: 0,
            color: ["#4f46e5", "#ec4899", "#8b5cf6", "#10b981", "#f59e0b"][index % 5],
          }));
          setGroups(remoteGroups);
          setSelectedGroupId(previous => remoteGroups.some(group => group.id === previous) ? previous : "");
          setStudentDirectoryStatus("remote");
          return;
        }
        if (result.status === "degraded_local") {
          setGroups(localGroups);
          setStudentDirectoryStatus("degraded_local");
          return;
        }
        setGroups([]);
        setSelectedGroupId("");
        setStudentDirectoryStatus("error");
      }).catch(() => {
        if (cancelled) return;
        setGroups([]);
        setSelectedGroupId("");
        setStudentDirectoryStatus("error");
      });
    }
    return () => { cancelled = true; };
  }, []);

  // Surface the start-code field proactively for returning students.
  useEffect(() => {
    if (role !== "student" || !studentName.trim()) {
      // Derived from client-only localStorage inputs.
      setNeedsCode(false);
      setNeedsStudentLookup(false);
      return;
    }
    if (requiresServerStudentVerification) {
      setNeedsStudentLookup(true);
      setNeedsCode(true);
      return;
    }
    try {
      const codes = readStudentCodes(localStorage);
      const identity = resolveStudentIdentity({
        name: studentName,
        selectedGroupId,
        groups: studentGroupOptions,
        students: rosterStudents,
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
  }, [role, studentName, studentLookup, selectedGroupId, studentGroupOptions, rosterStudents, requiresServerStudentVerification]);

  useEffect(() => {
    if (role !== "student") {
      // Derived from localStorage after role selection.
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
        // Apply the account's bound plan only when one is configured, so accounts
        // without an explicit plan keep the browser's existing (e.g. billing) plan.
        if (res.teacher?.plan) setCurrentPlan(res.teacher.plan);
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

  const finishStudentLogin = async (session: StudentSession, next: string, issuedCode?: string) => {
    const pendingGuestMerge = consumePendingGuestMerge();
    if (pendingGuestMerge) {
      const mergedCount = mergeGuestAttempts(pendingGuestMerge.guestId, {
        studentId: session.studentId,
        name: session.name,
        groupId: session.groupId,
        groupName: session.groupName,
        regionId: session.regionId,
        regionName: session.regionName,
        identityType: session.identityType,
      });
      if (mergedCount > 0) {
        toast.success("게스트 기록 연결됨", `${mergedCount}개의 시험 기록을 학생 기록으로 저장했습니다.`);
        try {
          // Push reassigned attempts to the server now; failures are queued and
          // reconciled again on the dashboard, so login never blocks on sync.
          await syncMergedGuestAttempts(session.studentId, { guestId: pendingGuestMerge.guestId });
        } catch {
          // SyncFlusher retries queued attempts; dashboard reconciliation covers the rest.
        }
      } else {
        toast.info("연결할 새 게스트 기록 없음", "이후 제출 기록은 학생 기록으로 저장됩니다.");
      }
    }

    saveSession(session);
    if (issuedCode) {
      setCopiedIssuedCode(false);
      setIssuedCodeModal({ code: issuedCode, next });
      return;
    }
    router.push(next);
  };

  const handleStudentLogin = async () => {
    if (studentLoginPending) return;
    const trimmedName = studentName.trim();
    const next = normalizeStudentRedirectPath(new URLSearchParams(window.location.search).get("next"));
    if (!trimmedName) {
      setError("이름을 입력해주세요.");
      studentNameInputRef.current?.focus();
      setTimeout(() => setError(""), 2000);
      return;
    }
    if (!selectedGroupId) {
      setError("반을 선택해주세요.");
      setTimeout(() => setError(""), 2000);
      return;
    }

    if (requiresServerStudentVerification) {
      if (studentDirectoryStatus === "loading") {
        setError("학생 명단을 불러오는 중입니다. 잠시 후 다시 시도해주세요.");
        return;
      }
      if (!studentLookup.trim() || !startCode.trim()) {
        setNeedsStudentLookup(true);
        setNeedsCode(true);
        setError("학생번호(또는 이메일)와 시작 코드를 모두 입력해주세요.");
        setTimeout(() => setError(""), 2500);
        return;
      }

      setStudentLoginPending(true);
      try {
        const result = await issueStudentSession({
          workspaceId,
          name: trimmedName,
          groupId: selectedGroupId,
          studentLookup,
          startCode,
        });
        if (!result.ok || !result.identity) {
          setError(studentLoginErrorMessage(result.status));
          return;
        }
        const identity = result.identity;
        const session: StudentSession = {
          name: identity.name,
          studentId: identity.studentId,
          loginId: studentLookup.trim(),
          groupId: identity.groupId,
          groupName: identity.groupName,
          regionId: identity.regionId,
          regionName: identity.regionName,
          workspaceId,
          isGuest: false,
          identityType: "temporary",
        };
        await finishStudentLogin(session, next);
      } catch {
        setError("학생 인증 서버에 연결하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.");
      } finally {
        setStudentLoginPending(false);
      }
      return;
    }

    const students = readRosterStudents(localStorage);
    const storedGroups = readRosterGroups(localStorage);
    const loginGroups = buildStudentLoginGroupOptions(storedGroups, students);
    const identity = resolveStudentIdentity({
      name: trimmedName,
      selectedGroupId,
      groups: loginGroups,
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
      setError(identity.rosterMatchCount > 1
        ? "동명이인이 있습니다. 선생님이 알려준 학생번호 또는 이메일을 입력해주세요."
        : "명단 학생은 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.");
      setTimeout(() => setError(""), 3000);
      return;
    }
    const regionSnapshot = resolveSessionRegion({
      name: trimmedName,
      selectedGroupId: identity.groupId,
      groupName: identity.groupName,
      studentId: identity.studentId,
      groups: loginGroups,
      students,
    });
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
      setError("이미 등록된 학생입니다. 선생님이 발급한 시작 코드를 입력해주세요.");
      setTimeout(() => setError(""), 2500);
      return;
    }
    if (codeDecision.status === "code_mismatch") {
      setError("시작 코드가 일치하지 않습니다.");
      setTimeout(() => setError(""), 2500);
      return;
    }

    setStudentLoginPending(true);
    try {
      const result = await issueStudentSession({
        workspaceId: workspaceId || undefined,
        studentId: identity.studentId,
        name: trimmedName,
        groupId: selectedGroupId,
        groupName: identity.groupName,
        ...regionSnapshot,
      });
      if (!result.ok) {
        setError(studentLoginErrorMessage(result.status));
        return;
      }
      const session: StudentSession = {
        name: trimmedName,
        studentId: identity.studentId,
        loginId: identity.legacyStudentId,
        groupId: selectedGroupId,
        groupName: identity.groupName,
        ...regionSnapshot,
        workspaceId: workspaceId || undefined,
        isGuest: false,
        identityType: "temporary",
      };
      await finishStudentLogin(
        session,
        next,
        codeDecision.status === "new_code_issued" ? codeDecision.code : undefined,
      );
    } catch {
      setError("학생 세션을 시작하지 못했습니다. 브라우저와 네트워크 상태를 확인해주세요.");
    } finally {
      setStudentLoginPending(false);
    }
  };

  const startGuestSession = async (guestGroup?: StudentLoginGroupOption | null) => {
    // Server-issued guest identity (reused if a valid guest cookie exists);
    // the device-local id is only the degraded fallback.
    let guestId = "";
    try {
      const issued = await issueGuestSession();
      if (issued.ok && issued.guestId) guestId = issued.guestId;
    } catch {
      // offline/dev — fall back to the device-local guest id below
    }
    if (!guestId) guestId = getOrCreateGuestId();
    const session: StudentSession = {
      studentId: `guest:${guestId}`,
      loginId: guestLoginIdFor(guestId),
      name: "Guest Student",
      isGuest: true,
      identityType: "guest",
      guestId,
      groupId: guestGroup?.id,
      groupName: guestGroup?.name || "Guest Mode",
      ...(guestGroup?.region ? { regionId: guestGroup.region, regionName: guestGroup.region } : {}),
    };
    saveSession(session);
    localStorage.setItem("omr_guest_id", guestId);
    router.push(studentRedirectPath());
  };

  const handleGuest = () => {
    void startGuestSession();
  };

  const handleGuestWithGroupCode = () => {
    const guestGroup = resolveGuestGroupCode(guestGroupCode, studentGroupOptions);
    if (!guestGroup) {
      setError("반 코드를 입력해주세요.");
      setTimeout(() => setError(""), 2000);
      return;
    }

    void startGuestSession(guestGroup);
  };

  const handleContinueRecentStudent = () => {
    const restoredSession = getSession();
    if (restoredSession && !restoredSession.isGuest) {
      router.push(studentRedirectPath());
      return;
    }
    setRecentStudentSession(null);
    toast.info("최근 학생 정보 없음", "이름과 반으로 다시 로그인해주세요.");
  };

  const handleCopyIssuedCode = async () => {
    if (!issuedCodeModal) return;
    try {
      await navigator.clipboard.writeText(issuedCodeModal.code);
      setCopiedIssuedCode(true);
    } catch {
      setCopiedIssuedCode(false);
    }
  };

  const handleAcknowledgeIssuedCode = () => {
    const next = issuedCodeModal?.next;
    setIssuedCodeModal(null);
    if (next) router.push(next);
  };

  const handleBack = () => {
    setRole("none");
    setError("");
    setPassword("");
    setTeacherIdentifier("");
    setStudentName("");
    setStudentLookup("");
    setSelectedGroupId("");
    setGuestGroupCode("");
    setStartCode("");
    setNeedsCode(false);
    setNeedsStudentLookup(false);
  };

  const handleHomeNavigation = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    handleBack();
    setWorkspaceId("");
    setStudentDirectoryStatus("local");
    setStudentLoginPending(false);
    try {
      setGroups(readRosterGroups(localStorage));
      setRosterStudents(readRosterStudents(localStorage));
    } catch {
      setGroups([]);
      setRosterStudents([]);
    }
    router.replace("/");
  };

  return (
    <div className="layout-main center-content home-page" data-home-role={role} style={{ position: "relative" }}>
      {/* Theme toggle */}
      <div style={{ position: "fixed", top: "1.25rem", right: "1.25rem", zIndex: 10 }}>
        <ThemeToggle />
      </div>

      {role !== "none" && (
        <BrandLogo
          markOnly
          className="home-role-home-link"
          priorityLabel="역할 선택 홈으로"
          onClick={handleHomeNavigation}
        />
      )}

      {/* Persistent start-code hand-off: the code is the student's next-login
          password, so it must survive navigation and require acknowledgement. */}
      {issuedCodeModal && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="issued-code-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1.5rem",
            background: "rgba(0,0,0,0.55)",
          }}
        >
          <div className="card" style={{ maxWidth: "26rem", width: "100%", padding: "1.75rem", textAlign: "center" }}>
            <h2 id="issued-code-title" style={{ margin: 0, fontSize: "1.15rem", fontWeight: 700 }}>
              시작 코드가 발급되었습니다
            </h2>
            <p style={{ margin: "0.6rem 0 1.1rem", opacity: 0.85, fontSize: "0.92rem", lineHeight: 1.5 }}>
              다음에 다시 로그인할 때 이 코드가 필요합니다. 잊지 않도록 지금 저장하거나 적어두세요.
            </p>
            <div
              style={{
                fontSize: "1.9rem",
                fontWeight: 800,
                letterSpacing: "0.35em",
                padding: "0.9rem 0",
                borderRadius: "0.75rem",
                background: "var(--surface-2, rgba(127,127,127,0.12))",
                userSelect: "all",
              }}
            >
              {issuedCodeModal.code}
            </div>
            <div style={{ display: "flex", gap: "0.6rem", marginTop: "1.25rem" }}>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleCopyIssuedCode}
                style={{ flex: 1 }}
              >
                {copiedIssuedCode ? "복사됨 ✓" : "코드 복사"}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleAcknowledgeIssuedCode}
                style={{ flex: 1 }}
              >
                저장했어요, 계속
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        className="container animate-fade-in home-container"
        style={{ maxWidth: "960px", position: "relative", zIndex: 1, padding: "3rem 1.5rem" }}
      >
        {/* ── Hero ───────────────────────────── */}
        <div className="home-hero" style={{ textAlign: "center", marginBottom: "4rem" }}>
          <div
            className="stagger-1 animate-fade-in home-logo"
            style={{ marginBottom: "1.4rem", opacity: 0 }}
          >
            <BrandLogo
              markOnly
              className="brand-logo--hero"
              priorityLabel="역할 선택 홈으로"
              onClick={handleHomeNavigation}
            />
          </div>

          <h1
            className="title-gradient stagger-2 animate-fade-in home-title"
            style={{
              fontSize: "clamp(3.2rem, 8vw, 5.5rem)",
              lineHeight: 1.04,
              letterSpacing: 0,
              fontWeight: 900,
              marginBottom: "1rem",
              opacity: 0,
            }}
          >
            OMR Maker
          </h1>

          <div
            className="badge badge-primary stagger-3 animate-fade-in home-eyebrow"
            style={{ marginBottom: "1.15rem", opacity: 0 }}
          >
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden="true">
              <circle cx="4" cy="4" r="4" />
            </svg>
            Smart Evaluation Platform
          </div>

          <p
            className="stagger-4 animate-fade-in home-subtitle"
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
            className="stagger-5 animate-fade-in home-role-grid"
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
              className="glass-panel card-hover home-role-card"
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

              <div className="icon-wrap icon-wrap-secondary home-role-icon" style={{ marginBottom: "1.5rem" }}>
                <StudentIcon size={38} />
              </div>

              <h2
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  marginBottom: "0.5rem",
                  color: "var(--foreground)",
                  letterSpacing: 0,
                }}
              >
                학생
              </h2>
              <p
                className="home-role-description"
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
                className="home-role-action"
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
              className="glass-panel card-hover home-role-card"
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

              <div className="icon-wrap icon-wrap-primary home-role-icon" style={{ marginBottom: "1.5rem" }}>
                <TeacherIcon size={38} />
              </div>

              <h2
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  marginBottom: "0.5rem",
                  color: "var(--foreground)",
                  letterSpacing: 0,
                }}
              >
                교사
              </h2>
              <p
                className="home-role-description"
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
                className="home-role-action"
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
            className="glass-panel animate-slide-up home-login-card"
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
                minHeight: "2.75rem",
                padding: "0.45rem 0.2rem",
                borderRadius: "var(--radius-md)",
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
                      letterSpacing: 0,
                    }}
                  >
                    환영합니다
                  </h2>
                </div>

                <form
                  aria-label="교사 로그인"
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleTeacherLogin();
                  }}
                >
                <div style={{ marginBottom: "1.05rem" }}>
                  <label
                    htmlFor="teacher-identifier"
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
                    id="teacher-identifier"
                    type="text"
                    className="input-field"
                    value={teacherIdentifier}
                    onChange={(e) => setTeacherIdentifier(e.target.value)}
                    placeholder="admin 또는 teacher@example.com"
                    autoFocus
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-invalid={Boolean(error)}
                    aria-describedby="teacher-login-feedback"
                  />
                </div>

                <div style={{ marginBottom: "1.75rem" }}>
                  <label
                    htmlFor="teacher-password"
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
                    id="teacher-password"
                    type="password"
                    className="input-field"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="비밀번호 입력"
                    autoComplete="current-password"
                    aria-invalid={Boolean(error)}
                    aria-describedby="teacher-login-feedback"
                  />
                  <div
                    id="teacher-login-feedback"
                    aria-live="polite"
                    style={{ marginTop: "0.5rem", display: "grid", gap: "0.35rem" }}
                  >
                    {error ? (
                      <>
                      <p role="alert" style={{ fontSize: "0.8rem", color: "var(--error)", fontWeight: 600 }}>
                        {error}
                      </p>
                      {shouldShowTeacherDeploymentHelp(error) && (
                        <p style={{ fontSize: "0.75rem", color: "var(--muted)", lineHeight: 1.45, wordBreak: "keep-all" }}>
                          {TEACHER_AUTH_DEPLOYMENT_HELP}
                        </p>
                      )}
                      </>
                    ) : (
                    <p style={{ fontSize: "0.8rem", color: "var(--muted)", opacity: 0.75 }}>
                      교사용 계정 정보를 입력하세요.
                    </p>
                    )}
                  </div>
                </div>

                <button type="submit" className="btn btn-primary" style={{ width: "100%" }}>
                  대시보드 입장
                </button>
                </form>
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
                      letterSpacing: 0,
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
                    ref={studentNameInputRef}
                    id="student-name"
                    type="text"
                    className="input-field"
                    aria-label="이름"
                    aria-invalid={error === "이름을 입력해주세요."}
                    aria-describedby={error === "이름을 입력해주세요." ? "student-name-error" : undefined}
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    placeholder="이름을 입력하세요"
                    autoFocus
                    autoComplete="name"
                  />
                  {error === "이름을 입력해주세요." && (
                    <p
                      id="student-name-error"
                      role="alert"
                      style={{ fontSize: "0.8rem", color: "var(--error)", marginTop: "0.45rem", fontWeight: 700 }}
                    >
                      {error}
                    </p>
                  )}
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
                    aria-label="학생번호 또는 이메일"
                    value={studentLookup}
                    onChange={(e) => setStudentLookup(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleStudentLogin()}
                    placeholder="선생님이 알려준 학생번호 또는 이메일"
                    autoComplete="email"
                    autoCapitalize="none"
                    inputMode="email"
                    spellCheck={false}
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
                      ? "명단 이메일이나 선생님이 알려준 학생번호로 본인 계정을 확인합니다."
                      : "계정 ID처럼 사용합니다. 입력하면 같은 이름의 학생도 정확히 구분됩니다."}
                  </p>
                </div>

                <div style={{ marginBottom: "1.35rem" }}>
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
                  {studentGroupOptions.length > 0 ? (
                    <select
                      aria-label="반 선택"
                      value={selectedGroupId}
                      onChange={(e) => setSelectedGroupId(e.target.value)}
                      className="input-field"
                      style={{ cursor: "pointer" }}
                    >
                      <option value="">반을 선택하세요</option>
                      {studentGroupOptions.map((group) => (
                        <option key={`${group.region || ""}:${group.id}`} value={group.id}>
                          {formatRegionScopedLabel(group.name, group.region)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      className="input-field"
                      aria-label="반 코드"
                      value={selectedGroupId}
                      onChange={(e) => setSelectedGroupId(e.target.value.trim())}
                      placeholder="선생님이 알려준 반 코드"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  )}
                  {studentGroupOptions.length === 0 && (
                    <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.45rem", lineHeight: 1.45 }}>
                      등록된 반이 없으면 아래 반 코드로 게스트 시험을 시작할 수 있습니다.
                    </p>
                  )}
                </div>

                {error && error !== "이름을 입력해주세요." && (
                  <p role="alert" style={{ fontSize: "0.8rem", color: "var(--error)", marginTop: "-0.35rem", marginBottom: "1.35rem", fontWeight: 600 }}>
                    {error}
                  </p>
                )}

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

                {(needsCode || requiresServerStudentVerification) && (
                  <div style={{ marginBottom: "1.75rem" }}>
                    <label
                      style={{
                        display: "block",
                        marginBottom: "0.55rem",
                        fontSize: "0.75rem",
                        fontWeight: 700,
                        color: needsCode ? "var(--warning)" : "var(--muted)",
                        textTransform: "uppercase",
                        letterSpacing: "0.07em",
                      }}
                    >
                      시작 코드
                    </label>
                    <input
                      type="text"
                      className="input-field"
                      aria-label="시작 코드"
                      value={startCode}
                      onChange={(e) => setStartCode(normalizeStartCodeInput(e.target.value))}
                      onKeyDown={(e) => e.key === "Enter" && handleStudentLogin()}
                      placeholder="6자리 코드 입력"
                      autoComplete="one-time-code"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={6}
                      style={{ letterSpacing: "0.25em", fontFamily: "monospace", textTransform: "uppercase" }}
                    />
                    <p style={{ fontSize: "0.75rem", color: "var(--muted)", marginTop: "0.45rem", opacity: 0.85 }}>
                      학생 계정 비밀번호처럼 쓰이는 6자리 코드입니다. 분실 시 선생님에게 재발급을 요청하세요.
                    </p>
                  </div>
                )}

                <button
                  onClick={handleStudentLogin}
                  disabled={studentLoginPending || studentDirectoryStatus === "loading"}
                  className="btn btn-primary"
                  style={{
                    width: "100%",
                    background: "linear-gradient(135deg, var(--secondary), #c026d3)",
                    boxShadow: "0 4px 18px rgba(236,72,153,0.38)",
                    marginBottom: "0.35rem",
                  }}
                >
                  {studentLoginPending ? "계정 확인 중…" : "시험 시작하기"}
                </button>

                <p style={{ fontSize: "0.72rem", color: "var(--muted)", margin: "0 0 0.75rem", lineHeight: 1.45, wordBreak: "keep-all" }}>
                  {requiresServerStudentVerification
                    ? "* 선생님이 발급한 초대 링크와 시작 코드로 서버 명단을 확인합니다."
                    : "* 현재 기기에 저장된 명단과 시작 코드로 로그인합니다."}
                </p>

                <div className="divider-label">
                  <span>또는</span>
                </div>

                <div style={{ marginBottom: "0.75rem" }}>
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
                    반 코드
                  </label>
                  <input
                    type="text"
                    className="input-field"
                    value={guestGroupCode}
                    onChange={(e) => setGuestGroupCode(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleGuestWithGroupCode()}
                    placeholder="선생님이 알려준 코드"
                    autoCapitalize="characters"
                    spellCheck={false}
                  />
                </div>

                <button
                  type="button"
                  onClick={handleGuestWithGroupCode}
                  className="btn btn-primary"
                  style={{
                    width: "100%",
                    background: "linear-gradient(135deg, #6366f1, #14b8a6)",
                    boxShadow: "0 4px 18px rgba(20,184,166,0.25)",
                    marginBottom: "0.75rem",
                  }}
                >
                  반 코드로 게스트 시험보기
                </button>

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
                  코드 없이 게스트로 계속하기
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
