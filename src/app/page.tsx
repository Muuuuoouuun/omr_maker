"use client";

import { useState, useEffect, useMemo, useRef, type MouseEvent } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import ThemeToggle from "@/components/ThemeToggle";
import StudentDirectLoginForm from "@/components/StudentDirectLoginForm";
import { toast } from "@/components/Toast";
import { startMockupTeacherSession, verifyTeacherPassword } from "@/app/actions/auth";
import {
  confirmTeacherSignupEmail,
  finishTeacherPasswordReset,
  requestTeacherPasswordReset,
  requestTeacherSignup,
} from "@/app/actions/teacherAccount";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Circle,
  FileBadge2,
  GraduationCap,
  Sparkles,
  Users,
} from "lucide-react";
import {
  issueGuestSession,
  issueStudentSession,
  loadStudentLoginDirectory,
  refreshStudentSession,
  type StudentSessionIssueResult,
  type StudentSessionIssueStatus,
} from "@/app/actions/studentSession";
import { formatRegionScopedLabel } from "@/lib/dashboardSelection";
import { seedLocalTestStudentAccounts } from "@/lib/localTestAccounts";
import { readLocalAttempts } from "@/lib/omrPersistence";
import {
  readRosterGroups,
  readRosterStudents,
  scopedGroupKeyForStudentId,
  type RosterGroup,
  type RosterStudent,
} from "@/lib/rosterStorage";
import { teacherLoginHelpFor } from "@/lib/teacherAuthMessages";
import {
  hasStudentStartCode,
  normalizeStartCodeInput,
  resolveLocalRosterNameGuard,
  resolveStudentIdentity,
  resolveStudentStartCodeLogin,
  rosterStudentsForGroup,
  writeStudentCodes,
} from "@/lib/studentCodes";
import {
  buildStudentReturnHint,
  clearStudentReturnHint,
  readStudentReturnHint,
  refreshStudentReturnHint,
  saveStudentReturnHint,
  type StudentReturnHint,
} from "@/lib/studentReturnHint";
import StatusPill from "@/components/dashboard/StatusPill";
import { loadLocalStudentCodes } from "@/lib/studentCredentialLocalState";
import {
  clearSession,
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
import { recordSolveEntryIntentForPath } from "@/lib/solveEntryIntent";
import { DEFAULT_GUEST_NAME } from "@/lib/guestIdentity";
import { normalizeTeacherRedirectPath, saveTeacherSessionSnapshot, saveTeacherSessionWithIdentity } from "@/lib/teacherSession";
import { setCurrentPlan } from "@/utils/plans";
import { readGuestRecoveryState } from "@/lib/studentGuestRecovery";
import { readExamEntryInviteHandoff } from "@/lib/examEntryInviteHandoff";
import { useTeacherIdentityMode } from "@/components/TeacherIdentityModeProvider";
import { buildTeacherRecoveryCanonicalUrl } from "@/lib/teacherRecoveryCanonical";

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
  // Never reveals which field was wrong (enumeration protection).
  if (status === "invalid_credentials") return "입력한 정보와 일치하는 학생을 찾지 못했어요. 이름 띄어쓰기, 반, 학생번호(또는 이메일), 시작 코드를 다시 확인해주세요.";
  if (status === "unauthenticated") return "학생 세션을 시작하지 못했습니다. 다시 로그인해주세요.";
  return "학생 계정을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";
}

function pendingGuestAttemptIds(): string[] {
  const pending = readPendingGuestMerge();
  if (!pending) return [];
  return readLocalAttempts()
    .filter(attempt => (
      attempt.guestId === pending.guestId
      || attempt.studentId === `guest:${pending.guestId}`
    ))
    .map(attempt => attempt.id);
}

function scrubTeacherLifecycleQuery(query: URLSearchParams): void {
  const sanitized = new URLSearchParams(query);
  sanitized.delete("teacherResetToken");
  sanitized.delete("teacherVerifyToken");
  sanitized.set("role", "teacher");
  const search = sanitized.toString();
  window.history.replaceState(
    window.history.state,
    "",
    `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`,
  );
}

function redirectToCanonicalTeacherRecovery(): void {
  window.location.replace(buildTeacherRecoveryCanonicalUrl(new URL(window.location.href)));
}

export default function Home() {
  const router = useRouter();
  const teacherIdentityMode = useTeacherIdentityMode();
  const teacherSelfServiceEnabled = teacherIdentityMode === "self_service";
  const [role, setRole] = useState<"none" | "teacher" | "student">("none");
  const [studentName, setStudentName] = useState("");
  const [studentLookup, setStudentLookup] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [guestGroupCode, setGuestGroupCode] = useState("");
  const [groups, setGroups] = useState<RosterGroup[]>([]);
  const [rosterStudents, setRosterStudents] = useState<RosterStudent[]>([]);
  const [teacherIdentifier, setTeacherIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [teacherDisplayName, setTeacherDisplayName] = useState("");
  const [teacherAccountMode, setTeacherAccountMode] = useState<"login" | "signup" | "reset" | "reset_complete">("login");
  const visibleTeacherAccountMode = teacherSelfServiceEnabled ? teacherAccountMode : "login";
  const [teacherResetToken, setTeacherResetToken] = useState("");
  const [teacherLegacyLinkBlocked, setTeacherLegacyLinkBlocked] = useState(false);
  const [teacherLifecyclePending, setTeacherLifecyclePending] = useState(false);
  const [teacherSignupSuccess, setTeacherSignupSuccess] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [mockupLoginPending, setMockupLoginPending] = useState(false);
  const [error, setError] = useState("");
  const studentNameInputRef = useRef<HTMLInputElement>(null);
  const [pendingGuestPreview, setPendingGuestPreview] = useState<GuestMergePreview | null>(null);
  const [recentStudentSession, setRecentStudentSession] = useState<StudentSession | null>(null);
  // Anti-spoof: require a start-code for returning students.
  const [startCode, setStartCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  // A newly issued start code acts as the student's password on their next
  // login, so it must be shown persistently (not a 3s toast) until acknowledged.
  const [issuedCodeModal, setIssuedCodeModal] = useState<{ code: string; next: string; studentId: string } | null>(null);
  const [copiedIssuedCode, setCopiedIssuedCode] = useState(false);
  const [needsStudentLookup, setNeedsStudentLookup] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExamId, setInviteExamId] = useState("");
  const [studentDirectoryStatus, setStudentDirectoryStatus] = useState<"local" | "loading" | "remote" | "degraded_local" | "error">("local");
  const [studentLoginPending, setStudentLoginPending] = useState(false);
  const [rememberStudentOnDevice, setRememberStudentOnDevice] = useState(false);
  // Opt-in returning-student hint (name + class only) used to pre-fill the form.
  const [returnHint, setReturnHint] = useState<StudentReturnHint | null>(null);
  const returnHintAppliedRef = useRef(false);
  const studentLookupInputRef = useRef<HTMLInputElement>(null);
  const startCodeInputRef = useRef<HTMLInputElement>(null);
  // Local-mode typo guard: the typed name is not on the selected class roster.
  const [rosterNameGuard, setRosterNameGuard] = useState<{ name: string; suggestion?: string } | null>(null);
  const [confirmUnrosteredStudent, setConfirmUnrosteredStudent] = useState(false);
  const clearLoginError = () => {
    setError("");
    setRosterNameGuard(null);
    setConfirmUnrosteredStudent(false);
  };
  // Teacher login copy: config errors never leak env-var guidance in production.
  const teacherLoginHelp = error
    ? teacherLoginHelpFor(error, { production: process.env.NODE_ENV === "production" })
    : null;
  const teacherIdentifierInvalid = Boolean(error && (error.includes("아이디") || error.includes("계정")));
  const teacherPasswordInvalid = Boolean(error && error.includes("비밀번호"));
  const teacherAccountFormLabel = visibleTeacherAccountMode === "signup"
    ? "교사 계정 만들기"
    : visibleTeacherAccountMode === "reset"
      ? "비밀번호 재설정"
      : visibleTeacherAccountMode === "reset_complete"
        ? "새 비밀번호 설정"
        : "교사 로그인";
  const teacherAccountHeading = visibleTeacherAccountMode === "login" ? "환영합니다" : teacherAccountFormLabel;
  const teacherAccountSubmitLabel = visibleTeacherAccountMode === "signup" ? "가입 이메일 요청"
    : visibleTeacherAccountMode === "reset" ? "재설정 이메일 요청"
      : visibleTeacherAccountMode === "reset_complete" ? "새 비밀번호 저장"
        : "대시보드 입장";
  const teacherAccountPendingLabel = visibleTeacherAccountMode === "signup" ? "가입 요청 중…"
    : visibleTeacherAccountMode === "reset" ? "요청 중…"
      : visibleTeacherAccountMode === "reset_complete" ? "저장 중…"
        : teacherAccountSubmitLabel;
  const studentGroupOptions = useMemo(
    () => buildStudentLoginGroupOptions(groups, rosterStudents),
    [groups, rosterStudents],
  );
  const requiresServerStudentVerification = (
    !!inviteToken && !!inviteExamId
  ) && studentDirectoryStatus !== "degraded_local";
  const directStudentLogin = !requiresServerStudentVerification && (
    process.env.NODE_ENV === "production"
    || (isHydrated && rosterStudents.length === 0 && groups.length === 0 && studentDirectoryStatus === "local")
  );
  const selectedStudentGroup = studentGroupOptions.find(
    group => group.id === selectedGroupId || group.name === selectedGroupId,
  );
  // Student number/email is required up front for server logins and for any
  // class that has at least one roster student on this device.
  const studentLookupRequired = requiresServerStudentVerification
    || rosterStudentsForGroup(selectedStudentGroup, rosterStudents).length > 0;

  const studentRedirectPath = () => {
    if (typeof window === "undefined") return "/student/dashboard";
    return normalizeStudentRedirectPath(new URLSearchParams(window.location.search).get("next"));
  };

  useEffect(() => {
    let cancelled = false;
    let localGroups: RosterGroup[] = [];
    try {
      loadLocalStudentCodes(localStorage, process.env.NODE_ENV);
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
    // An expired-session return link always opens the student form.
    const requestedRole = query.get("reason") === "expired" ? "student" : query.get("role");
    const teacherOperatorRecovery = query.get("teacherRecovery") === "legacy_link";
    if (teacherOperatorRecovery) {
      setRole("teacher");
      setTeacherLegacyLinkBlocked(true);
    } else if (requestedRole === "student" || requestedRole === "teacher") {
      setRole(requestedRole);
    }
    const resetToken = query.get("teacherResetToken")?.trim() || "";
    const verifyToken = query.get("teacherVerifyToken")?.trim() || "";
    const hasTeacherLifecycleQuery = query.has("teacherResetToken") || query.has("teacherVerifyToken");
    if (!teacherSelfServiceEnabled && hasTeacherLifecycleQuery) {
      setRole("teacher");
      setTeacherLegacyLinkBlocked(true);
      redirectToCanonicalTeacherRecovery();
      return () => { cancelled = true; };
    }
    // A legacy recovery link replaces this document. Keep its controls inert
    // until the canonical destination has mounted, so entered state is not lost.
    setIsHydrated(true);
    if (teacherOperatorRecovery) {
      // A provisioned-only legacy link has already been canonicalized. Keep
      // operator recovery dominant over every student or exam handoff.
    } else if (teacherSelfServiceEnabled && resetToken) {
      setRole("teacher");
      setTeacherResetToken(resetToken);
      setTeacherAccountMode("reset_complete");
    } else if (teacherSelfServiceEnabled && verifyToken) {
      setRole("teacher");
      setTeacherLifecyclePending(true);
      const verification = confirmTeacherSignupEmail(verifyToken);
      void verification.then(result => {
        if (!cancelled) setError(result.status === "verified"
          ? "이메일 확인이 완료되었습니다. 이제 로그인할 수 있습니다."
          : "확인 링크가 만료되었거나 이미 사용되었습니다.");
      }).catch(() => {
        if (!cancelled) setError("이메일 확인 서비스를 사용할 수 없습니다.");
      }).finally(() => {
        if (!cancelled) setTeacherLifecyclePending(false);
      });
    } else if (hasTeacherLifecycleQuery) {
      setRole("teacher");
    }
    if (teacherSelfServiceEnabled && hasTeacherLifecycleQuery) {
      scrubTeacherLifecycleQuery(query);
    }
    const requestedExam = query.get("exam")?.trim() || "";
    const requestedInvite = !teacherOperatorRecovery && requestedExam
      ? readExamEntryInviteHandoff(sessionStorage, requestedExam)
      : null;
    setInviteToken(requestedInvite || "");
    setInviteExamId(requestedExam);
    if (!teacherOperatorRecovery && requestedInvite && requestedExam) {
      setRole("student");
      setGroups([]);
      setStudentDirectoryStatus("loading");
      void loadStudentLoginDirectory({ examId: requestedExam, inviteToken: requestedInvite }).then(result => {
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
    } else if (!teacherOperatorRecovery && requestedRole === "student" && !hasTeacherLifecycleQuery) {
      // A signed student cookie restores student home. Guests retain their
      // cookie for ownership claims and use the direct credential form.
      const restoreSignedStudentScope = async () => {
        const restored = await refreshStudentSession();
        if (cancelled || !restored.ok || !restored.session) return;
        const session = restored.session;
        if (!session.isGuest) {
          saveSession(session);
          setRecentStudentSession(session);
          router.replace(normalizeStudentRedirectPath(query.get("next")));
          return;
        }
        // Keep the signed guest cookie for account claims. Direct login resolves
        // the student's own organization and classes after verifying credentials.
      };
      void restoreSignedStudentScope().catch(() => {
        // Keep credential login available when session restoration fails.
      });
    }
    return () => { cancelled = true; };
  }, [router, teacherSelfServiceEnabled]);

  // Pre-fill a returning student's name and class from the opt-in hint, then
  // move focus to the first credential they still have to type.
  useEffect(() => {
    if (role !== "student" || returnHintAppliedRef.current || !isHydrated) return;
    if (studentDirectoryStatus === "loading") return;
    returnHintAppliedRef.current = true;
    const hint = readStudentReturnHint();
    if (!hint) return;
    // Derived from client-only localStorage after the role is chosen.
    setReturnHint(hint);
    setRememberStudentOnDevice(true);
    setStudentName(previous => previous.trim() ? previous : hint.name);
    const hintGroup = studentGroupOptions.find(group => group.id === hint.groupId);
    if (hintGroup || studentGroupOptions.length === 0) {
      setSelectedGroupId(previous => previous || hint.groupId);
    }
  }, [role, isHydrated, studentDirectoryStatus, studentGroupOptions]);

  useEffect(() => {
    if (!returnHint || role !== "student") return;
    const focusTimer = window.setTimeout(() => {
      const lookupMissing = studentLookupRequired && !studentLookupInputRef.current?.value.trim();
      (lookupMissing ? studentLookupInputRef.current : startCodeInputRef.current)?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
    // Focus once when the hint is applied, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnHint, role]);

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
      const codes = loadLocalStudentCodes(localStorage, process.env.NODE_ENV);
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
      return;
      }

      const res = await verifyTeacherPassword(identifier, password);
      if (res.success && res.token) {
        const saved = res.session
          ? saveTeacherSessionSnapshot(res.session)
          : saveTeacherSessionWithIdentity(res.token, res.teacher);
        if (!saved) {
          setError("브라우저 세션 저장을 사용할 수 없습니다.");
          return;
        }
        // Apply the account's bound plan only when one is configured, so accounts
        // without an explicit plan keep the browser's existing (e.g. billing) plan.
        if (res.teacher?.plan) setCurrentPlan(res.teacher.plan);
        const next = normalizeTeacherRedirectPath(new URLSearchParams(window.location.search).get("next"));
        router.push(next);
      } else {
        setError(res.error || "잘못된 비밀번호입니다.");
      }
    } catch {
      setError("서버 인증 도중 오류가 발생했습니다.");
    }
  };

  const teacherLifecycleMessage = (status: string): string => {
    if (status === "delivery_unavailable") return "이메일 전송 기능이 아직 연결되지 않았습니다. 운영자에게 계정 발급 또는 복구를 요청해주세요.";
    if (status === "invalid_input") return "이메일, 이름, 비밀번호 형식을 확인해주세요. 비밀번호는 12자 이상이어야 합니다.";
    if (status === "rate_limited") return "요청이 많습니다. 잠시 후 다시 시도해주세요.";
    if (status === "accepted") return "요청을 접수했습니다. 계정 존재 여부와 관계없이 같은 안내가 표시됩니다.";
    if (status === "completed") return "비밀번호를 변경했습니다. 새 비밀번호로 로그인해주세요.";
    if (status === "verified") return "이메일 확인이 완료되었습니다. 이제 로그인할 수 있습니다.";
    if (status === "invalid_or_expired") return "링크가 만료되었거나 이미 사용되었습니다. 새 링크를 요청해주세요.";
    return "계정 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.";
  };

  const handleTeacherSignup = async () => {
    if (teacherLifecyclePending) return;
    setTeacherLifecyclePending(true);
    setError("");
    setTeacherSignupSuccess(false);
    try {
      const result = await requestTeacherSignup({
        email: teacherIdentifier,
        displayName: teacherDisplayName,
        password,
      });
      if (result.status === "accepted") {
        setTeacherSignupSuccess(true);
      } else {
        setError(teacherLifecycleMessage(result.status));
      }
    } catch {
      setError("계정 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setTeacherLifecyclePending(false);
    }
  };

  const handleTeacherPasswordReset = async () => {
    if (teacherLifecyclePending) return;
    setTeacherLifecyclePending(true);
    setError("");
    try {
      const result = await requestTeacherPasswordReset(teacherIdentifier);
      setError(teacherLifecycleMessage(result.status));
    } catch {
      setError("계정 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.");
    } finally {
      setTeacherLifecyclePending(false);
    }
  };

  const handleTeacherPasswordResetCompletion = async () => {
    if (teacherLifecyclePending) return;
    setTeacherLifecyclePending(true);
    setError("");
    try {
      const result = await finishTeacherPasswordReset({ token: teacherResetToken, password });
      setError(teacherLifecycleMessage(result.status));
      if (result.status === "completed") {
        setTeacherAccountMode("login");
        setTeacherResetToken("");
        setPassword("");
      }
    } catch {
      setError("비밀번호 재설정 서비스를 사용할 수 없습니다.");
    } finally {
      setTeacherLifecyclePending(false);
    }
  };

  const handleTeacherAccountSubmit = () => {
    if (!teacherSelfServiceEnabled) return handleTeacherLogin();
    if (teacherAccountMode === "signup") return handleTeacherSignup();
    if (teacherAccountMode === "reset") return handleTeacherPasswordReset();
    if (teacherAccountMode === "reset_complete") return handleTeacherPasswordResetCompletion();
    return handleTeacherLogin();
  };

  const handleMockupLogin = async () => {
    if (mockupLoginPending) return;
    setMockupLoginPending(true);
    setError("");
    try {
      const res = await startMockupTeacherSession();
      if (!res.success || !res.token || !res.session) {
        setError(res.error || "데모 계정을 시작하지 못했습니다.");
        return;
      }
      const saved = saveTeacherSessionSnapshot(res.session);
      if (!saved) {
        setError("브라우저 세션 저장을 사용할 수 없습니다.");
        return;
      }
      setCurrentPlan("academy");
      router.push("/teacher/dashboard?showcase=1");
    } catch {
      setError("데모 계정을 여는 중 오류가 발생했습니다.");
    } finally {
      setMockupLoginPending(false);
    }
  };

  const finishStudentLogin = async (
    session: StudentSession,
    next: string,
    issuedCode?: string,
    guestClaim?: StudentSessionIssueResult["guestClaim"],
  ) => {
    const pendingGuestMerge = readPendingGuestMerge();
    if (pendingGuestMerge) {
      const preview = previewGuestMerge(pendingGuestMerge.guestId);
      const target = {
        studentId: session.studentId,
        name: session.name,
        groupId: session.groupId,
        groupName: session.groupName,
        regionId: session.regionId,
        regionName: session.regionName,
        identityType: session.identityType,
      };
      const acknowledgedAttemptIds = new Set(
        guestClaim?.status === "claimed" || guestClaim?.status === "partial"
          ? guestClaim.acknowledgedAttemptIds
          : [],
      );
      const confirmedIds = preview.attemptIds.filter(id => acknowledgedAttemptIds.has(id));
      if (confirmedIds.length > 0) {
        mergeGuestAttempts(pendingGuestMerge.guestId, target, { attemptIds: confirmedIds });
      }
      const recovery = readGuestRecoveryState(window.localStorage);
      if (recovery?.status === "unverified" && recovery.attemptIds.length === 0) {
        consumePendingGuestMerge();
        toast.success(
          "게스트 기록 서버 연결됨",
          `${confirmedIds.length}개의 서버 소유 기록을 학생 기록으로 저장했습니다.`,
        );
      } else {
        toast.info(
          "미검증 로컬 기록 분리 보관",
          "확인되지 않은 기록은 학생 기록에 합치지 않았습니다. 대시보드에서 내보내거나 서버 소유 기록을 다시 확인할 수 있습니다.",
        );
      }
    }

    saveSession(session, { rememberDevice: rememberStudentOnDevice });
    // "내 정보 기억하기" stores name + class only; unchecking forgets them.
    if (rememberStudentOnDevice) saveStudentReturnHint(session);
    else clearStudentReturnHint();
    if (issuedCode) {
      setCopiedIssuedCode(false);
      setIssuedCodeModal({ code: issuedCode, next, studentId: session.studentId });
      return true;
    }
    // Logging in to reach an exam is the choice; skip the solve page's
    // "학생으로 시험 보기" confirmation once (tab-scoped, 120s, re-validated).
    if (!session.isGuest) recordSolveEntryIntentForPath(next, session.studentId);
    router.push(next);
    return true;
  };

  const handleStudentLogin = async (options: { allowUnrosteredName?: boolean } = {}) => {
    if (studentLoginPending) return;
    setRosterNameGuard(null);
    setConfirmUnrosteredStudent(false);
    const trimmedName = studentName.trim();
    const next = normalizeStudentRedirectPath(new URLSearchParams(window.location.search).get("next"));
    if (!trimmedName) {
      setError("이름을 입력해주세요.");
      studentNameInputRef.current?.focus();
      return;
    }
    if (!selectedGroupId) {
      setError("반을 선택해주세요.");
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
        return;
      }

      setStudentLoginPending(true);
      try {
        const result = await issueStudentSession({
          examId: inviteExamId,
          inviteToken,
          name: trimmedName,
          groupId: selectedGroupId,
          studentLookup,
          startCode,
          guestAttemptIds: pendingGuestAttemptIds(),
        });
        if (!result.ok || !result.identity) {
          setError(result.error || studentLoginErrorMessage(result.status));
          return;
        }
        const identity = result.identity;
        if (inviteExamId && inviteToken
          && !readExamEntryInviteHandoff(sessionStorage, inviteExamId, Date.now(), identity.studentId)) {
          setError("시험 링크가 만료되었거나 다른 학생 계정에 연결되었습니다. 선생님에게 새 링크를 요청해주세요.");
          return;
        }
        const session: StudentSession = {
          name: identity.name,
          studentId: identity.studentId,
          loginId: studentLookup.trim(),
          groupId: identity.groupId,
          groupName: identity.groupName,
          regionId: identity.regionId,
          regionName: identity.regionName,
          isGuest: false,
          // Mirror the type the server signed (registered for invite/credential
          // logins). Display-only: the server re-derives it from the cookie.
          identityType: identity.identityType,
        };
        await finishStudentLogin(session, next, undefined, result.guestClaim);
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
    // Stop before a start code is issued when the class has a roster and the
    // typed name is not on it — a typo must not silently create a new student.
    const nameGuard = resolveLocalRosterNameGuard({
      name: trimmedName,
      group: loginGroups.find(group => group.id === selectedGroupId || group.name === selectedGroupId),
      students,
    });
    if (nameGuard.status === "unmatched_in_roster" && !options.allowUnrosteredName) {
      setRosterNameGuard({ name: trimmedName, suggestion: nameGuard.suggestion });
      return;
    }
    if (identity.lookupMismatch) {
      setNeedsStudentLookup(true);
      setError("학생번호 또는 이메일이 명단과 일치하지 않습니다.");
      return;
    }
    if (identity.requiresStudentLookup) {
      setNeedsStudentLookup(true);
      setError(identity.rosterMatchCount > 1
        ? "동명이인이 있습니다. 선생님이 알려준 학생번호 또는 이메일을 입력해주세요."
        : "이 반 명단에 있는 학생이에요. 선생님이 알려준 학생번호 또는 이메일을 입력해주세요.");
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
    const codes = loadLocalStudentCodes(localStorage, process.env.NODE_ENV);
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
      return;
    }
    if (codeDecision.status === "code_required") {
      setNeedsCode(true);
      setError("이미 시작 코드가 있는 학생이에요. 처음 로그인할 때 받은 6자리 코드를 입력해주세요.");
      return;
    }
    if (codeDecision.status === "code_mismatch") {
      setNeedsCode(true);
      setError("시작 코드가 맞지 않아요. 6자리를 다시 확인해주세요(O·I·0·1은 쓰지 않아요). 잊었다면 선생님에게 재발급을 요청하세요.");
      return;
    }

    setStudentLoginPending(true);
    try {
      const result = await issueStudentSession({
        studentId: identity.studentId,
        name: trimmedName,
        groupId: selectedGroupId,
        groupName: identity.groupName,
        ...regionSnapshot,
        guestAttemptIds: pendingGuestAttemptIds(),
      });
      if (!result.ok) {
        setError(result.error || studentLoginErrorMessage(result.status));
        return;
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
      await finishStudentLogin(
        session,
        next,
        codeDecision.status === "new_code_issued" ? codeDecision.code : undefined,
        result.guestClaim,
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
    if (!guestId) {
      setError("게스트 세션을 안전하게 시작하지 못했습니다. 네트워크를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    const session: StudentSession = {
      studentId: `guest:${guestId}`,
      loginId: guestLoginIdFor(guestId),
      name: DEFAULT_GUEST_NAME,
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
      return;
    }

    void startGuestSession(guestGroup);
  };

  const applyReturnHint = (hint: StudentReturnHint, remembered: boolean) => {
    returnHintAppliedRef.current = true;
    setReturnHint(hint);
    setRememberStudentOnDevice(remembered);
    setStudentName(hint.name);
    setSelectedGroupId(hint.groupId);
    setStudentLookup("");
    setStartCode("");
  };

  const handleContinueRecentStudent = async () => {
    const restoredSession = getSession();
    if (!restoredSession || restoredSession.isGuest) {
      setRecentStudentSession(null);
      toast.info("최근 학생 정보 없음", "이름과 반으로 다시 로그인해주세요.");
      return;
    }
    // The local card can outlive the 12h server session; confirm it first so
    // "이어가기" never lands on a dashboard that only says "login required".
    let restored: Awaited<ReturnType<typeof refreshStudentSession>>;
    try {
      restored = await refreshStudentSession();
    } catch {
      toast.error("학생 정보를 확인하지 못했어요", "네트워크를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    if (restored.ok && restored.session && !restored.session.isGuest) {
      saveSession(restored.session);
      router.push(studentRedirectPath());
      return;
    }
    if (!restored.ok && restored.status !== "unauthenticated") {
      toast.error("학생 정보를 확인하지 못했어요", "네트워크를 확인한 뒤 다시 시도해주세요.");
      return;
    }
    refreshStudentReturnHint(restoredSession);
    // Without an opt-in hint, the still-open local session pre-fills this one
    // login only; nothing new is persisted.
    const storedHint = readStudentReturnHint();
    const hint = storedHint || buildStudentReturnHint(restoredSession);
    clearSession();
    setRecentStudentSession(null);
    setError("");
    setRole("student");
    if (hint) applyReturnHint(hint, !!storedHint);
  };

  const handleNotThisStudent = () => {
    clearStudentReturnHint();
    returnHintAppliedRef.current = true;
    setReturnHint(null);
    setRememberStudentOnDevice(false);
    setStudentName("");
    setSelectedGroupId("");
    setStudentLookup("");
    setStartCode("");
    clearLoginError();
    studentNameInputRef.current?.focus();
  };

  const handleUseSuggestedRosterName = (suggestion: string) => {
    setStudentName(suggestion);
    clearLoginError();
    studentNameInputRef.current?.focus();
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
    const studentId = issuedCodeModal?.studentId;
    setIssuedCodeModal(null);
    if (!next) return;
    if (studentId) recordSolveEntryIntentForPath(next, studentId);
    router.push(next);
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
    setInviteToken("");
    setInviteExamId("");
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
      {role === "none" ? (
        <Image
          src="/assets/omr-home-learning-coach-bg-v2.png"
          alt=""
          fill
          priority
          sizes="100vw"
          className="home-learning-coach-backdrop"
          aria-hidden="true"
        />
      ) : null}

      {/* Theme toggle */}
      <div className="home-theme-toggle" style={{ position: "fixed", top: "1.25rem", right: "1.25rem", zIndex: 10 }}>
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

      <main id="main-content" className="landing-main">
        <div
          className="container animate-fade-in home-container mobile-inline-surface mobile-section-stack"
          style={{ maxWidth: "1320px", position: "relative", zIndex: 1, padding: "3rem 1.5rem" }}
        >
          {/* ── Hero ───────────────────────────── */}
          {role === "none" && (
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

              <div
                className="badge badge-primary stagger-2 animate-fade-in home-eyebrow"
                style={{ marginBottom: "1.15rem", opacity: 0 }}
              >
                <Circle size={8} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                Smart Evaluation Platform
              </div>

              <h1
                className="title-gradient stagger-3 animate-fade-in home-title"
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
          )}

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
              disabled={!isHydrated}
              onClick={() => setRole("student")}
              className="glass-panel card-hover home-role-card home-role-card--student"
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
              <span className="icon-wrap icon-wrap-secondary home-role-icon" style={{ marginBottom: "1.5rem" }}>
                <GraduationCap size={48} strokeWidth={2} aria-hidden="true" />
              </span>

              <span
                className="home-role-title"
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  marginBottom: "0.5rem",
                  color: "var(--foreground)",
                  letterSpacing: 0,
                }}
              >
                학생
              </span>
              <span
                className="home-role-description"
                style={{
                  display: "block",
                  color: "var(--muted)",
                  fontSize: "0.95rem",
                  lineHeight: 1.65,
                  marginBottom: "2rem",
                }}
              >
                배정된 시험에 참여하고 결과를 확인하세요.
              </span>

              <span
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
                <ChevronRight aria-hidden="true" />
              </span>
            </button>

            {/* Teacher */}
            <button
              type="button"
              disabled={!isHydrated}
              onClick={() => setRole("teacher")}
              className="glass-panel card-hover home-role-card home-role-card--teacher"
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
              <span className="icon-wrap icon-wrap-primary home-role-icon" style={{ marginBottom: "1.5rem" }}>
                <FileBadge2 size={48} strokeWidth={2} aria-hidden="true" />
              </span>

              <span
                className="home-role-title"
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 800,
                  marginBottom: "0.5rem",
                  color: "var(--foreground)",
                  letterSpacing: 0,
                }}
              >
                교사
              </span>
              <span
                className="home-role-description"
                style={{
                  display: "block",
                  color: "var(--muted)",
                  fontSize: "0.95rem",
                  lineHeight: 1.65,
                  marginBottom: "2rem",
                }}
              >
                시험을 출제하고 배포하며 학생 성취도를 분석하세요.
              </span>

              <span
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
                <ChevronRight aria-hidden="true" />
              </span>
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
              onClick={() => { void handleContinueRecentStudent(); }}
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
            className="glass-panel animate-slide-up home-login-card mobile-section-stack"
            style={{ maxWidth: role === "teacher" ? "500px" : "440px", margin: "0 auto", padding: "2.75rem 2.5rem" }}
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
              <ChevronLeft aria-hidden="true" />
              역할 선택으로
            </button>

            {role === "teacher" ? (
              <>
                {/* Teacher form */}
                <div style={{ marginBottom: "2.25rem" }}>
                  <span className="badge badge-primary" style={{ marginBottom: "1rem" }}>
                    <FileBadge2 size={12} aria-hidden="true" />
                    교사 포털
                  </span>
                  <h1
                    style={{
                      fontSize: "1.85rem",
                      fontWeight: 800,
                      color: "var(--foreground)",
                      lineHeight: 1.2,
                      letterSpacing: 0,
                    }}
                  >
                    {teacherAccountHeading}
                  </h1>
                </div>

                <form
                  aria-label={teacherAccountFormLabel}
                  noValidate
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleTeacherAccountSubmit();
                  }}
                >
                  {visibleTeacherAccountMode !== "reset_complete" && (
                    <div style={{ marginBottom: "1.05rem" }}>
                      <label
                        htmlFor="teacher-identifier"
                        style={{
                          display: "block",
                          marginBottom: "0.55rem",
                          fontSize: "var(--type-label)",
                          fontWeight: 700,
                          color: "var(--muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                        }}
                      >
                        {visibleTeacherAccountMode === "login" ? "아이디 또는 이메일" : "이메일"}
                      </label>
                      <input
                        id="teacher-identifier"
                        type={visibleTeacherAccountMode === "login" ? "text" : "email"}
                        className="input-field"
                        value={teacherIdentifier}
                        onChange={(event) => {
                          setTeacherIdentifier(event.target.value);
                          clearLoginError();
                        }}
                        placeholder={visibleTeacherAccountMode === "login" ? "운영자가 발급한 교사 아이디 또는 이메일" : "teacher@example.com"}
                        autoFocus
                        autoComplete={visibleTeacherAccountMode === "login" ? "username" : "email"}
                        inputMode={visibleTeacherAccountMode === "login" ? undefined : "email"}
                        autoCapitalize="none"
                        spellCheck={false}
                        aria-invalid={teacherIdentifierInvalid}
                        aria-describedby="teacher-login-feedback"
                      />
                    </div>
                  )}

                  {visibleTeacherAccountMode === "signup" && (
                    <div style={{ marginBottom: "1.05rem" }}>
                      <label
                        htmlFor="teacher-display-name"
                        style={{
                          display: "block",
                          marginBottom: "0.55rem",
                          fontSize: "var(--type-label)",
                          fontWeight: 700,
                          color: "var(--muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                        }}
                      >
                        교사 이름
                      </label>
                      <input
                        id="teacher-display-name"
                        type="text"
                        className="input-field"
                        value={teacherDisplayName}
                        onChange={(event) => {
                          setTeacherDisplayName(event.target.value);
                          clearLoginError();
                        }}
                        placeholder="교사 이름"
                        autoComplete="name"
                      />
                    </div>
                  )}

                  {visibleTeacherAccountMode !== "reset" && (
                    <div style={{ marginBottom: "1.05rem" }}>
                      <label
                        htmlFor="teacher-password"
                        style={{
                          display: "block",
                          marginBottom: "0.55rem",
                          fontSize: "var(--type-label)",
                          fontWeight: 700,
                          color: "var(--muted)",
                          textTransform: "uppercase",
                          letterSpacing: "0.07em",
                        }}
                      >
                        {visibleTeacherAccountMode === "reset_complete" ? "새 비밀번호" : "비밀번호"}
                      </label>
                      <input
                        id="teacher-password"
                        type="password"
                        className="input-field"
                        value={password}
                        onChange={(event) => {
                          setPassword(event.target.value);
                          clearLoginError();
                        }}
                        placeholder={visibleTeacherAccountMode === "reset_complete" ? "12자 이상의 새 비밀번호" : "비밀번호 입력"}
                        autoFocus={visibleTeacherAccountMode === "reset_complete"}
                        autoComplete={visibleTeacherAccountMode === "login" ? "current-password" : "new-password"}
                        aria-invalid={teacherPasswordInvalid}
                        aria-describedby="teacher-login-feedback"
                      />
                    </div>
                  )}

                  {visibleTeacherAccountMode === "signup" && (
                    <p style={{ color: "var(--muted)", fontSize: "var(--type-label)", lineHeight: 1.5, marginBottom: "1.05rem" }}>
                      위 이메일과 12자 이상의 비밀번호로 가입합니다. 이메일 확인 전에는 로그인할 수 없습니다.
                    </p>
                  )}
                  {visibleTeacherAccountMode === "reset" && (
                    <p style={{ color: "var(--muted)", fontSize: "var(--type-label)", lineHeight: 1.5, marginBottom: "1.05rem" }}>
                      위 이메일로 재설정 링크를 요청합니다. 계정 존재 여부는 화면에 표시하지 않습니다.
                    </p>
                  )}
                  {visibleTeacherAccountMode === "reset_complete" && (
                    <p style={{ color: "var(--muted)", fontSize: "var(--type-label)", lineHeight: 1.5, marginBottom: "1.05rem" }}>
                      12자 이상의 새 비밀번호를 입력하세요. 링크는 한 번만 사용할 수 있습니다.
                    </p>
                  )}

                  {teacherSignupSuccess && (
                    <div
                      style={{
                        padding: "1rem 1.15rem",
                        background: "var(--accent-subtle, rgba(34, 197, 94, 0.08))",
                        border: "1px solid rgba(34, 197, 94, 0.3)",
                        borderRadius: "0.75rem",
                        display: "grid",
                        gap: "0.55rem",
                        marginBottom: "1rem",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                        <span style={{ fontSize: "1.25rem" }} role="img" aria-label="축하">🎉</span>
                        <strong style={{ fontSize: "var(--type-ui)", color: "var(--foreground)" }}>
                          가입 요청을 접수했습니다!
                        </strong>
                      </div>
                      <p style={{ fontSize: "var(--type-label)", color: "var(--muted)", lineHeight: 1.55 }}>
                        확인 이메일을 발송했습니다. 메일함의 인증 링크를 클릭하여 계정 설정을 완료해 주세요.
                      </p>
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.25rem" }}>
                        <button
                          type="button"
                          className="btn btn-primary"
                          style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}
                          onClick={() => {
                            setTeacherAccountMode("login");
                            setTeacherSignupSuccess(false);
                          }}
                        >
                          로그인 화면으로 이동
                        </button>
                        <button
                          type="button"
                          className="btn"
                          style={{ fontSize: "0.85rem", padding: "0.4rem 0.8rem" }}
                          onClick={handleMockupLogin}
                          disabled={mockupLoginPending}
                        >
                          <Sparkles size={14} style={{ marginRight: "0.3rem" }} />
                          데모로 둘러보기
                        </button>
                      </div>
                    </div>
                  )}

                  <div
                    id="teacher-login-feedback"
                    aria-live="polite"
                    style={{ marginBottom: "1.25rem", display: "grid", gap: "0.35rem" }}
                  >
                    {teacherLoginHelp ? (
                      <>
                        <p role="alert" style={{ fontSize: "var(--type-label)", color: "var(--error)", fontWeight: 600 }}>
                          {teacherLoginHelp.message}
                        </p>
                        {teacherLoginHelp.recoveryHelp && (
                          <p style={{ fontSize: "var(--type-label)", color: "var(--muted)", lineHeight: 1.5, wordBreak: "keep-all" }}>
                            {teacherLoginHelp.recoveryHelp}
                          </p>
                        )}
                        {teacherLoginHelp.operatorHelp && (
                          <p style={{ fontSize: "var(--type-label)", color: "var(--muted)", lineHeight: 1.5, wordBreak: "keep-all" }}>
                            {teacherLoginHelp.operatorHelp}
                          </p>
                        )}
                      </>
                    ) : (
                      <p style={{ fontSize: "var(--type-label)", color: "var(--muted)", opacity: 0.82 }}>
                        {visibleTeacherAccountMode === "login"
                          ? teacherSelfServiceEnabled
                            ? "교사 계정으로 로그인하세요. 계정이 없으면 아래 ‘교사 계정 만들기’를 선택하세요."
                            : "운영자가 발급한 교사 계정으로 로그인하세요. 처음 이용하면 운영자에게 계정 발급을 요청해주세요."
                          : "요청 결과가 여기에 표시됩니다."}
                      </p>
                    )}
                  </div>

                  <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={!isHydrated || teacherLifecyclePending}>
                    {teacherLifecyclePending ? teacherAccountPendingLabel : teacherAccountSubmitLabel}
                  </button>
                </form>

                <div style={{ marginTop: "0.85rem", display: "grid", gap: "0.65rem" }}>
                  {teacherSelfServiceEnabled ? (
                    <>
                      {visibleTeacherAccountMode !== "reset_complete" && (
                        <div style={{ display: "flex", gap: "0.55rem", flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              setTeacherAccountMode(mode => mode === "signup" ? "login" : "signup");
                              setError("");
                              setTeacherSignupSuccess(false);
                            }}
                          >
                            {visibleTeacherAccountMode === "signup" ? "로그인으로 돌아가기" : "교사 계정 만들기"}
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => {
                              setTeacherAccountMode(mode => mode === "reset" ? "login" : "reset");
                              setError("");
                              setTeacherSignupSuccess(false);
                            }}
                          >
                            {visibleTeacherAccountMode === "reset" ? "로그인으로 돌아가기" : "비밀번호 재설정"}
                          </button>
                        </div>
                      )}
                      <p style={{ color: "var(--muted)", fontSize: "var(--type-caption)", lineHeight: 1.5 }}>
                        부트스트랩 계정은 초기 운영자가 명시적으로 허용한 경우에만 사용됩니다.
                      </p>
                    </>
                  ) : (
                    <p style={{ color: "var(--muted)", fontSize: "var(--type-caption)", lineHeight: 1.5 }}>
                      {teacherLegacyLinkBlocked
                        ? "현재 운영 모드에서는 이 링크를 사용할 수 없습니다. 운영자에게 계정 또는 비밀번호 재발급을 요청해주세요."
                        : "운영자에게 계정 또는 비밀번호 재발급을 요청해주세요"}
                    </p>
                  )}
                </div>

                <div className="mockup-login-divider" aria-hidden="true"><span>또는 바로 체험하기</span></div>
                <section className="mockup-login-card" aria-label="데모 계정 체험">
                  <div className="mockup-login-card-heading">
                    <span className="mockup-login-spark"><Sparkles size={18} /></span>
                    <div>
                      <strong>MOCKUP 계정</strong>
                      <p>입력 없이 완성된 분석 화면을 둘러보세요.</p>
                    </div>
                    <span className="mockup-login-readonly">예시 데이터</span>
                  </div>
                  <div className="mockup-login-preview" aria-label="데모 계정 포함 데이터">
                    <span><BarChart3 size={15} /><strong>7</strong>개 시험</span>
                    <span><Users size={15} /><strong>84</strong>명 학생</span>
                    <span><Sparkles size={15} />상세 분석</span>
                  </div>
                  <button
                    type="button"
                    className="mockup-login-button"
                    onClick={() => void handleMockupLogin()}
                    disabled={!isHydrated || mockupLoginPending}
                  >
                    {mockupLoginPending ? "데모 준비 중…" : "데모 계정으로 둘러보기"}
                    {!mockupLoginPending && <ChevronRight />}
                  </button>
                  <p className="mockup-login-note">실제 학교·학생 정보와 연결되지 않으며, 표시되는 모든 수치는 예시입니다.</p>
                </section>
              </>
            ) : (
              <>
                {/* Student form */}
                <div style={{ marginBottom: "2.25rem" }}>
                  <h1
                    style={{
                      fontSize: "1.85rem",
                      fontWeight: 800,
                      color: "var(--foreground)",
                      lineHeight: 1.2,
                      letterSpacing: 0,
                    }}
                  >
                    학습 시작
                  </h1>
                </div>

                {directStudentLogin ? (
                  <StudentDirectLoginForm
                    returnHintName={returnHint?.name}
                    onForgetDevice={handleNotThisStudent}
                    rememberDevice={rememberStudentOnDevice}
                    onRememberDeviceChange={setRememberStudentOnDevice}
                    getGuestAttemptIds={pendingGuestAttemptIds}
                    onSignedIn={async result => {
                      if (!result.identity) return;
                      const identity = result.identity;
                      await finishStudentLogin({
                        studentId: identity.studentId,
                        loginId: identity.studentId,
                        name: identity.name,
                        groupId: identity.groupId,
                        groupName: identity.groupName,
                        regionId: identity.regionId,
                        regionName: identity.regionName,
                        isGuest: false,
                        identityType: "registered",
                      }, studentRedirectPath(), undefined, result.guestClaim);
                    }}
                  />
                ) : (
                <form
                  className="student-account-login-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void handleStudentLogin();
                  }}
                  noValidate
                >
                {returnHint && (
                  <section
                    className="student-return-hint-banner"
                    role="status"
                    style={{
                      display: "flex",
                      flexWrap: "wrap",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "0.5rem 0.75rem",
                      marginBottom: "1.25rem",
                      padding: "0.8rem 0.95rem",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid rgba(99,102,241,0.2)",
                      background: "rgba(99,102,241,0.08)",
                      color: "var(--foreground)",
                      fontSize: "var(--type-label)",
                      lineHeight: 1.55,
                      wordBreak: "keep-all",
                    }}
                  >
                    <span style={{ flex: "1 1 14rem", minWidth: 0 }}>
                      {returnHint.name}님, 다시 오셨네요. 시작 코드를 입력하면 이어서 할 수 있어요.
                    </span>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleNotThisStudent}
                      style={{ minHeight: 44, padding: "0.45rem 0.8rem", fontSize: "var(--type-label)", flexShrink: 0 }}
                    >
                      다른 학생이에요
                    </button>
                  </section>
                )}

                <div style={{ marginBottom: "1.1rem" }}>
                  <label
                    htmlFor="student-name"
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "var(--type-label)",
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
                    aria-invalid={error === "이름을 입력해주세요." || !!rosterNameGuard}
                    aria-describedby={error === "이름을 입력해주세요." ? "student-name-error" : rosterNameGuard ? "student-roster-name-guard" : undefined}
                    value={studentName}
                    onChange={(e) => {
                      setStudentName(e.target.value);
                      clearLoginError();
                    }}
                    placeholder="이름을 입력하세요"
                    autoFocus={!returnHint}
                    autoComplete="name"
                  />
                  {error === "이름을 입력해주세요." && (
                    <p
                      id="student-name-error"
                      role="alert"
                      style={{ fontSize: "var(--type-label)", color: "var(--text-error)", marginTop: "0.45rem", fontWeight: 700 }}
                    >
                      {error}
                    </p>
                  )}
                </div>

                <div style={{ marginBottom: "1.1rem" }}>
                  <label
                    htmlFor="student-group"
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "var(--type-label)",
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
                      id="student-group"
                      aria-label="반 선택"
                      value={selectedGroupId}
                      onChange={(e) => {
                        setSelectedGroupId(e.target.value);
                        clearLoginError();
                      }}
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
                      id="student-group"
                      type="text"
                      className="input-field"
                      aria-label="반 코드"
                      value={selectedGroupId}
                      onChange={(e) => {
                        setSelectedGroupId(e.target.value.trim());
                        clearLoginError();
                      }}
                      placeholder="선생님이 알려준 반 코드"
                      autoCapitalize="none"
                      spellCheck={false}
                    />
                  )}
                  {studentGroupOptions.length === 0 && (
                    <p style={{ fontSize: "var(--type-label)", color: "var(--muted)", marginTop: "0.45rem", lineHeight: 1.5 }}>
                      {requiresServerStudentVerification
                        ? "초대된 반을 찾을 수 없습니다. 선생님에게 최신 초대 링크를 요청해주세요."
                        : "등록된 반이 없으면 아래 반 코드로 게스트 시험을 시작할 수 있습니다."}
                    </p>
                  )}
                </div>

                <div style={{ marginBottom: "1.1rem" }}>
                  <label
                    htmlFor="student-lookup"
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "0.45rem",
                      marginBottom: "0.55rem",
                      fontSize: "var(--type-label)",
                      fontWeight: 700,
                      color: needsStudentLookup ? "var(--text-warning)" : "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    학생번호 또는 이메일
                    {studentLookupRequired && (
                      <StatusPill tone="warning" size="sm" label="필수" style={{ letterSpacing: 0 }} />
                    )}
                  </label>
                  <input
                    ref={studentLookupInputRef}
                    id="student-lookup"
                    type="text"
                    className="input-field"
                    aria-label="학생번호 또는 이메일"
                    aria-required={studentLookupRequired || undefined}
                    value={studentLookup}
                    onChange={(e) => {
                      setStudentLookup(e.target.value);
                      clearLoginError();
                    }}
                    placeholder="선생님이 알려준 학생번호 또는 이메일"
                    autoComplete="email"
                    autoCapitalize="none"
                    inputMode="email"
                    spellCheck={false}
                    style={{
                      borderColor: needsStudentLookup ? "var(--warning-line)" : undefined,
                    }}
                  />
                  <p style={{
                    fontSize: "var(--type-label)",
                    color: needsStudentLookup ? "var(--text-warning)" : "var(--muted)",
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
                    htmlFor="student-start-code"
                    style={{
                      display: "block",
                      marginBottom: "0.55rem",
                      fontSize: "var(--type-label)",
                      fontWeight: 700,
                      color: needsCode ? "var(--text-warning)" : "var(--muted)",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                    }}
                  >
                    시작 코드
                  </label>
                  <input
                    ref={startCodeInputRef}
                    id="student-start-code"
                    type="text"
                    className="input-field"
                    aria-label="시작 코드"
                    aria-describedby="student-start-code-help"
                    value={startCode}
                    onChange={(e) => {
                      setStartCode(normalizeStartCodeInput(e.target.value));
                      clearLoginError();
                    }}
                    placeholder="6자리 코드 입력"
                    autoComplete="one-time-code"
                    autoCapitalize="characters"
                    spellCheck={false}
                    maxLength={6}
                    style={{
                      letterSpacing: "0.25em",
                      fontFamily: "monospace",
                      textTransform: "uppercase",
                      borderColor: needsCode ? "var(--warning-line)" : undefined,
                    }}
                  />
                  <p
                    id="student-start-code-help"
                    style={{
                      fontSize: "var(--type-label)",
                      color: needsCode ? "var(--text-warning)" : "var(--muted)",
                      marginTop: "0.45rem",
                      lineHeight: 1.5,
                      wordBreak: "keep-all",
                    }}
                  >
                    {/* Server and local codes share the alphabet in studentCodes.ts START_CODE_ALPHABET (no O, I, 0, 1). */}
                    {requiresServerStudentVerification
                      ? "선생님이 알려준 6자리 코드예요. 영문 대문자와 숫자로 되어 있고 O·I·0·1은 쓰지 않아요."
                      : "처음 로그인한다면 비워두세요. 로그인하면 새 코드를 알려드려요."}
                  </p>
                </div>

                <div id="student-login-feedback" aria-live="polite">
                  {error && error !== "이름을 입력해주세요." && (
                    <p role="alert" style={{ fontSize: "var(--type-label)", color: "var(--text-error)", marginTop: "-0.35rem", marginBottom: "1.35rem", fontWeight: 650, wordBreak: "keep-all" }}>
                      {error}
                    </p>
                  )}
                  {rosterNameGuard && (
                    <div
                      id="student-roster-name-guard"
                      className="student-roster-name-guard"
                      role="alert"
                      style={{
                        marginTop: "-0.35rem",
                        marginBottom: "1.35rem",
                        padding: "0.85rem 0.95rem",
                        borderRadius: "var(--radius-md)",
                        border: "1px solid var(--warning-line)",
                        background: "var(--warning-soft)",
                        color: "var(--foreground)",
                        fontSize: "var(--type-label)",
                        lineHeight: 1.55,
                        wordBreak: "keep-all",
                      }}
                    >
                      <p style={{ fontWeight: 700, color: "var(--text-warning)" }}>
                        ‘{rosterNameGuard.name}’을(를) 이 반 명단에서 찾지 못했어요.
                      </p>
                      {rosterNameGuard.suggestion ? (
                        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem 0.75rem", marginTop: "0.5rem" }}>
                          <span>혹시 ‘{rosterNameGuard.suggestion}’인가요?</span>
                          <button
                            type="button"
                            className="btn btn-primary"
                            onClick={() => handleUseSuggestedRosterName(rosterNameGuard.suggestion!)}
                            style={{ minHeight: 44, padding: "0.45rem 0.85rem", fontSize: "var(--type-label)" }}
                          >
                            이 이름으로 바꾸기
                          </button>
                        </div>
                      ) : (
                        <p style={{ marginTop: "0.35rem", color: "var(--muted)" }}>
                          이름 띄어쓰기와 반을 다시 확인해주세요.
                        </p>
                      )}
                      {process.env.NODE_ENV !== "production" && (
                        confirmUnrosteredStudent ? (
                          <div style={{ marginTop: "0.65rem", paddingTop: "0.65rem", borderTop: "1px solid var(--warning-line)" }}>
                            <p style={{ color: "var(--muted)" }}>
                              명단과 연결되지 않은 새 학생 기록을 만들어요. 계속할까요?
                            </p>
                            <button
                              type="button"
                              className="btn"
                              disabled={studentLoginPending}
                              onClick={() => { void handleStudentLogin({ allowUnrosteredName: true }); }}
                              style={{ minHeight: 44, marginTop: "0.45rem", padding: "0.45rem 0.85rem", fontSize: "var(--type-label)" }}
                            >
                              새 학생으로 시작하기
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setConfirmUnrosteredStudent(true)}
                            style={{
                              minHeight: 44,
                              marginTop: "0.55rem",
                              padding: "0.45rem 0.2rem",
                              background: "transparent",
                              border: "none",
                              color: "var(--muted)",
                              fontSize: "var(--type-label)",
                              textDecoration: "underline",
                            }}
                          >
                            명단에 없는 새 학생으로 시작
                          </button>
                        )
                      )}
                    </div>
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

                <button
                  type="submit"
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

                <div style={{ margin: "0.35rem 0 0.75rem" }}>
                  <label
                    htmlFor="remember-student-device"
                    style={{
                      minHeight: 44,
                      display: "flex",
                      alignItems: "center",
                      gap: "0.65rem",
                      color: "var(--foreground)",
                      fontSize: "var(--type-label)",
                      fontWeight: 700,
                      cursor: "pointer",
                    }}
                  >
                    <input
                      id="remember-student-device"
                      type="checkbox"
                      aria-describedby="remember-student-device-help"
                      checked={rememberStudentOnDevice}
                      onChange={(event) => setRememberStudentOnDevice(event.target.checked)}
                    />
                    이 기기에서 내 정보 기억하기
                  </label>
                  {/* Kept outside the <label> so the checkbox's name stays short
                      (the helper mentions "이름", which would collide with the name field). */}
                  <small
                    id="remember-student-device-help"
                    style={{ display: "block", marginTop: "-0.2rem", paddingLeft: "1.65rem", color: "var(--muted)", fontSize: "var(--type-caption)", fontWeight: 550, lineHeight: 1.5, wordBreak: "keep-all" }}
                  >
                    다음 로그인 때 이름·반을 채워둬요. 보안을 위해 12시간마다 시작 코드를 다시 확인해요. 공용 기기에서는 선택하지 마세요.
                  </small>
                </div>

                <p style={{ fontSize: "var(--type-caption)", color: "var(--muted)", margin: "0 0 0.75rem", lineHeight: 1.5, wordBreak: "keep-all" }}>
                  {requiresServerStudentVerification
                    ? "* 선생님이 발급한 초대 링크와 시작 코드로 서버 명단을 확인합니다."
                    : "* 현재 기기에 저장된 명단과 시작 코드로 로그인합니다."}
                </p>
                </form>
                )}

                {directStudentLogin && error && (
                  <p
                    id="student-login-feedback"
                    role="alert"
                    style={{ fontSize: "var(--type-label)", color: "var(--text-error)", marginBottom: "1.35rem", fontWeight: 650, wordBreak: "keep-all" }}
                  >
                    {error}
                  </p>
                )}

                {requiresServerStudentVerification ? (
                  <section
                    className="student-invite-guest-restriction"
                    role="note"
                    style={{
                      padding: "0.9rem 1rem",
                      borderRadius: "var(--radius-md)",
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      color: "var(--muted)",
                      fontSize: "var(--type-label)",
                      lineHeight: 1.6,
                    }}
                  >
                    <strong style={{ display: "block", color: "var(--foreground)", marginBottom: "0.2rem" }}>
                      그룹 초대 시험은 등록된 학생만 참여할 수 있습니다.
                    </strong>
                    게스트로 시험을 볼 수 없는 링크입니다. 계정 정보가 없거나 시작 코드를 잃어버렸다면 선생님이 보낸 최신 초대 링크를 확인하고 코드 재발급을 요청해주세요.
                  </section>
                ) : (
                  <details className="student-alternate-entry">
                  <summary>다른 방법으로 참여</summary>
                  <div className="student-alternate-entry-content">
                    <div>
                      <label htmlFor="guest-group-code">반 코드</label>
                      <input
                        id="guest-group-code"
                        type="text"
                        className="input-field"
                        value={guestGroupCode}
                        onChange={(e) => {
                          setGuestGroupCode(e.target.value);
                          clearLoginError();
                        }}
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
                      }}
                    >
                      반 코드로 게스트 시험보기
                    </button>

                    <button
                      type="button"
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
                  </div>
                  </details>
                )}
              </>
            )}
          </div>
          )}
        </div>
      </main>
    </div>
  );
}
