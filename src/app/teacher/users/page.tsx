"use client";

import { Suspense, useState, useMemo, useEffect, useRef, useDeferredValue } from "react";
import { useSearchParams } from "next/navigation";
import NextLink from "next/link";
import TeacherHeader from "@/components/TeacherHeader";
import StatusPill from "@/components/dashboard/StatusPill";
import {
    Users,
    UserPlus,
    Upload,
    Search,
    MessageCircle,
    TrendingUp,
    TrendingDown,
    MoreVertical,
    FolderPlus,
    CheckCircle2,
    Clock,
    X,
    Trash2,
    Download,
    PenLine,
    AlertTriangle,
    Copy,
    KeyRound,
    Lock,
    MapPin,
} from "lucide-react";
import { toast } from "@/components/Toast";
import type { Attempt, Exam } from "@/types/omr";
import { decodeCsvBytes, parseCsvRows, serializeCsvRows } from "@/lib/csv";
import { shouldUseDemoData } from "@/lib/demoData";
import { readTeacherSession } from "@/lib/teacherSession";
import {
    loadTeacherAttemptSummaries,
    loadTeacherAttempts,
    resolveTeacherAttemptCollectionCompleteness,
    type TeacherAttemptCollectionLoadResult,
} from "@/lib/teacherAttemptClient";
import { loadTeacherExams } from "@/lib/teacherExamClient";
import {
    loadTeacherRosterSnapshot,
    ROSTER_REVISION_CONFLICT_ERROR,
    saveTeacherRosterSnapshot,
} from "@/lib/teacherRosterClient";
import { issueStudentCredentialBatch } from "@/app/actions/studentAuth";
import StudentCredentialBatchDialog, {
    type FrozenCredentialStudent,
} from "@/components/StudentCredentialBatchDialog";
import { resolveAttemptScore } from "@/lib/attemptScores";
import {
    applyRosterPerformance,
    buildRosterPerformanceMap,
    recomputeRosterGroupsFromStudents,
} from "@/lib/rosterAnalytics";
import {
    AVATAR_COLORS,
    GROUP_COLORS,
    ROSTER_STORAGE_KEYS,
    disambiguateRosterStudentId,
    hasStoredRosterData,
    readRosterGroups,
    readRosterInvites,
    readRosterStudents,
    rosterGroupScopeKey,
    rosterStudentFallbackId,
    type RosterGroup,
    type RosterInvite,
    type RosterStudent,
} from "@/lib/rosterStorage";
import { addRosterGroup, deleteRosterGroup, editRosterGroup } from "@/lib/rosterMutations";
import {
    applyRosterCsvConflictDispositions,
    buildRosterCsvImportPlan,
    type RosterCsvConflictDisposition,
    type RosterCsvImportPlan,
} from "@/lib/rosterCsvImport";
import { buildStudentProfileInsight, type StudentProfileInsight } from "@/lib/studentProfileAnalytics";
import { buildGroupProfileInsight, type GroupProfileInsight } from "@/lib/groupProfileAnalytics";
import {
    DEFAULT_REGION_NAME,
    buildRegionalLearningScopes,
    regionKeyFor,
    type RegionalLearningScope,
} from "@/lib/regionalAnalytics";
import {
    STUDENT_CODES_STORAGE_KEY,
} from "@/lib/studentCodes";
import { hasPlanEntitlement } from "@/utils/plans";
import { useServerPlan } from "@/lib/useServerPlan";
import { buildStudentResultHref } from "@/lib/studentResultHub";
import { studentIdFor } from "@/utils/storage";
import {
    KPI,
    MiniStat,
    MiniRegionMetric,
    RegionalAverageMetric,
    SortableHeaderButton,
    GroupProfileModal,
    StudentProfileModal,
    StudentModal,
    GroupModal,
    GroupMoveModal,
    CsvImportPreviewModal,
    InviteModal,
    MessageModal,
    ConfirmModal,
    hasArchivedHandwriting,
    handwritingLabel,
    groupOptionLabel,
    rosterGroupForStudentInput,
} from "@/components/teacher/users/parts";
import GroupsTab from "@/components/teacher/users/GroupsTab";
import InvitesTab from "@/components/teacher/users/InvitesTab";
import { ALL_REGION_KEY } from "@/components/teacher/users/parts";
import type { StudentFormData, GroupFormData, SortKey, SortDirection, ConfirmAction } from "@/components/teacher/users/parts";
import {
    INITIAL_CAPACITY_EXCEEDED_ERROR,
    INITIAL_CAPACITY_REMEDIATION_KO,
} from "@/lib/initialOperationsPolicy";
import { resolveCanonicalLoad, type CanonicalLoadState } from "@/lib/canonicalLoadState";

type TabType = "students" | "groups" | "invites";
type RosterDataMode = "real" | "demo";
type CanonicalRosterData = {
    students: RosterStudent[];
    groups: RosterGroup[];
    invites: RosterInvite[];
    forceDemo?: boolean;
};
const TEACHER_ROSTER_CACHE_STALE_AT_KEY = "omr_teacher_roster_cache_stale_at_v1";

function isCanonicalRosterEmpty(data: CanonicalRosterData): boolean {
    return data.forceDemo !== true
        && data.students.length === 0
        && data.groups.length === 0
        && data.invites.length === 0;
}

function isCompleteTeacherAttemptCollection(result: TeacherAttemptCollectionLoadResult): boolean {
    return resolveTeacherAttemptCollectionCompleteness(result) === "ready";
}

type PendingDeleteUndo = {
    id: number;
    students: RosterStudent[];
    label: string;
};

const DELETE_UNDO_WINDOW_MS = 6000;
const STUDENT_CREDENTIAL_STATUS_STORAGE_KEY = "omr_student_credential_status_v1";

function readIssuedStudentCredentialIds(storage: Pick<Storage, "getItem">): Set<string> {
    try {
        const parsed = JSON.parse(storage.getItem(STUDENT_CREDENTIAL_STATUS_STORAGE_KEY) || "[]") as unknown;
        if (!Array.isArray(parsed)) return new Set();
        return new Set(parsed.filter((value): value is string => typeof value === "string" && !!value.trim()));
    } catch {
        return new Set();
    }
}

function writeIssuedStudentCredentialIds(
    storage: Pick<Storage, "setItem">,
    studentIds: Set<string>,
): boolean {
    try {
        storage.setItem(STUDENT_CREDENTIAL_STATUS_STORAGE_KEY, JSON.stringify([...studentIds]));
        return true;
    } catch {
        return false;
    }
}

const MOCK_STUDENTS: RosterStudent[] = Array.from({ length: 24 }).map((_, i) => {
    const names = ["김민준", "이서연", "박도윤", "최예은", "정하준", "강지우", "조시우", "윤수아", "장재윤", "임유나", "한건우", "오하윤", "서지호", "신서아", "권선우", "황지민", "안윤서", "송태호", "류예준", "홍채원", "전주원", "고은서", "문이준", "양리아"];
    const groups = ["3학년 A반", "3학년 B반", "2학년 A반", "2학년 B반", "1학년 A반"];
    const regions = ["서울", "서울", "부산", "부산", "온라인"];
    return {
        id: `s-${i}`,
        name: names[i],
        email: `${names[i].toLowerCase().replace(/\s/g, '')}${i}@school.ac.kr`,
        group: groups[i % groups.length],
        region: regions[i % regions.length],
        avatar: AVATAR_COLORS[i % AVATAR_COLORS.length],
        avgScore: 55 + ((i * 7) % 40),
        examsTaken: 3 + ((i * 5) % 15),
        lastActive: `${1 + ((i * 11) % 48)}시간 전`,
        trend: (["up", "down", "flat"] as const)[i % 3],
        status: i % 4 === 0 ? "idle" : "active",
    };
});

const MOCK_GROUPS: RosterGroup[] = [
    { id: "g1", name: "3학년 A반", region: "서울", count: 28, avgScore: 82, color: "#4f46e5" },
    { id: "g2", name: "3학년 B반", region: "서울", count: 26, avgScore: 78, color: "#ec4899" },
    { id: "g3", name: "2학년 A반", region: "부산", count: 30, avgScore: 75, color: "#8b5cf6" },
    { id: "g4", name: "2학년 B반", region: "부산", count: 29, avgScore: 80, color: "#10b981" },
    { id: "g5", name: "1학년 A반", region: "온라인", count: 25, avgScore: 73, color: "#f59e0b" },
];

const MOCK_INVITES: RosterInvite[] = [
    { id: "i1", email: "new.student1@school.ac.kr", sentAt: "2시간 전", status: "pending" },
    { id: "i2", email: "new.student2@school.ac.kr", sentAt: "어제", status: "pending" },
    { id: "i3", email: "parent.notify@gmail.com", sentAt: "3일 전", status: "accepted" },
    { id: "i4", email: "transferred@school.ac.kr", sentAt: "1주 전", status: "expired" },
];

function isLegacyDemoRosterSnapshot(
    students: RosterStudent[],
    groups: RosterGroup[],
    invites: RosterInvite[],
): boolean {
    return students.length === MOCK_STUDENTS.length
        && students.every((student, index) => {
            const demo = MOCK_STUDENTS[index];
            return student.id === demo.id
                && student.name === demo.name
                && student.email === demo.email
                && student.group === demo.group;
        })
        && groups.length === MOCK_GROUPS.length
        && groups.every((group, index) => group.id === MOCK_GROUPS[index].id && group.name === MOCK_GROUPS[index].name)
        && invites.length === MOCK_INVITES.length
        && invites.every((invite, index) => invite.id === MOCK_INVITES[index].id && invite.email === MOCK_INVITES[index].email);
}


function studentIdForRoster(name: string, groupName: string, groups: RosterGroup[], region = "", groupId = ""): string {
    const group = rosterGroupForStudentInput(groupName, region, groups, groupId);
    return group ? studentIdFor(name, group.id) : rosterStudentFallbackId(name, groupName, region);
}

function uniqueStudentIdForRoster(baseId: string, emailKey: string, students: RosterStudent[]): string {
    const idTakenByOtherEmail = students.some(student => student.id === baseId && normalizeEmail(student.email) !== emailKey);
    if (!idTakenByOtherEmail) return baseId;
    return disambiguateRosterStudentId(baseId, emailKey);
}

function sortAriaValue(
    sortState: { key: SortKey; direction: SortDirection } | null,
    key: SortKey,
): React.AriaAttributes["aria-sort"] {
    if (sortState?.key !== key) return "none";
    return sortState.direction === "asc" ? "ascending" : "descending";
}

function nextGroupColor(index: number): string {
    return GROUP_COLORS[index % GROUP_COLORS.length];
}

function optionalRegion(value: string): { region?: string } {
    const region = value.trim();
    return region ? { region } : {};
}

function rosterStudentRegionName(student: RosterStudent, groups: RosterGroup[]): string {
    const direct = student.region?.trim();
    if (direct) return direct;
    const group = groups.find(item => item.name === student.group);
    return group?.region?.trim() || DEFAULT_REGION_NAME;
}

function regionLabel(scope: RegionalLearningScope): string {
    return scope.regionName || DEFAULT_REGION_NAME;
}

function normalizeEmail(value: string): string {
    return value.trim().toLowerCase();
}

export default function ManageUsersPage() {
    return (
        <Suspense fallback={<div style={{ minHeight: '100vh' }} />}>
            <ManageUsersInner />
        </Suspense>
    );
}

function ManageUsersInner() {
    const searchParams = useSearchParams();
    const initialTab: TabType = (() => {
        const t = searchParams?.get("tab");
        if (t === "groups" || t === "invites" || t === "students") return t;
        return "students";
    })();
    // Deep-link targets from GlobalSearch (or any other cross-link): a specific
    // student opens the detail panel, a specific group opens its profile modal.
    // Both are re-derived from searchParams so navigating here again with a new
    // id (while already mounted) re-applies the target instead of no-op'ing.
    const initialStudentId = searchParams?.get("studentId") || null;
    const initialGroupId = searchParams?.get("groupId") || null;
    const [tab, setTab] = useState<TabType>(initialTab);
    useEffect(() => {
        // Keep deep links like /teacher/users?tab=groups on the requested workflow.
        setTab(initialTab);
    }, [initialTab]);
    const [query, setQuery] = useState("");
    const deferredQuery = useDeferredValue(query);
    const [selectedRegionKey, setSelectedRegionKey] = useState(ALL_REGION_KEY);
    const [selectedId, setSelectedId] = useState<string | null>(initialStudentId);
    useEffect(() => {
        if (initialStudentId) setSelectedId(initialStudentId);
    }, [initialStudentId]);

    const [students, setStudents] = useState<RosterStudent[]>([]);
    const [groups, setGroups] = useState<RosterGroup[]>([]);
    const [invites, setInvites] = useState<RosterInvite[]>([]);
    const [rosterDataMode, setRosterDataMode] = useState<RosterDataMode>("real");
    const [allAttempts, setAllAttempts] = useState<Attempt[]>([]);
    const [attemptAnalyticsStatus, setAttemptAnalyticsStatus] = useState<"loading" | "ready" | "unavailable">("loading");
    const [detailedAttempts, setDetailedAttempts] = useState<Attempt[] | null>(null);
    const detailedAttemptLoadRef = useRef<Promise<Attempt[] | null> | null>(null);
    const [exams, setExams] = useState<Exam[]>([]);
    const [issuedStudentCredentialIds, setIssuedStudentCredentialIds] = useState<Set<string>>(new Set());
    const rosterMutationVersionRef = useRef(0);
    const issuedStudentCredentialIdsRef = useRef<Set<string>>(new Set());
    const { plan: currentPlan } = useServerPlan();
    const [hydrated, setHydrated] = useState(false);
    const [rosterLoadState, setRosterLoadState] = useState<CanonicalLoadState<CanonicalRosterData>>({ state: "loading" });
    const [rosterRetryGeneration, setRosterRetryGeneration] = useState(0);
    const rosterAllowsMutations = rosterLoadState.state === "loaded_empty" || rosterLoadState.state === "loaded_data";
    const rosterMutationsDisabled = !rosterAllowsMutations;
    const studentGrowthReportsEnabled = hasPlanEntitlement(currentPlan, "studentGrowthReports");
    const advancedAnalyticsEnabled = hasPlanEntitlement(currentPlan, "advancedAnalytics");
    const retakeAssignmentsEnabled = hasPlanEntitlement(currentPlan, "retakeAssignments");

    // UI state for modals/popovers
    const [showStudentModal, setShowStudentModal] = useState(false);
    const [editingStudent, setEditingStudent] = useState<RosterStudent | null>(null);
    const [showGroupModal, setShowGroupModal] = useState(false);
    const [editingGroup, setEditingGroup] = useState<RosterGroup | null>(null);
    const [studentModalDefaultGroupId, setStudentModalDefaultGroupId] = useState<string | undefined>(undefined);
    const [showGroupProfileModal, setShowGroupProfileModal] = useState(false);
    const [showInviteModal, setShowInviteModal] = useState(false);
    const [showMessageModal, setShowMessageModal] = useState(false);
    const [showProfileModal, setShowProfileModal] = useState(false);
    const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
    const [popoverId, setPopoverId] = useState<string | null>(null);
    const popoverTriggerRef = useRef<HTMLButtonElement | null>(null);
    const copyFlash = false;
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const [showGroupMoveModal, setShowGroupMoveModal] = useState(false);
    const [pendingDeleteUndo, setPendingDeleteUndo] = useState<PendingDeleteUndo | null>(null);
    const [sortState, setSortState] = useState<{ key: SortKey; direction: SortDirection } | null>(null);
    const [csvPreview, setCsvPreview] = useState<RosterCsvImportPlan | null>(null);
    const [credentialBatchExpectedStudents, setCredentialBatchExpectedStudents] = useState<
        readonly FrozenCredentialStudent[] | null
    >(null);
    // T2: windowed pagination for the (potentially large) filtered roster.
    const [pageSize, setPageSize] = useState<number | "all">(50);
    const [page, setPage] = useState(1);

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Latest-ref indirection so a fired undo toast always runs the freshest
    // handler (which reads current state) instead of a stale closure.
    const undoDeleteRef = useRef<() => void>(() => {});

    // Hydrate real roster rows from localStorage. Demo rows stay display-only so
    // they cannot be mistaken for academy data in later sessions.
    useEffect(() => {
        let cancelled = false;
        const hydrateRoster = async () => {
            const loadObservedAt = new Date().toISOString();
            setRosterLoadState({ state: "loading" });
            setHydrated(false);
            let localData: CanonicalRosterData = { students: [], groups: [], invites: [] };
            let cachedAt: string | null = null;
            try {
                localStorage.removeItem(STUDENT_CODES_STORAGE_KEY);
                const storedRosterExists = hasStoredRosterData(localStorage);
                const storedStudents = readRosterStudents(localStorage);
                const storedGroups = readRosterGroups(localStorage);
                const storedInvites = readRosterInvites(localStorage);
                localData = { students: storedStudents, groups: storedGroups, invites: storedInvites };
                cachedAt = localStorage.getItem(TEACHER_ROSTER_CACHE_STALE_AT_KEY);
                const legacyDemoRoster = storedRosterExists
                    && shouldUseDemoData(readTeacherSession())
                    && isLegacyDemoRosterSnapshot(storedStudents, storedGroups, storedInvites);
                if (legacyDemoRoster) {
                    Object.values(ROSTER_STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
                }

                const rosterResult = await loadTeacherRosterSnapshot(localStorage);
                if (cancelled) return;
                const hasRosterRows = rosterResult.students.length > 0
                    || rosterResult.groups.length > 0
                    || rosterResult.invites.length > 0;
                const useDemoRoster = shouldUseDemoData(readTeacherSession()) && !hasRosterRows;
                const nextStudents = useDemoRoster ? [] : rosterResult.students;
                const nextGroups = useDemoRoster ? [] : rosterResult.groups;
                const nextInvites = useDemoRoster ? [] : rosterResult.invites;
                const loadedData: CanonicalRosterData = {
                    students: nextStudents,
                    groups: nextGroups,
                    invites: nextInvites,
                    ...(useDemoRoster ? { forceDemo: true } : {}),
                };
                const nextState = resolveCanonicalLoad({
                    remote: rosterResult.remoteError ? { ok: false } : { ok: true, data: loadedData },
                    cache: rosterResult.remoteError && cachedAt ? { data: localData, staleAt: cachedAt } : null,
                    now: loadObservedAt,
                }, isCanonicalRosterEmpty);
                // Hydrate client-only localStorage data after mount.
                const visibleData = nextState.state === "loaded_empty" || nextState.state === "loaded_data" || nextState.state === "degraded_with_cache"
                    ? nextState.data
                    : { students: [], groups: [], invites: [] };
                setStudents(visibleData.students);
                setGroups(visibleData.groups);
                setInvites(visibleData.invites);
                setRosterDataMode(useDemoRoster ? "demo" : "real");
                setRosterLoadState(nextState);
                if (!rosterResult.remoteError && rosterResult.remoteLoaded) {
                    try { localStorage.setItem(TEACHER_ROSTER_CACHE_STALE_AT_KEY, loadObservedAt); } catch { /* cache remains optional */ }
                }
                if (rosterResult.remoteError && !useDemoRoster) {
                    if (rosterResult.remoteError === INITIAL_CAPACITY_EXCEEDED_ERROR) {
                        toast.error("초기 운영 지원 범위 초과", INITIAL_CAPACITY_REMEDIATION_KO);
                    } else {
                        toast.info(
                            "명단은 로컬 기준으로 표시 중",
                            "Supabase 명단 동기화가 지연되어 현재 기기 데이터를 우선 사용했습니다."
                        );
                    }
                }
                const storedIssuedIds = readIssuedStudentCredentialIds(localStorage);
                issuedStudentCredentialIdsRef.current = storedIssuedIds;
                setIssuedStudentCredentialIds(storedIssuedIds);
            } catch {
                if (cancelled) return;
                const nextState = resolveCanonicalLoad({
                    remote: { ok: false },
                    cache: cachedAt ? { data: localData, staleAt: cachedAt } : null,
                    now: loadObservedAt,
                }, isCanonicalRosterEmpty);
                const visibleData = nextState.state === "degraded_with_cache"
                    ? nextState.data
                    : { students: [], groups: [], invites: [] };
                setStudents(visibleData.students);
                setGroups(visibleData.groups);
                setInvites(visibleData.invites);
                setRosterDataMode("real");
                setRosterLoadState(nextState);
            }
            setHydrated(true);
        };

        void hydrateRoster();
        return () => { cancelled = true; };
    }, [rosterRetryGeneration]);

    useEffect(() => {
        let cancelled = false;
        const loadRosterAnalytics = async () => {
            const [attemptResult, examResult] = await Promise.all([
                loadTeacherAttemptSummaries(),
                loadTeacherExams(),
            ]);
            if (cancelled) return;
            const isDemoSession = shouldUseDemoData(readTeacherSession());
            const attemptAnalyticsComplete = isDemoSession || isCompleteTeacherAttemptCollection(attemptResult);
            setAllAttempts(attemptAnalyticsComplete ? attemptResult.items : []);
            setAttemptAnalyticsStatus(attemptAnalyticsComplete ? "ready" : "unavailable");
            setExams(examResult.items);
            if (!attemptAnalyticsComplete && !attemptResult.remoteError) {
                toast.error(
                    "응시 분석 표본 불완전",
                    "서버 응시 기록을 모두 불러오지 못해 평균·지역·학생 리포트를 표시하지 않습니다.",
                );
            }
            if ((attemptResult.remoteError || examResult.remoteError) && !isDemoSession) {
                if (
                    attemptResult.remoteError === INITIAL_CAPACITY_EXCEEDED_ERROR
                    || examResult.remoteError === INITIAL_CAPACITY_EXCEEDED_ERROR
                ) {
                    toast.error("초기 운영 지원 범위 초과", INITIAL_CAPACITY_REMEDIATION_KO);
                } else if (attemptResult.remoteError) {
                    toast.info(
                        "응시 분석을 일시 중단",
                        "서버 응시 기록을 완전하게 확인할 수 없어 평균·지역·학생 리포트를 표시하지 않습니다.",
                    );
                } else {
                    toast.info(
                        "시험 정보는 로컬 기준으로 표시 중",
                        "서버 시험 정보 동기화가 지연되어 현재 기기 데이터를 우선 사용했습니다."
                    );
                }
            }
        };

        void loadRosterAnalytics().catch(() => {
            if (cancelled) return;
            setAllAttempts([]);
            setAttemptAnalyticsStatus("unavailable");
            toast.error(
                "응시 분석을 일시 중단",
                "서버 응시 기록을 확인하지 못해 평균·지역·학생 리포트를 표시하지 않습니다.",
            );
        });
        return () => { cancelled = true; };
    }, []);

    // M7: dismiss the row action popover on outside click or Escape.
    useEffect(() => {
        if (!popoverId) return;
        const handlePointerDown = (event: MouseEvent) => {
            const target = event.target;
            if (target instanceof Element && target.closest("[data-teacher-user-popover-root]")) return;
            setPopoverId(null);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setPopoverId(null);
            requestAnimationFrame(() => {
                const trigger = popoverTriggerRef.current;
                if (trigger?.isConnected) trigger.focus({ preventScroll: true });
            });
        };
        document.addEventListener("mousedown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("mousedown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [popoverId]);

    useEffect(() => () => {
        if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    }, []);

    useEffect(() => {
        if (!rosterMutationsDisabled) return;
        setSelectedIds(new Set());
        setPopoverId(null);
        setShowStudentModal(false);
        setShowGroupModal(false);
        setShowInviteModal(false);
        setShowMessageModal(false);
        setConfirmAction(null);
        setShowGroupMoveModal(false);
        setCsvPreview(null);
        setCredentialBatchExpectedStudents(null);
    }, [rosterMutationsDisabled]);

    // Write-through helpers
    const persistRoster = (nextStudents: RosterStudent[], nextGroups: RosterGroup[], nextInvites: RosterInvite[]) => {
        if (rosterMutationsDisabled) {
            toast.info("읽기 전용 명단", "최신 서버 명단을 확인한 뒤 변경할 수 있습니다.");
            return;
        }
        const mutationVersion = ++rosterMutationVersionRef.current;
        const previousSnapshot = { students, groups, invites };
        setRosterDataMode("real");
        setStudents(nextStudents);
        setGroups(nextGroups);
        setInvites(nextInvites);
        setSelectedId(prev => nextStudents.some(student => student.id === prev) ? prev : null);
        setSelectedIds(prev => {
            const validIds = new Set(nextStudents.map(student => student.id));
            const filteredIds = [...prev].filter(id => validIds.has(id));
            return filteredIds.length === prev.size ? prev : new Set(filteredIds);
        });
        setSelectedGroupId(prev => nextGroups.some(group => group.id === prev) ? prev : null);
        void saveTeacherRosterSnapshot(localStorage, {
            students: nextStudents,
            groups: nextGroups,
            invites: nextInvites,
        }).then(result => {
            if (result.remoteError && !result.localSaved && mutationVersion === rosterMutationVersionRef.current) {
                setStudents(previousSnapshot.students);
                setGroups(previousSnapshot.groups);
                setInvites(previousSnapshot.invites);
                if (result.remoteError === ROSTER_REVISION_CONFLICT_ERROR) {
                    toast.error(
                        "다른 기기에서 명단이 변경됨",
                        "방금 변경을 되돌렸습니다. 새로고침해 최신 명단을 확인한 뒤 다시 시도해주세요."
                    );
                } else {
                    toast.error(
                        "명단 저장 실패",
                        "서버에 저장되지 않아 방금 변경을 되돌렸습니다. 연결 상태를 확인한 뒤 다시 시도해주세요."
                    );
                }
            }
        });
        // The canonical server save now synchronizes reductions and same-size
        // edits atomically. Growth paths still preflight below for immediate UI
        // feedback, without racing a second post-save ledger mutation.
    };

    // The account-bound roster RPC is the only quota mutation boundary. The UI
    // applies optimistically and rolls back on the server's atomic plan denial.
    const authorizeRosterMutation = async (nextStudents: RosterStudent[]): Promise<boolean> => {
        void nextStudents;
        return rosterAllowsMutations;
    };

    // Recompute group stats from current students
    const recomputeGroups = (studentsList: RosterStudent[], groupsList: RosterGroup[]): RosterGroup[] => (
        recomputeRosterGroupsFromStudents(studentsList, groupsList)
    );

    const examById = useMemo(() => (
        new Map(exams.map(exam => [exam.id, exam]))
    ), [exams]);

    const isDemoRoster = rosterDataMode === "demo";
    const attemptAnalyticsAvailable = isDemoRoster || attemptAnalyticsStatus === "ready";
    const rosterStudents = isDemoRoster ? MOCK_STUDENTS : students;
    const rosterGroups = isDemoRoster ? MOCK_GROUPS : groups;
    const rosterInvites = isDemoRoster ? MOCK_INVITES : invites;

    const performanceByStudentId = useMemo(() => (
        buildRosterPerformanceMap(rosterStudents, allAttempts, examById)
    ), [rosterStudents, allAttempts, examById]);

    const profileAttempts = detailedAttempts || allAttempts;
    const profilePerformanceByStudentId = useMemo(() => (
        buildRosterPerformanceMap(rosterStudents, profileAttempts, examById)
    ), [rosterStudents, profileAttempts, examById]);

    const displayStudents = useMemo(() => (
        applyRosterPerformance(rosterStudents, performanceByStudentId)
    ), [rosterStudents, performanceByStudentId]);
    const credentialBatchCurrentStudents = useMemo<readonly FrozenCredentialStudent[]>(() => {
        if (!credentialBatchExpectedStudents) return [];
        const expectedIds = new Set(credentialBatchExpectedStudents.map(student => student.studentId));
        return displayStudents
            .filter(student => expectedIds.has(student.id))
            .map(student => ({ studentId: student.id, name: student.name, group: student.group }));
    }, [credentialBatchExpectedStudents, displayStudents]);
    const hasStudentRosterData = displayStudents.length > 0;
    // Keep the established controls while the client snapshot is hydrating, then
    // collapse to the single empty-state action set when the real roster is empty.
    const showStudentListControls = !hydrated || hasStudentRosterData;

    const displayGroups = useMemo(() => (
        recomputeRosterGroupsFromStudents(displayStudents, rosterGroups)
    ), [displayStudents, rosterGroups]);

    const regionalScopes = useMemo(() => (
        buildRegionalLearningScopes({
            students: displayStudents,
            groups: displayGroups,
            attempts: profileAttempts,
            exams,
        })
    ), [displayStudents, displayGroups, profileAttempts, exams]);

    const activeRegionKey = selectedRegionKey === ALL_REGION_KEY || regionalScopes.some(scope => scope.regionKey === selectedRegionKey)
        ? selectedRegionKey
        : ALL_REGION_KEY;
    const activeRegionName = activeRegionKey === ALL_REGION_KEY
        ? "전체 지역"
        : regionLabel(regionalScopes.find(scope => scope.regionKey === activeRegionKey) || {
            regionKey: regionKeyFor(DEFAULT_REGION_NAME),
            regionName: DEFAULT_REGION_NAME,
            studentCount: 0,
            groupCount: 0,
            attemptCount: 0,
            retakeAttemptCount: 0,
            examCount: 0,
            averageScore: 0,
            groupNames: [],
        });
    const normalizedQuery = deferredQuery.trim().toLowerCase();
    const filtered = useMemo(() =>
        displayStudents.filter(s => {
            const studentRegion = rosterStudentRegionName(s, displayGroups);
            const matchesRegion = activeRegionKey === ALL_REGION_KEY || regionKeyFor(studentRegion) === activeRegionKey;
            const matchesQuery = !normalizedQuery
                || s.name.toLowerCase().includes(normalizedQuery)
                || s.email.toLowerCase().includes(normalizedQuery)
                || s.group.toLowerCase().includes(normalizedQuery)
                || studentRegion.toLowerCase().includes(normalizedQuery);
            return matchesRegion && matchesQuery;
        }), [activeRegionKey, normalizedQuery, displayStudents, displayGroups]);

    // DEV-B: sortable table headers. lastActive is only stored as a
    // formatted Korean relative-time label ("2시간 전"), so derive a real
    // timestamp from the underlying attempts for chronological sorting.
    const lastActiveTimestampByStudentId = useMemo(() => {
        const map = new Map<string, number>();
        for (const student of displayStudents) {
            const attempts = performanceByStudentId.get(student.id)?.attempts || [];
            let latest = 0;
            for (const attempt of attempts) {
                const time = Date.parse(attempt.finishedAt || attempt.startedAt || "") || 0;
                if (time > latest) latest = time;
            }
            map.set(student.id, latest);
        }
        return map;
    }, [displayStudents, performanceByStudentId]);

    const toggleSort = (key: SortKey) => {
        setSortState(prev => {
            if (!prev || prev.key !== key) return { key, direction: "asc" };
            if (prev.direction === "asc") return { key, direction: "desc" };
            return null; // third click resets to the default (unsorted) order
        });
    };

    const sortedFiltered = useMemo(() => {
        if (!sortState) return filtered;
        const { key, direction } = sortState;
        const dir = direction === "asc" ? 1 : -1;
        return filtered
            .map((student, index) => ({ student, index }))
            .sort((a, b) => {
                let comparison = 0;
                if (key === "name") {
                    comparison = a.student.name.localeCompare(b.student.name, "ko");
                } else if (key === "avgScore") {
                    comparison = a.student.avgScore - b.student.avgScore;
                } else if (key === "examsTaken") {
                    comparison = a.student.examsTaken - b.student.examsTaken;
                } else {
                    comparison = (lastActiveTimestampByStudentId.get(a.student.id) || 0)
                        - (lastActiveTimestampByStudentId.get(b.student.id) || 0);
                }
                // Stable tie-break: preserve the original (default) order.
                return comparison !== 0 ? comparison * dir : a.index - b.index;
            })
            .map(item => item.student);
    }, [filtered, sortState, lastActiveTimestampByStudentId]);

    // T2: windowed pagination. Selection (selectedIds) intentionally spans the
    // whole filtered set, not just the visible page, so paging never drops a
    // selection. "전체 선택" toggles the entire filtered set (see the header
    // checkbox + labeled control below).
    const totalRows = sortedFiltered.length;
    const pageCount = pageSize === "all" ? 1 : Math.max(1, Math.ceil(totalRows / pageSize));
    const clampedPage = Math.min(page, pageCount);
    const pageStart = pageSize === "all" ? 0 : (clampedPage - 1) * pageSize;
    const pageEnd = pageSize === "all" ? totalRows : Math.min(pageStart + pageSize, totalRows);
    const pagedStudents = pageSize === "all" ? sortedFiltered : sortedFiltered.slice(pageStart, pageEnd);

    // Reset to the first page whenever the filtered set or window size changes,
    // so the pager never strands the teacher on an out-of-range page.
    useEffect(() => {
        setPage(1);
    }, [deferredQuery, activeRegionKey, pageSize]);

    const selected = displayStudents.find(s => s.id === selectedId);
    const selectedGroup = displayGroups.find(group => group.id === selectedGroupId) || null;
    const selectedCredentialIssued = !!selected && issuedStudentCredentialIds.has(selected.id);

    // The shared roster performance index already applies strict stable-id and
    // unambiguous legacy matching, and stores each bucket newest first.
    const selectedMatchedAttempts = useMemo<Attempt[]>(() => {
        if (!selected) return [];
        return profilePerformanceByStudentId.get(selected.id)?.attempts || [];
    }, [profilePerformanceByStudentId, selected]);

    const selectedRecentAttempts = selectedMatchedAttempts.slice(0, 3);
    const latestStableAttempt = selectedMatchedAttempts[0] || null;

    const selectedProfile = useMemo<StudentProfileInsight | null>(() => {
        if (!selected) return null;
        return buildStudentProfileInsight(selected, selectedMatchedAttempts, examById, {
            recentLimit: 8,
            weaknessLimit: 6,
        });
    }, [selected, selectedMatchedAttempts, examById]);

    const selectedHandwritingCount = selectedProfile?.handwritingArchiveCount ?? 0;

    const selectedGroupProfile = useMemo<GroupProfileInsight | null>(() => {
        if (!selectedGroup) return null;
        return buildGroupProfileInsight(selectedGroup, displayStudents, profileAttempts, examById, {
            examLimit: 6,
            weaknessLimit: 6,
            riskLimit: 5,
        });
    }, [selectedGroup, displayStudents, profileAttempts, examById]);

    const ensureDetailedAttempts = async (): Promise<Attempt[] | null> => {
        if (detailedAttempts) return detailedAttempts;
        if (detailedAttemptLoadRef.current) return detailedAttemptLoadRef.current;
        const pending = loadTeacherAttempts().then(result => {
            if (result.remoteError) {
                setAllAttempts([]);
                setAttemptAnalyticsStatus("unavailable");
                throw new Error(result.remoteError);
            }
            if (!isCompleteTeacherAttemptCollection(result)) {
                setAllAttempts([]);
                setAttemptAnalyticsStatus("unavailable");
                throw new Error("서버 응시 기록을 모두 불러오지 못해 상세 분석을 중단했습니다.");
            }
            setDetailedAttempts(result.items);
            return result.items;
        }).catch(error => {
            toast.error(
                "상세 분석 로드 실패",
                error instanceof Error ? error.message : "상세 제출 데이터를 불러오지 못했습니다.",
            );
            return null;
        }).finally(() => {
            detailedAttemptLoadRef.current = null;
        });
        detailedAttemptLoadRef.current = pending;
        return pending;
    };

    // Detail-panel button handlers
    const handleSendMessage = () => {
        if (rosterMutationsDisabled) {
            toast.info("읽기 전용 명단", "최신 서버 명단을 확인한 뒤 메시지를 준비할 수 있습니다.");
            return;
        }
        if (isDemoRoster) {
            toast.info("데모 명단은 전송하지 않음", "실제 학생을 추가하거나 CSV로 업로드한 뒤 카카오 메시지를 준비할 수 있습니다.");
            return;
        }
        setShowMessageModal(true);
    };
    const handleOpenDetail = async () => {
        if (!studentGrowthReportsEnabled) {
            toast.info("학생 성장 리포트는 Pro 기능입니다", "기본 명단과 최근 점수는 확인할 수 있고, 누적 성장/취약 유형 리포트는 Pro 이상에서 열립니다.");
            return;
        }
        if (!await ensureDetailedAttempts()) return;
        if (!selectedProfile) {
            toast.info("상세 데이터를 찾을 수 없음", "학생을 다시 선택한 뒤 열어주세요.");
            return;
        }
        setShowProfileModal(true);
    };

    const handleOpenGroupProfile = async (groupId: string) => {
        if (!advancedAnalyticsEnabled) {
            toast.info("반별 분석 리포트는 Pro 기능입니다", "반 목록과 평균은 확인할 수 있고, 반별 약점/집중 관리 리포트는 Pro 이상에서 열립니다.");
            return;
        }
        if (!await ensureDetailedAttempts()) return;
        setSelectedGroupId(groupId);
        setShowGroupProfileModal(true);
    };

    // Deep link from GlobalSearch (or any other cross-link): /teacher/users?tab=groups&groupId=<id>
    // opens that group's profile the same way clicking "분석" on its card does.
    // Guarded to fire once per incoming id so closing the modal doesn't reopen it.
    const openedGroupDeepLinkRef = useRef<string | null>(null);
    useEffect(() => {
        if (!initialGroupId || !hydrated) return;
        if (openedGroupDeepLinkRef.current === initialGroupId) return;
        openedGroupDeepLinkRef.current = initialGroupId;
        void handleOpenGroupProfile(initialGroupId);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialGroupId, hydrated]);

    const handleCopyStudentId = async () => {
        if (!selected) return;
        try {
            await navigator.clipboard.writeText(selected.id);
            toast.success("학생번호 복사됨", `${selected.name}: ${selected.id}`);
        } catch {
            toast.error("복사 실패", "브라우저 클립보드 권한을 확인해주세요.");
        }
    };

    // ===== Student CRUD =====
    const handleAddStudent = async (data: StudentFormData) => {
        const idx = students.length;
        const selectedGroup = groups.find(group => group.id === data.groupId);
        const resolvedRegion = data.region.trim() || selectedGroup?.region || "";
        const regionPatch = optionalRegion(resolvedRegion);
        const existingGroup = rosterGroupForStudentInput(data.group, resolvedRegion, groups, data.groupId);
        const baseGroups = existingGroup
            ? groups.map(group => (
                group.id === existingGroup.id && regionPatch.region && !group.region
                    ? { ...group, region: regionPatch.region }
                    : group
            ))
            : [
                ...groups,
                {
                    id: `group:${rosterGroupScopeKey(data.group, resolvedRegion)}`,
                    name: data.group,
                    ...regionPatch,
                    count: 0,
                    avgScore: 0,
                    color: nextGroupColor(groups.length),
                },
            ];
        const emailKey = normalizeEmail(data.email);
        const baseId = studentIdForRoster(data.name, data.group, baseGroups, resolvedRegion, existingGroup?.id || data.groupId);
        const id = uniqueStudentIdForRoster(baseId, emailKey, students);
        if (students.some(student => normalizeEmail(student.email) === emailKey || student.id === id)) {
            toast.info("이미 등록된 학생", "같은 이메일 또는 학생번호의 학생이 이미 있습니다.");
            return;
        }
        const newStudent: RosterStudent = {
            id,
            name: data.name,
            email: data.email.trim(),
            group: data.group,
            ...regionPatch,
            avatar: AVATAR_COLORS[idx % AVATAR_COLORS.length],
            avgScore: 0,
            examsTaken: 0,
            lastActive: "방금 전",
            trend: "flat",
            status: "active",
        };
        const next = [newStudent, ...students];
        if (!await authorizeRosterMutation(next)) return;
        persistRoster(next, recomputeGroups(next, baseGroups), invites);
    };

    const handleEditStudent = (id: string, data: StudentFormData) => {
        if (isDemoRoster) {
            toast.info("데모 명단은 편집되지 않음", "실제 학생을 추가하거나 CSV로 업로드하면 저장 가능한 명단으로 전환됩니다.");
            return;
        }
        const selectedGroup = groups.find(group => group.id === data.groupId);
        const resolvedRegion = data.region.trim() || selectedGroup?.region || "";
        const regionPatch = optionalRegion(resolvedRegion);
        const emailKey = normalizeEmail(data.email);
        if (students.some(student => student.id !== id && normalizeEmail(student.email) === emailKey)) {
            toast.info("이미 등록된 이메일", "다른 학생이 같은 이메일을 사용 중입니다.");
            return;
        }
        const next = students.map(s => s.id === id ? {
            ...s,
            name: data.name,
            email: data.email,
            group: data.group,
            region: regionPatch.region,
        } : s);
        const targetGroup = rosterGroupForStudentInput(data.group, resolvedRegion, groups, data.groupId);
        const nextGroups = groups.map(group => (
            group.id === targetGroup?.id && regionPatch.region && !group.region
                ? { ...group, region: regionPatch.region }
                : group
        ));
        persistRoster(next, recomputeGroups(next, nextGroups), invites);
    };

    const handleDeleteStudent = (id: string) => {
        if (isDemoRoster) {
            toast.info("데모 명단은 삭제되지 않음", "실제 학생을 추가하거나 CSV로 업로드하면 저장 가능한 명단으로 전환됩니다.");
            return;
        }
        const target = students.find(s => s.id === id);
        setConfirmAction({ kind: "student", id, label: target?.name || "학생" });
        setPopoverId(null);
    };

    const purgeIssuedCredentialMarkers = (ids: string[]) => {
        const idSet = new Set(ids.filter(Boolean));
        if (idSet.size === 0) return;
        const nextIssuedIds = new Set(issuedStudentCredentialIdsRef.current);
        idSet.forEach(id => nextIssuedIds.delete(id));
        issuedStudentCredentialIdsRef.current = nextIssuedIds;
        setIssuedStudentCredentialIds(nextIssuedIds);
        writeIssuedStudentCredentialIds(localStorage, nextIssuedIds);
    };

    const clearDeleteUndoTimer = () => {
        if (undoTimeoutRef.current) {
            clearTimeout(undoTimeoutRef.current);
            undoTimeoutRef.current = null;
        }
    };

    const scheduleDeleteUndo = (removed: RosterStudent[], label: string) => {
        clearDeleteUndoTimer();
        const undoId = Date.now();
        setPendingDeleteUndo({ id: undoId, students: removed, label });
        undoTimeoutRef.current = setTimeout(() => {
            setPendingDeleteUndo(prev => (prev?.id === undoId ? null : prev));
            undoTimeoutRef.current = null;
        }, DELETE_UNDO_WINDOW_MS);
        // T3: the delete + undo affordance now lives in the toast host (the
        // bespoke fixed bar was removed). The action runs the latest undo
        // handler via a ref so it reads current roster state, and its window
        // matches the pendingDeleteUndo timer above.
        toast.action("info", `${label} 삭제됨`, undefined, {
            actionLabel: "실행 취소",
            onAction: () => undoDeleteRef.current(),
            durationMs: DELETE_UNDO_WINDOW_MS,
        });
    };

    // Removes the given students and offers a short-lived undo. Re-adding the
    // exact same ids on undo is safe against the tombstone sync mechanism in
    // rosterPersistence: nextRosterTombstones() clears a tombstone the moment
    // an id reappears in a saved snapshot (see "clears tombstones when the
    // same roster row is intentionally re-added" in rosterPersistence.test.ts),
    // so a plain persistRoster() re-add is enough — no special mutation needed.
    const removeStudentsWithUndo = (ids: string[], label: string) => {
        const idSet = new Set(ids);
        const removed = students.filter(s => idSet.has(s.id));
        if (removed.length === 0) return;
        const next = students.filter(s => !idSet.has(s.id));
        persistRoster(next, recomputeGroups(next, groups), invites);
        purgeIssuedCredentialMarkers(ids);
        scheduleDeleteUndo(removed, label);
    };

    const handleUndoDelete = async () => {
        if (!pendingDeleteUndo) return;
        clearDeleteUndoTimer();
        const restored = pendingDeleteUndo;
        setPendingDeleteUndo(null);
        const restoredIds = new Set(restored.students.map(s => s.id));
        const merged = [...restored.students, ...students.filter(s => !restoredIds.has(s.id))];
        if (!await authorizeRosterMutation(merged)) {
            setPendingDeleteUndo(restored);
            return;
        }
        persistRoster(merged, recomputeGroups(merged, groups), invites);
        toast.success("삭제 취소됨", `${restored.label} 복원했습니다.`);
    };

    // Keep the ref pointed at the freshest undo handler so the undo toast's
    // action never runs against stale roster state.
    useEffect(() => {
        undoDeleteRef.current = handleUndoDelete;
    });

    const deleteStudent = (id: string) => {
        const target = students.find(s => s.id === id);
        removeStudentsWithUndo([id], target?.name || "학생");
        if (selectedId === id) setSelectedId(null);
        setSelectedIds(prev => {
            if (!prev.has(id)) return prev;
            const n = new Set(prev);
            n.delete(id);
            return n;
        });
    };

    // ===== Bulk selection =====
    const toggleSelect = (id: string) => {
        if (isDemoRoster || rosterMutationsDisabled) return;
        setSelectedIds(prev => {
            const n = new Set(prev);
            if (n.has(id)) n.delete(id); else n.add(id);
            return n;
        });
    };
    const toggleSelectAll = (visibleIds: string[]) => {
        if (isDemoRoster || rosterMutationsDisabled) return;
        setSelectedIds(prev => {
            const allSelected = visibleIds.every(id => prev.has(id));
            if (allSelected) {
                const n = new Set(prev);
                visibleIds.forEach(id => n.delete(id));
                return n;
            }
            const n = new Set(prev);
            visibleIds.forEach(id => n.add(id));
            return n;
        });
    };
    const clearSelection = () => setSelectedIds(new Set());

    const openStudentCredentialBatch = (studentIds: readonly string[]) => {
        if (rosterMutationsDisabled) {
            toast.info("읽기 전용 명단", "최신 서버 명단을 확인한 뒤 시작 코드를 발급할 수 있습니다.");
            return;
        }
        if (isDemoRoster) {
            toast.info("실제 학생에서만 코드 발급", "저장된 명단의 학생을 선택한 뒤 시작 코드를 발급할 수 있습니다.");
            return;
        }
        if (studentIds.length < 1 || studentIds.length > 100 || new Set(studentIds).size !== studentIds.length) {
            toast.error("발급 대상을 확인해주세요", "한 번에 중복 없이 1명부터 100명까지 선택할 수 있습니다.");
            return;
        }
        const selectedSet = new Set(studentIds);
        const snapshot = displayStudents
            .filter(student => selectedSet.has(student.id))
            .map(student => Object.freeze({
                studentId: student.id,
                name: student.name,
                group: student.group,
            }));
        if (snapshot.length !== studentIds.length) {
            toast.error("선택 학생이 변경됨", "명단을 새로 확인한 뒤 다시 선택해주세요.");
            return;
        }
        setCredentialBatchExpectedStudents(Object.freeze(snapshot));
    };

    const handleCredentialBatchIssued = (studentIds: readonly string[]) => {
        const nextIssuedIds = new Set(issuedStudentCredentialIdsRef.current);
        studentIds.forEach(studentId => nextIssuedIds.add(studentId));
        issuedStudentCredentialIdsRef.current = nextIssuedIds;
        setIssuedStudentCredentialIds(nextIssuedIds);
        writeIssuedStudentCredentialIds(localStorage, nextIssuedIds);
        setSelectedIds(new Set());
    };

    const handleBulkDelete = () => {
        if (isDemoRoster) {
            toast.info("데모 명단은 삭제되지 않음", "실제 학생을 추가하거나 CSV로 업로드하면 저장 가능한 명단으로 전환됩니다.");
            return;
        }
        if (selectedIds.size === 0) return;
        setConfirmAction({ kind: "bulk", count: selectedIds.size });
    };

    const deleteSelectedStudents = () => {
        const ids = [...selectedIds];
        removeStudentsWithUndo(ids, `${ids.length}명`);
        if (selectedId && selectedIds.has(selectedId)) setSelectedId(null);
        clearSelection();
    };

    // ===== CSV export =====
    const handleExportCsv = () => {
        if (isDemoRoster) {
            toast.info("데모 명단은 내보내지 않음", "실제 학생을 추가하거나 CSV로 업로드한 명단만 내보낼 수 있습니다.");
            return;
        }
        const rows = selectedIds.size > 0
            ? displayStudents.filter(s => selectedIds.has(s.id))
            : filtered;
        if (rows.length === 0) {
            toast.info("내보낼 학생 없음", "선택하거나 필터를 조정해보세요.");
            return;
        }
        const csv = serializeCsvRows([
            ["id", "name", "email", "group", "region", "avgScore", "examsTaken", "lastActive", "trend", "status"],
            ...rows.map(s => [
                s.id,
                s.name,
                s.email,
                s.group,
                rosterStudentRegionName(s, displayGroups),
                attemptAnalyticsAvailable ? s.avgScore : "",
                attemptAnalyticsAvailable ? s.examsTaken : "",
                attemptAnalyticsAvailable ? s.lastActive : "",
                attemptAnalyticsAvailable ? s.trend : "",
                attemptAnalyticsAvailable ? s.status : "",
            ]),
        ]);
        const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    };

    // ===== Bulk group move (DEV-A) =====
    const handleBulkMoveGroup = () => {
        if (isDemoRoster) {
            toast.info("데모 명단은 이동하지 않음", "실제 학생을 추가하거나 CSV로 업로드하면 반 이동을 사용할 수 있습니다.");
            return;
        }
        if (selectedIds.size === 0) return;
        setShowGroupMoveModal(true);
    };

    const handleConfirmGroupMove = (targetGroupId: string, applyRegion: boolean) => {
        const targetGroup = groups.find(group => group.id === targetGroupId);
        if (!targetGroup) return;
        const ids = selectedIds;
        const movedCount = students.filter(s => ids.has(s.id)).length;
        if (movedCount === 0) {
            setShowGroupMoveModal(false);
            return;
        }
        // Same semantics as handleEditStudent (M1): only the group/region
        // fields move, the student's id stays stable. rosterGroupMatchesStudent
        // now matches on those fields, so the old group's count drops to 0 and
        // becomes deletable, and the new group's count picks the students up —
        // no double-counting.
        //
        // T4: `applyRegion` (checkbox, default ON) controls whether the target
        // group's region overwrites each student's region. When OFF, we leave
        // the student's existing per-student region override untouched so a bulk
        // reclass doesn't silently wipe campus/branch overrides.
        const next = students.map(s => (
            ids.has(s.id)
                ? { ...s, group: targetGroup.name, ...(applyRegion ? { region: targetGroup.region } : {}) }
                : s
        ));
        persistRoster(next, recomputeGroups(next, groups), invites);
        toast.success(
            "반 이동 완료",
            `${movedCount}명을 ${groupOptionLabel(targetGroup)} 반으로 이동했습니다.${applyRegion ? "" : " 각 학생의 지역은 유지했습니다."}`,
        );
        setShowGroupMoveModal(false);
        clearSelection();
    };

    // ===== Group CRUD =====
    const handleAddStudentToGroup = (group: RosterGroup) => {
        if (isDemoRoster) {
            toast.info("데모 반에는 학생을 추가하지 않음", "실제 반을 만들면 바로 학생을 추가할 수 있습니다.");
            return;
        }
        setEditingStudent(null);
        setStudentModalDefaultGroupId(group.id);
        setShowStudentModal(true);
    };

    const handleOpenEditGroup = (group: RosterGroup) => {
        if (isDemoRoster) {
            toast.info("데모 반은 편집하지 않음", "실제 반을 만들면 이름, 지역, 색상을 수정할 수 있습니다.");
            return;
        }
        setEditingGroup(group);
        setShowGroupModal(true);
    };

    const handleSaveGroup = (data: GroupFormData): boolean => {
        if (isDemoRoster && editingGroup) {
            toast.info("데모 반은 저장하지 않음", "새 반을 만들면 실제 명단으로 전환됩니다.");
            return false;
        }

        if (editingGroup) {
            const result = editRosterGroup(students, groups, editingGroup.id, data);
            if (!result.ok) {
                const message = result.reason === "duplicate"
                    ? "같은 지역에 같은 이름의 반이 이미 있습니다."
                    : result.reason === "missing-group"
                        ? "수정할 반을 찾지 못했습니다."
                        : "반 이름을 입력해주세요.";
                toast.error("반 편집 실패", message);
                return false;
            }
            persistRoster(result.students, result.groups, invites);
            toast.success("반 정보 저장됨", `${result.group?.name || data.name} 반 정보를 업데이트했습니다.`);
            return true;
        }

        const sourceStudents = isDemoRoster ? [] : students;
        const sourceGroups = isDemoRoster ? [] : groups;
        const result = addRosterGroup(sourceStudents, sourceGroups, data);
        if (!result.ok) {
            const message = result.reason === "duplicate"
                ? "같은 지역에 같은 이름의 반이 이미 있습니다."
                : "반 이름을 입력해주세요.";
            toast.error("반 생성 실패", message);
            return false;
        }
        persistRoster(result.students, result.groups, invites);
        toast.success("반 생성됨", `${result.group?.name || data.name} 반을 추가했습니다.`);
        return true;
    };

    const handleDeleteGroup = (group: RosterGroup) => {
        if (isDemoRoster) {
            toast.info("데모 반은 삭제하지 않음", "실제 반을 만들면 학생이 없는 반을 삭제할 수 있습니다.");
            return;
        }
        setConfirmAction({ kind: "group", id: group.id, label: group.name, count: group.count });
    };

    const deleteGroup = (id: string): boolean => {
        const result = deleteRosterGroup(students, groups, id);
        if (!result.ok) {
            const message = result.reason === "not-empty"
                ? `학생 ${result.studentCount ?? 0}명이 있어 삭제할 수 없습니다. 학생을 다른 반으로 옮기거나 삭제한 뒤 다시 시도하세요.`
                : "삭제할 반을 찾지 못했습니다.";
            toast.error("반 삭제 실패", message);
            return false;
        }
        persistRoster(result.students, result.groups, invites);
        if (selectedGroupId === id) {
            setSelectedGroupId(null);
            setShowGroupProfileModal(false);
        }
        return true;
    };

    // ===== Invite actions =====
    const handleCopyInvite = async () => {
        toast.info(
            "시험별 링크를 사용해주세요",
            "시험 만들기·편집의 배포 단계에서 대상 반을 고르면 만료 가능한 안전한 링크가 발급됩니다.",
        );
    };

    const handleResendInvite = (id: string) => {
        if (isDemoRoster) {
            toast.info("데모 초대는 갱신하지 않음", "실제 초대 기록을 생성하면 카카오 발송 상태를 관리할 수 있습니다.");
            return;
        }
        const next = invites.map(inv => inv.id === id ? { ...inv, sentAt: "방금 전", status: "pending" as const } : inv);
        persistRoster(students, groups, next);
        toast.info("초대 기록 갱신됨", "카카오 발송 연동 전이라 실제 메시지는 보내지 않았습니다.");
    };

    const handleCancelInvite = (id: string) => {
        if (isDemoRoster) {
            toast.info("데모 초대는 취소하지 않음", "실제 초대를 생성하면 취소 상태를 관리할 수 있습니다.");
            return;
        }
        const target = invites.find(inv => inv.id === id);
        setConfirmAction({ kind: "invite", id, label: target?.email || "초대" });
    };

    const handleCreateInvite = (contact: string) => {
        const trimmed = contact.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
            toast.error("초대 연락처 오류", "현재는 이메일 형식 연락처만 저장합니다. 카카오 발송 채널은 연동 전입니다.");
            return false;
        }
        const emailKey = normalizeEmail(trimmed);
        if (invites.some(inv => normalizeEmail(inv.email) === emailKey && inv.status === "pending")) {
            toast.info("이미 대기 중", "동일 연락처로 대기 중인 초대 기록이 있습니다.");
            return false;
        }
        const newInvite: RosterInvite = {
            id: `i-${crypto.randomUUID()}`,
            email: trimmed,
            sentAt: "방금 전",
            status: "pending",
        };
        persistRoster(students, groups, [newInvite, ...invites]);
        toast.success("초대 기록 추가됨", `${trimmed} 연락처를 카카오 초대 대기 목록에 저장했습니다.`);
        return true;
    };

    const handleConfirmAction = () => {
        if (!confirmAction) return;
        if (confirmAction.kind === "student") {
            // No toast.success here — the undo toast (fired from
            // scheduleDeleteUndo) already communicates the delete and offers
            // "실행 취소" for a few seconds.
            deleteStudent(confirmAction.id);
        } else if (confirmAction.kind === "bulk") {
            deleteSelectedStudents();
        } else if (confirmAction.kind === "invite") {
            persistRoster(students, groups, invites.filter(inv => inv.id !== confirmAction.id));
            toast.success("초대 취소됨", `${confirmAction.label} 초대를 취소했습니다.`);
        } else if (deleteGroup(confirmAction.id)) {
            toast.success("반 삭제됨", `${confirmAction.label} 반을 삭제했습니다.`);
        }
        setConfirmAction(null);
    };

    // ===== CSV upload (T1/T5): parse → dry-run preview → confirm to commit =====
    const handleCsvFile = async (file: File) => {
        if (rosterMutationsDisabled) {
            toast.info("읽기 전용 명단", "최신 서버 명단을 확인한 뒤 CSV를 가져올 수 있습니다.");
            return;
        }
        try {
            // Read raw bytes so legacy Korean Excel exports (CP949/EUC-KR) don't become
            // mojibake — File.text() would force UTF-8.
            const text = decodeCsvBytes(await file.arrayBuffer());
            const rows = parseCsvRows(text);
            const plan = buildRosterCsvImportPlan(rows, students, groups);
            if (!plan.ok) {
                if (plan.error === "header") {
                    toast.error("헤더 형식 오류", "첫 줄은 name,email,group 이어야 합니다. region/campus/branch는 선택입니다.");
                } else {
                    toast.error("CSV 파싱 실패", "데이터가 없습니다.");
                }
                return;
            }
            // Show the dry-run preview; nothing is committed until the teacher confirms.
            setCsvPreview(plan);
        } catch {
            toast.error("CSV 파싱 실패", "파일 형식을 확인해주세요 (name,email,group,region).");
        }
    };

    const handleConfirmCsvImport = async (dispositions: Record<number, RosterCsvConflictDisposition>) => {
        if (!csvPreview) return;
        const plan = csvPreview;
        setCsvPreview(null);
        // Fold the per-row conflict choices (신규 추가/기존 덮어쓰기/건너뛰기) into the
        // planned students array before persisting.
        const resolution = applyRosterCsvConflictDispositions(plan, dispositions);
        if (!resolution.hasChanges) {
            toast.info(
                "추가된 학생 없음",
                plan.skips.length
                    ? `${plan.skips.length}개 행이 비어 있거나 형식이 맞지 않습니다.`
                    : "새로 반영할 데이터가 없습니다.",
            );
            return;
        }
        const recomputedGroups = recomputeGroups(resolution.nextStudents, plan.nextGroups);
        if (!await authorizeRosterMutation(resolution.nextStudents)) {
            setCsvPreview(plan);
            return;
        }
        persistRoster(resolution.nextStudents, recomputedGroups, invites);
        const addedTotal = plan.adds.length + resolution.addedCount;
        const updatedTotal = plan.updates.filter(update => update.changes.length > 0).length + resolution.overwrittenCount;
        toast.success(
            "CSV 가져오기 완료",
            `${addedTotal}명 추가 · ${updatedTotal}명 업데이트 · ${plan.createdGroups.length}개 반 생성`
            + `${plan.skips.length ? ` · ${plan.skips.length}행 제외` : ""}`
            + `${resolution.overwrittenCount ? ` · ${resolution.overwrittenCount}건 id 충돌 덮어쓰기` : ""}`
            + `${resolution.skippedCount ? ` · ${resolution.skippedCount}건 id 충돌 건너뜀` : ""}`
            + `${resolution.addedCount ? ` · ${resolution.addedCount}건 id 충돌 새 학생 추가` : ""}`,
        );
    };

    const handleCanonicalRosterRetry = () => {
        setRosterLoadState({ state: "loading" });
        setRosterRetryGeneration(generation => generation + 1);
    };

    if (rosterLoadState.state === "loading" || rosterLoadState.state === "error_without_cache") {
        const unavailable = rosterLoadState.state === "error_without_cache";
        return (
            <div className="layout-main">
                <TeacherHeader badge="USERS" badgeColor="#22c55e" />
                <main id="main-content" tabIndex={-1} className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                    <div style={{ margin: '3rem 0 2rem' }}>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem' }}>사용자 관리</h1>
                        <p className="text-muted">학생, 반, 초대를 한 곳에서 관리하세요.</p>
                    </div>
                    <section
                        {...(unavailable ? { "data-testid": "canonical-error-no-cache" } : { "data-testid": "canonical-roster-loading" })}
                        role={unavailable ? "alert" : "status"}
                        className="bento-card"
                        style={{ minHeight: 280, display: 'grid', placeItems: 'center', padding: '2rem', textAlign: 'center' }}
                    >
                        <div>
                            <AlertTriangle size={28} color={unavailable ? "var(--warning)" : "var(--primary)"} style={{ margin: '0 auto 0.75rem' }} />
                            <h2 style={{ fontSize: '1.2rem', fontWeight: 850 }}>
                                {unavailable ? "서버 명단을 불러오지 못했습니다" : "명단을 불러오는 중입니다"}
                            </h2>
                            <p className="text-muted" style={{ margin: '0.5rem 0 1rem' }}>
                                {unavailable ? "검증된 저장 명단이 없어 빈 명단이나 추가 화면으로 표시하지 않습니다." : "학생과 반의 최신 상태를 확인하고 있습니다."}
                            </p>
                            {unavailable && (
                                <button data-testid="canonical-roster-retry" type="button" className="btn btn-primary" onClick={handleCanonicalRosterRetry}>다시 시도</button>
                            )}
                        </div>
                    </section>
                </main>
            </div>
        );
    }

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-accent" />
            <TeacherHeader badge="USERS" badgeColor="#22c55e" />

            <main id="main-content" tabIndex={-1} className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div className="teacher-users-page-heading mobile-section-stack" style={{ margin: '3rem 0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '2rem', flexWrap: 'wrap' }}>
                    <div>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>
                            사용자 관리
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.05rem' }}>
                            학생, 반, 초대를 한 곳에서 관리하세요.
                        </p>
                    </div>
                    <input
                        ref={fileInputRef}
                        type="file"
                        accept=".csv"
                        disabled={rosterMutationsDisabled}
                        style={{ display: 'none' }}
                        onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) handleCsvFile(f);
                            if (fileInputRef.current) fileInputRef.current.value = "";
                        }}
                    />
                    {!rosterMutationsDisabled && (tab !== "students" || showStudentListControls) && <div className="teacher-users-desktop-actions" style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <button
                            onClick={() => fileInputRef.current?.click()}
                            style={{
                                padding: '0.75rem 1.25rem', background: 'var(--surface)', border: '1px solid var(--border)',
                                borderRadius: 'var(--radius-full)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.5rem',
                                transition: 'var(--transition-base)', color: 'var(--foreground)'
                            }} className="card-hover">
                            <Upload size={16} /> CSV 업로드
                        </button>
                        {tab === "groups" ? (
                            <button
                                onClick={() => { setEditingGroup(null); setShowGroupModal(true); }}
                                style={{
                                    padding: '0.75rem 1.5rem', background: 'var(--primary)',
                                    color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 700,
                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                    boxShadow: '0 4px 12px rgba(79,70,229,0.28)'
                                }}>
                                <FolderPlus size={16} /> 새 반 만들기
                            </button>
                        ) : (
                            <button
                                onClick={() => { setEditingStudent(null); setStudentModalDefaultGroupId(undefined); setShowStudentModal(true); }}
                                style={{
                                    padding: '0.75rem 1.5rem', background: 'linear-gradient(135deg, #22c55e, #10b981)',
                                    color: 'white', borderRadius: 'var(--radius-full)', fontWeight: 600,
                                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                                    boxShadow: '0 4px 12px rgba(34,197,94,0.3)'
                                }}>
                                <UserPlus size={16} /> 학생 추가
                            </button>
                        )}
                    </div>}
                </div>

                {rosterLoadState.state === "degraded_with_cache" && (
                    <section
                        data-testid="canonical-degraded-cache"
                        role="status"
                        style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', padding: '1rem 1.1rem', marginBottom: '1.5rem', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 'var(--radius-lg)', background: 'rgba(245,158,11,0.08)', flexWrap: 'wrap' }}
                    >
                        <div>
                            <strong>저장된 데이터를 읽기 전용으로 표시 중</strong>
                            <p className="text-muted" style={{ marginTop: '0.25rem' }}>
                                마지막 저장 {new Date(rosterLoadState.staleAt).toLocaleString('ko-KR')} · 서버 명단을 다시 확인해주세요.
                            </p>
                        </div>
                        <button type="button" className="btn btn-secondary" onClick={handleCanonicalRosterRetry}>다시 시도</button>
                    </section>
                )}

                {isDemoRoster && (
                    <div
                        role="status"
                        aria-label="데모 명단 안내"
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.85rem',
                            padding: '1rem 1.1rem',
                            marginBottom: '1.5rem',
                            borderRadius: 'var(--radius-lg)',
                            border: '1px solid rgba(245,158,11,0.28)',
                            background: 'rgba(245,158,11,0.09)',
                            color: 'var(--foreground)',
                        }}
                    >
                        <AlertTriangle size={19} color="var(--warning)" style={{ flexShrink: 0, marginTop: 2 }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--warning)', marginBottom: '0.2rem' }}>
                                데모 명단 모드
                            </div>
                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                                저장된 학생/반/초대 데이터가 없어 예시 명단을 표시 중입니다. 이 예시 명단은 저장하지 않으며, 학생 추가·반 생성·CSV 업로드를 시작하면 실제 명단으로 전환됩니다.
                            </p>
                        </div>
                    </div>
                )}

                {!isDemoRoster && attemptAnalyticsStatus === "unavailable" && (
                    <div
                        role="alert"
                        aria-label="응시 분석 데이터 미표시"
                        style={{
                            display: 'flex',
                            alignItems: 'flex-start',
                            gap: '0.85rem',
                            padding: '1rem 1.1rem',
                            marginBottom: '1.5rem',
                            borderRadius: 'var(--radius-lg)',
                            border: '1px solid rgba(245,158,11,0.28)',
                            background: 'rgba(245,158,11,0.09)',
                        }}
                    >
                        <AlertTriangle size={19} color="var(--warning)" style={{ flexShrink: 0, marginTop: 2 }} />
                        <div>
                            <div style={{ fontSize: '0.9rem', fontWeight: 900, color: 'var(--warning)', marginBottom: '0.2rem' }}>
                                응시 분석 데이터 미표시
                            </div>
                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55 }}>
                                서버 응시 기록을 완전하게 확인할 수 없어 평균 점수·응시 수·최근 활동·지역 및 학생 리포트를 숨겼습니다.
                            </p>
                        </div>
                    </div>
                )}

                {(tab !== "students" || showStudentListControls) && (
                    <>
                        <section className="teacher-users-mobile-summary" aria-label="명단 핵심 지표">
                            <div><span>전체 학생</span><strong>{displayStudents.length}명</strong></div>
                            <div><span>활동 중</span><strong>{attemptAnalyticsAvailable ? `${displayStudents.filter(student => student.status === "active").length}명` : "—"}</strong></div>
                            <div><span>반</span><strong>{displayGroups.length}개</strong></div>
                        </section>

                        {!rosterMutationsDisabled && <div className="teacher-users-mobile-page-actions mobile-action-row" role="group" aria-label="명단 작업">
                            {tab === "groups" ? (
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => { setEditingGroup(null); setShowGroupModal(true); }}
                                >
                                    <FolderPlus size={16} /> 새 반 만들기
                                </button>
                            ) : (
                                <button
                                    type="button"
                                    className="btn btn-primary"
                                    onClick={() => { setEditingStudent(null); setStudentModalDefaultGroupId(undefined); setShowStudentModal(true); }}
                                >
                                    <UserPlus size={16} /> 학생 추가
                                </button>
                            )}
                            <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => fileInputRef.current?.click()}
                            >
                                <Upload size={16} /> CSV 업로드
                            </button>
                        </div>}

                        {attemptAnalyticsAvailable && <details className="teacher-users-analysis">
                            <summary>
                                <span>명단 분석</span>
                                <small>학생 {displayStudents.length}명 · 반 {displayGroups.length}개 · 지역 {regionalScopes.length}곳</small>
                            </summary>
                            <div className="teacher-users-analysis-content">
                                <div className="bento-grid" style={{ marginBottom: '1.25rem' }}>
                                    <KPI label="전체 학생" value={displayStudents.length} color="#4f46e5" icon={<Users size={22} />} />
                                    <KPI label="활동 중" value={displayStudents.filter(s => s.status === "active").length} color="#10b981" icon={<CheckCircle2 size={22} />} />
                                    <KPI label="반 개수" value={displayGroups.length} color="#8b5cf6" icon={<FolderPlus size={22} />} />
                                    <KPI label="지역 수" value={regionalScopes.length} color="#0ea5e9" icon={<MapPin size={22} />} />
                                    <KPI label="미수락 초대" value={rosterInvites.filter(i => i.status === "pending").length} color="#f59e0b" icon={<Clock size={22} />} />
                                </div>

                                {regionalScopes.length > 0 && (
                                    <div className="bento-card" style={{ padding: '1.25rem 1.35rem', marginBottom: '1.25rem' }}>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem', alignItems: 'flex-start', marginBottom: '1rem', flexWrap: 'wrap' }}>
                                            <div>
                                                <h2 style={{ fontSize: '1.05rem', fontWeight: 850, marginBottom: '0.25rem' }}>지역별 현황</h2>
                                                <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.5 }}>
                                                    {activeRegionName} · 학생 {activeRegionKey === ALL_REGION_KEY ? displayStudents.length : filtered.length}명
                                                </p>
                                            </div>
                                            <select
                                                aria-label="지역 필터"
                                                value={activeRegionKey}
                                                onChange={event => setSelectedRegionKey(event.target.value)}
                                                style={{
                                                    minWidth: 150,
                                                    padding: '0.55rem 0.75rem',
                                                    background: 'var(--background)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: 'var(--radius-md)',
                                                    color: 'var(--foreground)',
                                                    fontSize: '0.85rem',
                                                    fontWeight: 700,
                                                }}
                                            >
                                                <option value={ALL_REGION_KEY}>전체 지역</option>
                                                {regionalScopes.map(scope => (
                                                    <option key={scope.regionKey} value={scope.regionKey}>{regionLabel(scope)}</option>
                                                ))}
                                            </select>
                                        </div>

                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem' }}>
                                            {regionalScopes.map(scope => {
                                                const selectedRegion = activeRegionKey === scope.regionKey;
                                                return (
                                                    <button
                                                        key={scope.regionKey}
                                                        type="button"
                                                        onClick={() => setSelectedRegionKey(selectedRegion ? ALL_REGION_KEY : scope.regionKey)}
                                                        style={{
                                                            padding: '0.85rem 0.9rem',
                                                            borderRadius: 'var(--radius-md)',
                                                            border: selectedRegion ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                            background: selectedRegion ? 'rgba(99,102,241,0.08)' : 'var(--background)',
                                                            textAlign: 'left',
                                                            color: 'var(--foreground)',
                                                        }}
                                                    >
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.55rem' }}>
                                                            <MapPin size={14} color={selectedRegion ? 'var(--primary)' : 'var(--muted)'} />
                                                            <span style={{ fontSize: '0.86rem', fontWeight: 850 }}>{regionLabel(scope)}</span>
                                                        </div>
                                                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.35rem' }}>
                                                            <MiniRegionMetric label="학생" value={`${scope.studentCount}명`} />
                                                            <MiniRegionMetric label="반" value={`${scope.groupCount}개`} />
                                                            <RegionalAverageMetric averageScore={scope.averageScore} />
                                                        </div>
                                                        <div style={{ marginTop: '0.55rem', fontSize: '0.72rem', color: 'var(--muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                            원시험 {scope.attemptCount}건 · 재시험 {scope.retakeAttemptCount}건 · 시험 {scope.examCount}개
                                                        </div>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </details>}
                    </>
                )}

                {/* Sub-tabs */}
                <div className="teacher-users-tabs" role="group" aria-label="명단 보기" style={{
                    display: 'flex', gap: '0.5rem', marginBottom: '1.5rem',
                    background: 'var(--surface)', padding: '0.5rem', borderRadius: 'var(--radius-lg)',
                    border: '1px solid var(--border)', width: 'fit-content',
                    boxShadow: '0 4px 6px rgba(0,0,0,0.02)'
                }}>
                    {([
                        { key: "students", label: `학생 (${displayStudents.length})` },
                        { key: "groups", label: `반 · 그룹 (${displayGroups.length})` },
                        { key: "invites", label: `초대 (${rosterInvites.length})` },
                    ] as const).map(t => (
                        <button
                            key={t.key}
                            type="button"
                            aria-pressed={tab === t.key}
                            className={tab === t.key ? "is-active" : undefined}
                            onClick={() => setTab(t.key)}
                            style={{
                                padding: '0.65rem 1.4rem', borderRadius: 'var(--radius-md)',
                                background: tab === t.key ? 'var(--primary)' : 'transparent',
                                color: tab === t.key ? 'white' : 'var(--muted)',
                                fontWeight: tab === t.key ? 700 : 500, fontSize: '0.9rem',
                                whiteSpace: 'nowrap', transition: 'var(--transition-base)'
                            }}>
                            {t.label}
                        </button>
                    ))}
                </div>

                {tab === "students" && (
                    <div
                        className={selectedId ? "teacher-users-students-grid has-detail" : "teacher-users-students-grid"}
                        style={{ display: 'grid', gridTemplateColumns: selectedId ? 'minmax(0, 1fr) minmax(320px, 380px)' : 'minmax(0, 1fr)', gap: '1.25rem' }}
                    >
                        <div className="bento-card teacher-users-list-card" style={{ padding: '1.5rem' }}>
                            {showStudentListControls && <>
                            {/* Search */}
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem', padding: '0.75rem 1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)', flexWrap: 'wrap' }}>
                                <Search size={16} color="var(--muted)" />
                                <input
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder="이름, 이메일, 반, 지역 검색"
                                    style={{ flex: '1 1 220px', background: 'transparent', border: 'none', outline: 'none', color: 'var(--foreground)', fontSize: '0.95rem' }}
                                />
                                <select
                                    aria-label="학생 지역 필터"
                                    value={activeRegionKey}
                                    onChange={e => setSelectedRegionKey(e.target.value)}
                                    style={{
                                        padding: '0.35rem 0.55rem',
                                        background: 'var(--surface)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 'var(--radius-sm)',
                                        color: 'var(--foreground)',
                                        fontSize: '0.8rem',
                                        fontWeight: 700,
                                    }}
                                >
                                    <option value={ALL_REGION_KEY}>전체 지역</option>
                                    {regionalScopes.map(scope => (
                                        <option key={scope.regionKey} value={scope.regionKey}>{regionLabel(scope)}</option>
                                    ))}
                                </select>
                                <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>{filtered.length}명</span>
                            </div>

                            {/* Selection banner */}
                            {selectedIds.size > 0 ? (
                                <div style={{
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem',
                                    padding: '0.7rem 1rem', background: 'rgba(99,102,241,0.08)', borderRadius: 'var(--radius-md)',
                                    border: '1px solid rgba(99,102,241,0.25)'
                                }}>
                                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--primary)' }}>
                                        <strong>{selectedIds.size}명</strong> 선택됨
                                        <span style={{ fontWeight: 500, color: 'var(--muted)' }}> · 모든 페이지 포함 (필터 전체 {filtered.length}명 중)</span>
                                    </span>
                                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                                        <button onClick={() => openStudentCredentialBatch([...selectedIds])} style={{
                                            padding: '0.4rem 0.85rem', background: 'var(--primary)', color: 'white',
                                            border: '1px solid var(--primary)', borderRadius: 'var(--radius-md)',
                                            fontSize: '0.8rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.35rem'
                                        }}>
                                            <KeyRound size={13} /> 선택 학생 코드 발급
                                        </button>
                                        {filtered.length > 0 && !filtered.every(s => selectedIds.has(s.id)) && (
                                            <button onClick={() => setSelectedIds(new Set(filtered.map(s => s.id)))} style={{
                                                padding: '0.4rem 0.85rem', background: 'var(--surface)', color: 'var(--primary)',
                                                border: '1px solid rgba(99,102,241,0.35)', borderRadius: 'var(--radius-md)',
                                                fontSize: '0.8rem', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '0.35rem'
                                            }}>
                                                <CheckCircle2 size={13} /> 필터 전체 {filtered.length}명 선택
                                            </button>
                                        )}
                                        <button onClick={handleExportCsv} style={{
                                            padding: '0.4rem 0.85rem', background: 'var(--surface)', color: 'var(--foreground)',
                                            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                                            fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem'
                                        }}>
                                            <Download size={13} /> CSV 내보내기
                                        </button>
                                        <button onClick={handleBulkMoveGroup} disabled={groups.length === 0} style={{
                                            padding: '0.4rem 0.85rem', background: 'var(--surface)', color: 'var(--foreground)',
                                            border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                                            fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem',
                                            opacity: groups.length === 0 ? 0.5 : 1, cursor: groups.length === 0 ? 'not-allowed' : 'pointer',
                                        }}>
                                            <FolderPlus size={13} /> 그룹 이동
                                        </button>
                                        <button onClick={handleBulkDelete} style={{
                                            padding: '0.4rem 0.85rem', background: 'rgba(239,68,68,0.1)', color: '#ef4444',
                                            border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-md)',
                                            fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem'
                                        }}>
                                            <Trash2 size={13} /> 삭제
                                        </button>
                                        <button onClick={clearSelection} style={{
                                            padding: '0.4rem 0.85rem', background: 'transparent', color: 'var(--muted)',
                                            borderRadius: 'var(--radius-md)', fontSize: '0.8rem', fontWeight: 500
                                        }}>취소</button>
                                    </div>
                                </div>
                            ) : (
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '1rem' }}>
                                    <button onClick={handleExportCsv} style={{
                                        padding: '0.45rem 0.9rem', background: 'var(--surface)', color: 'var(--muted)',
                                        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                                        fontSize: '0.8rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.35rem'
                                    }}>
                                        <Download size={13} /> 전체 CSV 내보내기
                                    </button>
                                </div>
                            )}

                            <div className="teacher-users-table-scroll scroll-custom">
                                <table className="teacher-users-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                                    <thead>
                                        <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                            <th style={{ padding: '0.85rem 0.5rem', width: 32 }}>
                                                <input
                                                    type="checkbox"
                                                    aria-label={`필터된 전체 ${filtered.length}명 선택`}
                                                    title={`필터된 전체 ${filtered.length}명 선택 (모든 페이지 포함)`}
                                                    checked={filtered.length > 0 && filtered.every(s => selectedIds.has(s.id))}
                                                    ref={el => { if (el) el.indeterminate = filtered.some(s => selectedIds.has(s.id)) && !filtered.every(s => selectedIds.has(s.id)); }}
                                                    onChange={() => toggleSelectAll(filtered.map(s => s.id))}
                                                    onClick={e => e.stopPropagation()}
                                                    disabled={isDemoRoster || rosterMutationsDisabled}
                                                    style={{ cursor: isDemoRoster || rosterMutationsDisabled ? 'not-allowed' : 'pointer', accentColor: 'var(--primary)' }}
                                                />
                                            </th>
                                            <th style={{ padding: '0.85rem 0.5rem' }} aria-sort={sortAriaValue(sortState, "name")}>
                                                <SortableHeaderButton label="학생" sortKey="name" sortState={sortState} onSort={toggleSort} />
                                            </th>
                                            <th style={{ padding: '0.85rem 0.5rem' }}>반</th>
                                            <th style={{ padding: '0.85rem 0.5rem' }}>지역</th>
                                            <th style={{ padding: '0.85rem 0.5rem' }} aria-sort={sortAriaValue(sortState, "avgScore")}>
                                                <SortableHeaderButton label="평균 점수" sortKey="avgScore" sortState={sortState} onSort={toggleSort} />
                                            </th>
                                            <th style={{ padding: '0.85rem 0.5rem' }} aria-sort={sortAriaValue(sortState, "examsTaken")}>
                                                <SortableHeaderButton label="응시 수" sortKey="examsTaken" sortState={sortState} onSort={toggleSort} />
                                            </th>
                                            <th style={{ padding: '0.85rem 0.5rem' }} aria-sort={sortAriaValue(sortState, "lastActive")}>
                                                <SortableHeaderButton label="최근 활동" sortKey="lastActive" sortState={sortState} onSort={toggleSort} />
                                            </th>
                                            <th style={{ padding: '0.85rem 0.5rem', width: 40 }}></th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {pagedStudents.map(s => (
                                            <tr key={s.id}
                                                onClick={() => setSelectedId(s.id)}
                                                style={{ borderBottom: '1px solid var(--border)', cursor: 'pointer', transition: 'background 0.2s', background: selectedIds.has(s.id) ? 'rgba(99,102,241,0.06)' : selectedId === s.id ? 'rgba(99,102,241,0.05)' : 'transparent' }}
                                                onMouseEnter={e => e.currentTarget.style.background = 'rgba(99,102,241,0.04)'}
                                                onMouseLeave={e => e.currentTarget.style.background = selectedIds.has(s.id) ? 'rgba(99,102,241,0.06)' : selectedId === s.id ? 'rgba(99,102,241,0.05)' : 'transparent'}
                                            >
                                                <td style={{ padding: '0.85rem 0.5rem' }} onClick={(e) => e.stopPropagation()}>
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`${s.name} 선택`}
                                                        checked={selectedIds.has(s.id)}
                                                        onChange={() => toggleSelect(s.id)}
                                                        disabled={isDemoRoster || rosterMutationsDisabled}
                                                        style={{ cursor: isDemoRoster || rosterMutationsDisabled ? 'not-allowed' : 'pointer', accentColor: 'var(--primary)' }}
                                                    />
                                                </td>
                                                <td style={{ padding: '0.85rem 0.5rem' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                                                        <div style={{ width: 34, height: 34, borderRadius: '50%', background: s.avatar, color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.8rem', fontWeight: 700, flexShrink: 0 }}>{s.name.slice(1, 2)}</div>
                                                        <div>
                                                            <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>{s.name}</div>
                                                            <div style={{ fontSize: '0.75rem', color: 'var(--muted)' }}>{s.email}</div>
                                                        </div>
                                                    </div>
                                                </td>
                                                <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{s.group}</td>
                                                <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{rosterStudentRegionName(s, displayGroups)}</td>
                                                <td style={{ padding: '0.85rem 0.5rem' }}>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                                                        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: attemptAnalyticsAvailable ? (s.avgScore >= 80 ? 'var(--success)' : s.avgScore >= 65 ? 'var(--warning)' : 'var(--error)') : 'var(--muted)' }}>
                                                            {attemptAnalyticsAvailable ? `${s.avgScore}` : "—"}
                                                        </span>
                                                        {attemptAnalyticsAvailable && s.trend === "up" && <TrendingUp size={14} color="var(--success)" />}
                                                        {attemptAnalyticsAvailable && s.trend === "down" && <TrendingDown size={14} color="var(--error)" />}
                                                    </div>
                                                </td>
                                                <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>
                                                    {attemptAnalyticsAvailable ? `${s.examsTaken}회` : "—"}
                                                </td>
                                                <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                                        {attemptAnalyticsAvailable && <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.status === "active" ? 'var(--success)' : 'var(--muted)' }} />}
                                                        {attemptAnalyticsAvailable ? s.lastActive : "—"}
                                                    </span>
                                                </td>
                                                <td
                                                    data-teacher-user-popover-root
                                                    style={{ padding: '0.85rem 0.5rem', textAlign: 'right', position: 'relative' }}
                                                >
                                                    {!isDemoRoster && !rosterMutationsDisabled && (
                                                        <button
                                                            aria-label={`${s.name} 작업 메뉴 열기`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
                                                                if (popoverId !== s.id) popoverTriggerRef.current = e.currentTarget;
                                                                setPopoverId(popoverId === s.id ? null : s.id);
                                                            }}
                                                            style={{ background: 'transparent', padding: 4, borderRadius: 6 }}
                                                        >
                                                            <MoreVertical size={16} color="var(--muted)" />
                                                        </button>
                                                    )}
                                                    {popoverId === s.id && (
                                                        <div
                                                            onClick={(e) => e.stopPropagation()}
                                                            style={{
                                                                position: 'absolute', right: 8, top: '100%', zIndex: 200,
                                                                background: 'var(--surface)', border: '1px solid var(--border)',
                                                                borderRadius: 'var(--radius-md)', boxShadow: '0 8px 24px rgba(0,0,0,0.08)',
                                                                minWidth: 120, overflow: 'hidden', textAlign: 'left'
                                                            }}
                                                        >
                                                            <button
                                                                onClick={() => {
                                                                    setEditingStudent(s);
                                                                    setShowStudentModal(true);
                                                                    setPopoverId(null);
                                                                }}
                                                                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.6rem 0.9rem', fontSize: '0.85rem', color: 'var(--foreground)', background: 'transparent' }}
                                                            >
                                                                편집
                                                            </button>
                                                            <button
                                                                onClick={() => handleDeleteStudent(s.id)}
                                                                style={{ display: 'block', width: '100%', textAlign: 'left', padding: '0.6rem 0.9rem', fontSize: '0.85rem', color: 'var(--error)', background: 'transparent', borderTop: '1px solid var(--border)' }}
                                                            >
                                                                삭제
                                                            </button>
                                                        </div>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>

                            <div className="teacher-users-mobile-list" aria-label="학생 명단">
                                {pagedStudents.map(s => {
                                    const regionName = rosterStudentRegionName(s, displayGroups);
                                    const scoreTone = attemptAnalyticsAvailable
                                        ? s.avgScore >= 80 ? 'var(--success)' : s.avgScore >= 65 ? 'var(--warning)' : 'var(--error)'
                                        : 'var(--muted)';
                                    return (
                                        <article
                                            key={s.id}
                                            data-testid="teacher-users-mobile-card"
                                            className={`teacher-users-mobile-card${selectedId === s.id ? " is-selected" : ""}`}
                                            aria-labelledby={`teacher-mobile-student-${s.id}`}
                                        >
                                            <div className="teacher-users-mobile-card-head">
                                                <div className="teacher-users-mobile-avatar" style={{ background: s.avatar }} aria-hidden="true">
                                                    {s.name.slice(1, 2)}
                                                </div>
                                                <div className="teacher-users-mobile-identity">
                                                    <h3 id={`teacher-mobile-student-${s.id}`}>{s.name}</h3>
                                                    <p>{s.email}</p>
                                                </div>
                                                <label className="teacher-users-mobile-select">
                                                    <span className="sr-only">{s.name} 선택</span>
                                                    <input
                                                        type="checkbox"
                                                        aria-label={`${s.name} 선택`}
                                                        checked={selectedIds.has(s.id)}
                                                        onChange={() => toggleSelect(s.id)}
                                                        disabled={isDemoRoster || rosterMutationsDisabled}
                                                    />
                                                </label>
                                            </div>

                                            <div className="teacher-users-mobile-scope" aria-label={`${s.name} 소속`}>
                                                <span>{s.group}</span>
                                                <span>{regionName}</span>
                                            </div>

                                            <div className="teacher-users-mobile-metrics">
                                                <div aria-label={attemptAnalyticsAvailable ? `평균 ${s.avgScore}점` : "평균 확인 불가"}>
                                                    <span>평균</span>
                                                    <strong style={{ color: scoreTone }}>
                                                        {attemptAnalyticsAvailable ? `${s.avgScore}점` : "—"}
                                                        {attemptAnalyticsAvailable && s.trend === "up" && <TrendingUp size={13} aria-label="상승" />}
                                                        {attemptAnalyticsAvailable && s.trend === "down" && <TrendingDown size={13} aria-label="하락" />}
                                                    </strong>
                                                </div>
                                                <div aria-label={attemptAnalyticsAvailable ? `응시 ${s.examsTaken}회` : "응시 수 확인 불가"}>
                                                    <span>응시</span>
                                                    <strong>{attemptAnalyticsAvailable ? `${s.examsTaken}회` : "—"}</strong>
                                                </div>
                                                <div aria-label={attemptAnalyticsAvailable ? `최근 활동 ${s.lastActive}` : "최근 활동 확인 불가"}>
                                                    <span>최근 활동</span>
                                                    <strong>
                                                        {attemptAnalyticsAvailable && <i className={s.status === "active" ? "is-active" : undefined} aria-hidden="true" />}
                                                        {attemptAnalyticsAvailable ? s.lastActive : "—"}
                                                    </strong>
                                                </div>
                                            </div>

                                            <div className="teacher-users-mobile-actions">
                                                <button
                                                    type="button"
                                                    className="btn btn-secondary"
                                                    aria-label={`${s.name} 상세 보기`}
                                                    onClick={() => setSelectedId(s.id)}
                                                >
                                                    상세 보기
                                                </button>
                                                {!isDemoRoster && (
                                                    <div data-teacher-user-popover-root className="teacher-users-mobile-menu-root">
                                                        <button
                                                            type="button"
                                                            className="teacher-users-mobile-menu-trigger"
                                                            aria-label={`${s.name} 작업 메뉴 열기`}
                                                            aria-expanded={popoverId === s.id}
                                                            onClick={(event) => {
                                                                if (popoverId !== s.id) popoverTriggerRef.current = event.currentTarget;
                                                                setPopoverId(popoverId === s.id ? null : s.id);
                                                            }}
                                                        >
                                                            <MoreVertical size={18} />
                                                        </button>
                                                        {popoverId === s.id && (
                                                            <div className="teacher-users-mobile-menu" role="menu" aria-label={`${s.name} 작업`}>
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    onClick={() => {
                                                                        setEditingStudent(s);
                                                                        setShowStudentModal(true);
                                                                        setPopoverId(null);
                                                                    }}
                                                                >
                                                                    편집
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    role="menuitem"
                                                                    className="is-danger"
                                                                    onClick={() => handleDeleteStudent(s.id)}
                                                                >
                                                                    삭제
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                )}
                                            </div>
                                        </article>
                                    );
                                })}
                            </div>

                            {/* T2: pager — range readout, page-size selector, prev/next */}
                            {totalRows > 0 && (
                                <div style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    gap: '0.75rem', flexWrap: 'wrap', marginTop: '1rem',
                                    paddingTop: '1rem', borderTop: '1px solid var(--border)',
                                }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                                        <span style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                                            {pageStart + 1}–{pageEnd} / 전체 {totalRows}명
                                        </span>
                                        <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
                                            페이지당
                                            <select
                                                aria-label="페이지당 표시 수"
                                                value={pageSize === "all" ? "all" : String(pageSize)}
                                                onChange={e => setPageSize(e.target.value === "all" ? "all" : Number(e.target.value))}
                                                style={{
                                                    padding: '0.35rem 0.55rem', background: 'var(--surface)',
                                                    border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)',
                                                    color: 'var(--foreground)', fontSize: '0.8rem', fontWeight: 700,
                                                }}
                                            >
                                                <option value="50">50</option>
                                                <option value="100">100</option>
                                                <option value="all">전체</option>
                                            </select>
                                        </label>
                                    </div>
                                    {pageSize !== "all" && pageCount > 1 && (
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                            <button
                                                type="button"
                                                aria-label="이전 페이지"
                                                onClick={() => setPage(p => Math.max(1, p - 1))}
                                                disabled={clampedPage <= 1}
                                                style={{
                                                    minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                                                    color: 'var(--foreground)', fontSize: '0.85rem', fontWeight: 700,
                                                    opacity: clampedPage <= 1 ? 0.45 : 1, cursor: clampedPage <= 1 ? 'not-allowed' : 'pointer',
                                                }}
                                            >
                                                이전
                                            </button>
                                            <span style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 68, textAlign: 'center' }}>
                                                {clampedPage} / {pageCount}
                                            </span>
                                            <button
                                                type="button"
                                                aria-label="다음 페이지"
                                                onClick={() => setPage(p => Math.min(pageCount, p + 1))}
                                                disabled={clampedPage >= pageCount}
                                                style={{
                                                    minWidth: 44, minHeight: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                                    background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                                                    color: 'var(--foreground)', fontSize: '0.85rem', fontWeight: 700,
                                                    opacity: clampedPage >= pageCount ? 0.45 : 1, cursor: clampedPage >= pageCount ? 'not-allowed' : 'pointer',
                                                }}
                                            >
                                                다음
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )}
                            </>}
                            {hydrated && !showStudentListControls && (
                                <div style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                                    <div style={{
                                        width: 64, height: 64, borderRadius: '50%',
                                        background: 'rgba(99,102,241,0.08)',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        color: 'var(--primary)', marginBottom: '1rem'
                                    }}>
                                        <Users size={28} />
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.35rem' }}>아직 등록된 학생이 없습니다</div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.25rem' }}>
                                        {rosterMutationsDisabled ? "저장된 명단을 읽기 전용으로 확인 중입니다. 최신 서버 명단을 다시 불러오세요." : "학생을 추가하거나 CSV로 업로드해서 시작하세요."}
                                    </div>
                                    {!rosterMutationsDisabled && <div style={{ display: 'inline-flex', gap: '0.5rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                                        <button
                                            onClick={() => { setEditingStudent(null); setShowStudentModal(true); }}
                                            style={{
                                                minHeight: 44, padding: '0.55rem 1.1rem', background: 'linear-gradient(135deg, #22c55e, #10b981)',
                                                color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem',
                                                display: 'flex', alignItems: 'center', gap: '0.4rem'
                                            }}>
                                            <UserPlus size={14} /> 첫 학생 추가
                                        </button>
                                        <button
                                            onClick={() => fileInputRef.current?.click()}
                                            style={{
                                                minHeight: 44, padding: '0.55rem 1.1rem', background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem',
                                                display: 'flex', alignItems: 'center', gap: '0.4rem'
                                            }}>
                                            <Upload size={14} /> CSV 업로드
                                        </button>
                                    </div>}
                                </div>
                            )}
                            {hydrated && showStudentListControls && filtered.length === 0 && (
                                <div style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                                    <div style={{
                                        width: 64, height: 64, borderRadius: '50%',
                                        background: 'rgba(99,102,241,0.08)',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        color: 'var(--primary)', marginBottom: '1rem'
                                    }}>
                                        <Search size={28} />
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.35rem' }}>검색 결과가 없습니다</div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>다른 키워드나 지역으로 검색해보세요.</div>
                                </div>
                            )}
                        </div>

                        {selected && (
                            <div className="bento-card teacher-users-detail-card" style={{ padding: '1.5rem', position: 'sticky', top: '5.5rem', alignSelf: 'flex-start', animation: 'fadeIn 0.3s both' }}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.25rem' }}>
                                    <h3 style={{ fontSize: '1rem', fontWeight: 700 }}>학생 상세</h3>
                                    <button type="button" aria-label="학생 상세 닫기" onClick={() => setSelectedId(null)} style={{ color: 'var(--muted)' }}>
                                        <X size={18} />
                                    </button>
                                </div>
                                <div style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
                                    <div style={{
                                        width: 72, height: 72, borderRadius: '50%', background: selected.avatar,
                                        color: 'white', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.75rem'
                                    }}>{selected.name.slice(1, 2)}</div>
                                    <div style={{ fontSize: '1.1rem', fontWeight: 700 }}>{selected.name}</div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{selected.email}</div>
                                    <button
                                        type="button"
                                        onClick={handleCopyStudentId}
                                        title="학생번호 복사"
                                        style={{
                                            marginTop: '0.45rem',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            gap: '0.3rem',
                                            maxWidth: '100%',
                                            padding: '0.28rem 0.55rem',
                                            borderRadius: 'var(--radius-full)',
                                            background: 'var(--background)',
                                            border: '1px solid var(--border)',
                                            color: 'var(--muted)',
                                            fontSize: '0.72rem',
                                            fontWeight: 800,
                                        }}
                                    >
                                        <Copy size={12} />
                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                            학생번호 {selected.id}
                                        </span>
                                    </button>
                                    <div style={{ marginTop: '0.6rem', display: 'inline-flex', gap: '0.4rem', flexWrap: 'wrap', justifyContent: 'center' }}>
                                        <span className="badge badge-primary">{selected.group}</span>
                                        <span className="badge badge-secondary">{rosterStudentRegionName(selected, displayGroups)}</span>
                                    </div>
                                </div>
                                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '0.6rem', marginBottom: '1.25rem' }}>
                                    <MiniStat label="원시험 평균" value={attemptAnalyticsAvailable ? `${selected.avgScore}점` : "—"} color="#4f46e5" />
                                    <MiniStat label="원시험" value={attemptAnalyticsAvailable ? `${selected.examsTaken}회` : "—"} color="#10b981" />
                                    <MiniStat label="재시험" value={attemptAnalyticsAvailable ? `${selectedProfile?.retakeAttemptCount ?? 0}회` : "—"} color="#0f766e" />
                                    <MiniStat label="필기 보관" value={attemptAnalyticsAvailable ? `${selectedHandwritingCount}건` : "—"} color="#8b5cf6" />
                                </div>
                                <div data-testid="student-login-guide-panel" style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', fontSize: '0.75rem', fontWeight: 800, color: 'var(--muted)', letterSpacing: '0.08em' }}>
                                        <Lock size={13} />
                                        학생 계정 안내
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.45rem', fontSize: '0.78rem' }}>
                                        <div style={{ display: 'grid', gridTemplateColumns: '86px minmax(0, 1fr)', gap: '0.55rem', alignItems: 'center' }}>
                                            <span style={{ color: 'var(--muted)', fontWeight: 750 }}>로그인 ID</span>
                                            <code data-testid="student-login-id-value" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)', fontWeight: 850 }}>{selected.id}</code>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '86px minmax(0, 1fr)', gap: '0.55rem', alignItems: 'center' }}>
                                            <span style={{ color: 'var(--muted)', fontWeight: 750 }}>이메일 ID</span>
                                            <code data-testid="student-login-email-value" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)', fontWeight: 850 }}>{selected.email}</code>
                                        </div>
                                        <div style={{ display: 'grid', gridTemplateColumns: '86px minmax(0, 1fr)', gap: '0.55rem', alignItems: 'center' }}>
                                            <span style={{ color: 'var(--muted)', fontWeight: 750 }}>코드 상태</span>
                                            <span style={{ color: selectedCredentialIssued ? '#047857' : '#b45309', fontWeight: 850 }}>
                                                {selectedCredentialIssued ? '발급 기록 있음' : '미발급'}
                                            </span>
                                        </div>
                                    </div>
                                    <p style={{ fontSize: '0.74rem', color: 'var(--muted)', lineHeight: 1.55, marginTop: '0.75rem', wordBreak: 'keep-all' }}>
                                        시작 코드는 화면·클립보드·브라우저 저장소에 보관하지 않고 일회용 CSV로만 내려받습니다.
                                    </p>
                                </div>
                                {!rosterMutationsDisabled && <div data-testid="student-start-code-panel" style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.7rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontWeight: 800, color: 'var(--muted)', letterSpacing: '0.08em' }}>
                                            <KeyRound size={13} />
                                            일회용 시작 코드 발급
                                        </div>
                                    </div>
                                    <p style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.55, marginBottom: '0.75rem', wordBreak: 'keep-all' }}>
                                        재발급하면 기존 코드와 로그인 세션이 즉시 종료됩니다. 발급 후 CSV를 안전한 경로로 전달하세요.
                                    </p>
                                    <button
                                        type="button"
                                        data-testid="open-student-credential-batch"
                                        onClick={() => openStudentCredentialBatch([selected.id])}
                                        disabled={isDemoRoster}
                                        className="btn btn-primary"
                                        style={{ width: '100%', justifyContent: 'center', opacity: isDemoRoster ? 0.55 : 1 }}
                                    >
                                        <KeyRound size={14} /> {selectedCredentialIssued ? '새 코드 재발급' : '시작 코드 발급'}
                                    </button>
                                </div>}
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem' }}>
                                    <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', marginBottom: '0.5rem' }}>최근 응시 이력</div>
                                    {selectedRecentAttempts.length === 0 ? (
                                        <div style={{ fontSize: '0.85rem', color: 'var(--muted)', padding: '0.3rem 0' }}>
                                            아직 응시 이력이 없습니다.
                                        </div>
                                    ) : (
                                        selectedRecentAttempts.map((a, i) => {
                                            const pct = resolveAttemptScore(a, examById.get(a.examId)).scorePercent;
                                            const hasHandwriting = hasArchivedHandwriting(a);
                                            return (
                                                <div key={a.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: '0.6rem', alignItems: 'center', fontSize: '0.85rem', padding: '0.45rem 0', borderBottom: i < selectedRecentAttempts.length - 1 ? '1px dashed var(--border)' : 'none' }}>
                                                    <div style={{ minWidth: 0 }}>
                                                        <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 220 }}>{a.examTitle}</div>
                                                        {a.retake && (
                                                            <StatusPill
                                                                tone="retake"
                                                                label={`재시험 ${a.retake.questionIds.length}문항`}
                                                                size="sm"
                                                                style={{ marginTop: '0.25rem' }}
                                                            />
                                                        )}
                                                        {hasHandwriting && (
                                                            <div style={{ marginTop: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.35rem', color: '#7c3aed', fontSize: '0.73rem', fontWeight: 800 }}>
                                                                <PenLine size={12} />
                                                                필기 {handwritingLabel(a)}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                                                        {hasHandwriting && (
                                                            <NextLink
                                                                href={buildStudentResultHref(a.id, "handwriting")}
                                                                aria-label={`${a.examTitle} 학생 필기 열람`}
                                                                title="학생 필기 열기"
                                                                style={{
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
                                                                    justifyContent: 'center',
                                                                    minHeight: 44,
                                                                    gap: '0.25rem',
                                                                    padding: '0.25rem 0.45rem',
                                                                    borderRadius: '999px',
                                                                    background: '#f5f3ff',
                                                                    color: '#7c3aed',
                                                                    fontSize: '0.72rem',
                                                                    fontWeight: 800,
                                                                    whiteSpace: 'nowrap'
                                                                }}
                                                            >
                                                                <PenLine size={12} />
                                                                열람
                                                            </NextLink>
                                                        )}
                                                        <span style={{ fontWeight: 700, color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{pct}점</span>
                                                    </div>
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                    {!rosterMutationsDisabled && <button onClick={handleSendMessage} style={{ flex: '1 1 120px', minHeight: 44, padding: '0.7rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
                                        <MessageCircle size={14} /> 메시지
                                    </button>}
                                    {latestStableAttempt ? (
                                        <NextLink
                                            href={buildStudentResultHref(latestStableAttempt.id, "report")}
                                            aria-label={`${selected.name} 최근 응시 리포트 상세 보기`}
                                            style={{
                                                flex: '1 1 120px',
                                                minHeight: 44,
                                                padding: '0.7rem',
                                                background: 'var(--surface)',
                                                color: 'var(--foreground)',
                                                border: '1px solid var(--border)',
                                                borderRadius: 'var(--radius-md)',
                                                fontWeight: 600,
                                                fontSize: '0.85rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                            }}
                                        >
                                            상세 보기
                                        </NextLink>
                                    ) : studentGrowthReportsEnabled ? (
                                        <button onClick={handleOpenDetail} style={{ flex: '1 1 120px', minHeight: 44, padding: '0.7rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem' }}>
                                            상세 보기
                                        </button>
                                    ) : !rosterMutationsDisabled ? (
                                        <NextLink
                                            href="/teacher/billing"
                                            title="Pro 이상에서 학생 성장 리포트를 열 수 있습니다."
                                            style={{
                                                flex: '1 1 120px',
                                                minHeight: 44,
                                                padding: '0.7rem',
                                                background: 'var(--surface)',
                                                color: 'var(--muted)',
                                                border: '1px solid var(--border)',
                                                borderRadius: 'var(--radius-md)',
                                                fontWeight: 800,
                                                fontSize: '0.85rem',
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                            }}
                                        >
                                            <Lock size={14} />
                                            성장 리포트 Pro
                                        </NextLink>
                                    ) : null}
                                    {latestStableAttempt && studentGrowthReportsEnabled && (
                                        <button
                                            type="button"
                                            onClick={handleOpenDetail}
                                            style={{
                                                flex: '1 1 120px',
                                                minHeight: 44,
                                                padding: '0.7rem',
                                                background: 'var(--surface)',
                                                color: 'var(--foreground)',
                                                border: '1px solid var(--border)',
                                                borderRadius: 'var(--radius-md)',
                                                fontWeight: 600,
                                                fontSize: '0.85rem',
                                            }}
                                        >
                                            성장 분석
                                        </button>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === "groups" && (
                    <GroupsTab
                        displayGroups={displayGroups}
                        displayStudents={displayStudents}
                        analyticsAvailable={attemptAnalyticsAvailable}
                        isDemoRoster={isDemoRoster}
                        readOnly={rosterMutationsDisabled}
                        advancedAnalyticsEnabled={advancedAnalyticsEnabled}
                        handleOpenGroupProfile={handleOpenGroupProfile}
                        handleAddStudentToGroup={handleAddStudentToGroup}
                        handleOpenEditGroup={handleOpenEditGroup}
                        handleDeleteGroup={handleDeleteGroup}
                        setSelectedRegionKey={setSelectedRegionKey}
                        setQuery={setQuery}
                        setTab={setTab}
                        setEditingGroup={setEditingGroup}
                        setShowGroupModal={setShowGroupModal}
                    />
                )}

                {tab === "invites" && (
                    <InvitesTab
                        copyFlash={copyFlash}
                        hydrated={hydrated}
                        rosterInvites={rosterInvites}
                        readOnly={rosterMutationsDisabled}
                        handleCopyInvite={handleCopyInvite}
                        handleResendInvite={handleResendInvite}
                        handleCancelInvite={handleCancelInvite}
                        setShowInviteModal={setShowInviteModal}
                    />
                )}
            </main>

            {/* Student Modal (add/edit) */}
            {!rosterMutationsDisabled && showStudentModal && (
                <StudentModal
                    groups={rosterGroups}
                    initial={editingStudent}
                    defaultGroupId={studentModalDefaultGroupId}
                    onClose={() => { setShowStudentModal(false); setEditingStudent(null); setStudentModalDefaultGroupId(undefined); }}
                    onSubmit={(data) => {
                        if (editingStudent) {
                            handleEditStudent(editingStudent.id, data);
                        } else {
                            handleAddStudent(data);
                        }
                        setShowStudentModal(false);
                        setEditingStudent(null);
                        setStudentModalDefaultGroupId(undefined);
                    }}
                />
            )}

            {/* Group Modal */}
            {!rosterMutationsDisabled && showGroupModal && (
                <GroupModal
                    initial={editingGroup}
                    onClose={() => {
                        setShowGroupModal(false);
                        setEditingGroup(null);
                    }}
                    onSubmit={(data) => {
                        if (handleSaveGroup(data)) {
                            setShowGroupModal(false);
                            setEditingGroup(null);
                        }
                    }}
                />
            )}

            {/* Group Profile Modal */}
            {showGroupProfileModal && selectedGroup && selectedGroupProfile && (
                <GroupProfileModal
                    group={selectedGroup}
                    profile={selectedGroupProfile}
                    onClose={() => setShowGroupProfileModal(false)}
                    retakeAssignmentsEnabled={retakeAssignmentsEnabled}
                />
            )}

            {/* Invite Modal */}
            {!rosterMutationsDisabled && showInviteModal && (
                <InviteModal
                    onClose={() => setShowInviteModal(false)}
                    onSubmit={(email) => {
                        if (handleCreateInvite(email)) setShowInviteModal(false);
                    }}
                />
            )}

            {/* Message Modal */}
            {!rosterMutationsDisabled && showMessageModal && selected && (
                <MessageModal
                    recipient={selected.name}
                    onClose={() => setShowMessageModal(false)}
                    onSubmit={(body) => {
                        toast.info("카카오 메시지 연동 전", `${selected.name} 학생에게 보낼 ${body.length}자 메시지를 확인했습니다. 실제 발송은 아직 지원하지 않습니다.`);
                        setShowMessageModal(false);
                    }}
                />
            )}

            {/* Student Profile Modal */}
            {showProfileModal && selected && selectedProfile && (
                <StudentProfileModal
                    student={selected}
                    profile={selectedProfile}
                    onClose={() => setShowProfileModal(false)}
                    retakeAssignmentsEnabled={retakeAssignmentsEnabled}
                />
            )}

            {/* Confirm Modal */}
            {!rosterMutationsDisabled && confirmAction && (
                <ConfirmModal
                    action={confirmAction}
                    onClose={() => setConfirmAction(null)}
                    onConfirm={handleConfirmAction}
                />
            )}

            {/* Group Move Modal (DEV-A / T4) */}
            {!rosterMutationsDisabled && showGroupMoveModal && (
                <GroupMoveModal
                    groups={groups}
                    count={selectedIds.size}
                    selectedRegions={displayStudents.filter(s => selectedIds.has(s.id)).map(s => rosterStudentRegionName(s, displayGroups))}
                    onClose={() => setShowGroupMoveModal(false)}
                    onConfirm={handleConfirmGroupMove}
                />
            )}

            {/* CSV import preview (T1/T5): dry-run before committing */}
            {!rosterMutationsDisabled && csvPreview && (
                <CsvImportPreviewModal
                    plan={csvPreview}
                    onClose={() => setCsvPreview(null)}
                    onConfirm={handleConfirmCsvImport}
                />
            )}

            {!rosterMutationsDisabled && credentialBatchExpectedStudents && (
                <StudentCredentialBatchDialog
                    open
                    expectedStudents={credentialBatchExpectedStudents}
                    students={credentialBatchCurrentStudents}
                    issueStudentCredentialBatch={issueStudentCredentialBatch}
                    onIssued={handleCredentialBatchIssued}
                    onClose={() => setCredentialBatchExpectedStudents(null)}
                />
            )}

            {/* T3: the delete/undo affordance now lives in the toast host
                (ToastHost renders the "실행 취소" action button), so the
                bespoke fixed undo bar was removed. pendingDeleteUndo still
                drives the 6s restore window + the toast's action handler. */}

        </div>
    );
}
