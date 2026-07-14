"use client";

import { Suspense, useState, useMemo, useEffect, useRef, useDeferredValue } from "react";
import { useSearchParams } from "next/navigation";
import NextLink from "next/link";
import TeacherHeader from "@/components/TeacherHeader";
import { Users, UserPlus, Upload, Search, MessageCircle, TrendingUp, TrendingDown, MoreVertical, Link as LinkIcon, FolderPlus, CheckCircle2, Clock, X, Trash2, Download, PenLine, Target, AlertTriangle, FileText, BarChart3, Copy, KeyRound, RefreshCw, Lock, MapPin } from "lucide-react";
import { toast } from "@/components/Toast";
import type { Attempt, Exam, PlanKey } from "@/types/omr";
import { decodeCsvBytes, parseCsvRows, serializeCsvRows } from "@/lib/csv";
import { shouldUseDemoData } from "@/lib/demoData";
import { loadAttempts, loadExams } from "@/lib/omrPersistence";
import { loadRosterSnapshot, saveRosterSnapshot } from "@/lib/rosterPersistence";
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
    type RosterCsvFieldChange,
    type RosterCsvImportPlan,
} from "@/lib/rosterCsvImport";
import {
    buildStudentProfileInsight,
    type StudentProfileInsight,
    type StudentProfileWeaknessInsight,
} from "@/lib/studentProfileAnalytics";
import {
    buildGroupProfileInsight,
    type GroupProfileInsight,
    type GroupProfileWeaknessInsight,
} from "@/lib/groupProfileAnalytics";
import {
    DEFAULT_REGION_NAME,
    buildRegionalLearningScopes,
    regionKeyFor,
    regionNameForGroup,
    type RegionalLearningScope,
} from "@/lib/regionalAnalytics";
import { buildRetakeHref } from "@/lib/retakeLinks";
import { PremiumActionLink } from "@/components/PremiumFeatureGate";
import { findStudentStartCode, generateStartCode, readStudentCodes, writeStudentCodes } from "@/lib/studentCodes";
import { getCurrentPlan, hasPlanEntitlement } from "@/utils/plans";
import { studentIdFor } from "@/utils/storage";
import { syncStudentAccessCodes } from "@/app/actions/studentSession";
import { readActiveWorkspaceContext } from "@/lib/workspaceContext";

type TabType = "students" | "groups" | "invites";
type RosterDataMode = "real" | "demo";

type ConfirmAction =
    | { kind: "student"; id: string; label: string }
    | { kind: "bulk"; count: number }
    | { kind: "invite"; id: string; label: string }
    | { kind: "group"; id: string; label: string; count: number };
type StudentFormData = { name: string; email: string; group: string; groupId: string; region: string };
type GroupFormData = { name: string; color: string; region: string };
type PendingDeleteUndo = {
    id: number;
    students: RosterStudent[];
    codeEntries: Record<string, string>;
    label: string;
};
type SortKey = "name" | "avgScore" | "examsTaken" | "lastActive";
type SortDirection = "asc" | "desc";

const ALL_REGION_KEY = "__all_regions__";
const DELETE_UNDO_WINDOW_MS = 6000;

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

function hasArchivedHandwriting(attempt: Attempt): boolean {
    return !!attempt.handwritingArchived && !!(attempt.handwriting?.strokesRef || attempt.drawingsRef);
}

function handwritingLabel(attempt: Attempt): string {
    const questionCount = attempt.questionDrawings?.length || 0;
    if (questionCount > 0) return `${questionCount}문항`;
    if (attempt.drawingPageCount) return `${attempt.drawingPageCount}쪽`;
    return "저장됨";
}

function rosterGroupForStudentInput(groupName: string, region: string, groups: RosterGroup[], groupId?: string): RosterGroup | undefined {
    const requestedRegion = region.trim();
    if (groupId) {
        const selected = groups.find(item => item.id === groupId);
        if (selected) return selected;
    }
    return groups.find(item =>
        item.name === groupName
        && (requestedRegion ? item.region?.trim() === requestedRegion : true)
    ) || groups.find(item => item.name === groupName && !item.region?.trim())
        || groups.find(item => item.name === groupName);
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

function groupOptionLabel(group: RosterGroup): string {
    return group.region ? `${group.name} · ${group.region}` : group.name;
}

function sortAriaValue(
    sortState: { key: SortKey; direction: SortDirection } | null,
    key: SortKey,
): React.AriaAttributes["aria-sort"] {
    if (sortState?.key !== key) return "none";
    return sortState.direction === "asc" ? "ascending" : "descending";
}

function initialStudentGroupId(student: RosterStudent | null, groups: RosterGroup[]): string {
    if (!student) return groups[0]?.id ?? "";
    return rosterGroupForStudentInput(student.group, student.region || "", groups)?.id || groups.find(group => group.name === student.group)?.id || "";
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

function resolveInviteUrl(workspaceId: string): string {
    const query = new URLSearchParams({ role: "student" });
    if (workspaceId) query.set("workspace", workspaceId);
    const path = `/?${query.toString()}`;
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path}`;
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
    const [tab, setTab] = useState<TabType>(initialTab);
    useEffect(() => {
        // Keep deep links like /teacher/users?tab=groups on the requested workflow.
        setTab(initialTab);
    }, [initialTab]);
    const [query, setQuery] = useState("");
    const deferredQuery = useDeferredValue(query);
    const [selectedRegionKey, setSelectedRegionKey] = useState(ALL_REGION_KEY);
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const [students, setStudents] = useState<RosterStudent[]>([]);
    const [groups, setGroups] = useState<RosterGroup[]>([]);
    const [invites, setInvites] = useState<RosterInvite[]>([]);
    const [rosterDataMode, setRosterDataMode] = useState<RosterDataMode>("real");
    const [allAttempts, setAllAttempts] = useState<Attempt[]>([]);
    const [exams, setExams] = useState<Exam[]>([]);
    const [studentCodeRegistry, setStudentCodeRegistry] = useState<Record<string, string>>({});
    const [workspaceId, setWorkspaceId] = useState("");
    const [issuingStudentCode, setIssuingStudentCode] = useState(false);
    const [currentPlan] = useState<PlanKey>(() => getCurrentPlan());
    const [hydrated, setHydrated] = useState(false);
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
    const [copyFlash, setCopyFlash] = useState(false);
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const [showGroupMoveModal, setShowGroupMoveModal] = useState(false);
    const [pendingDeleteUndo, setPendingDeleteUndo] = useState<PendingDeleteUndo | null>(null);
    const [sortState, setSortState] = useState<{ key: SortKey; direction: SortDirection } | null>(null);
    const [csvPreview, setCsvPreview] = useState<RosterCsvImportPlan | null>(null);
    // T2: windowed pagination for the (potentially large) filtered roster.
    const [pageSize, setPageSize] = useState<number | "all">(50);
    const [page, setPage] = useState(1);

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const popoverMenuRef = useRef<HTMLTableCellElement | null>(null);
    const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Latest-ref indirection so a fired undo toast always runs the freshest
    // handler (which reads current state) instead of a stale closure.
    const undoDeleteRef = useRef<() => void>(() => {});

    // Hydrate real roster rows from localStorage. Demo rows stay display-only so
    // they cannot be mistaken for academy data in later sessions.
    useEffect(() => {
        let cancelled = false;
        const hydrateRoster = async () => {
            try {
                setWorkspaceId(readActiveWorkspaceContext(sessionStorage).organizationId);
                const storedRosterExists = hasStoredRosterData(localStorage);
                const storedStudents = readRosterStudents(localStorage);
                const storedGroups = readRosterGroups(localStorage);
                const storedInvites = readRosterInvites(localStorage);
                const legacyDemoRoster = storedRosterExists
                    && shouldUseDemoData()
                    && isLegacyDemoRosterSnapshot(storedStudents, storedGroups, storedInvites);
                if (legacyDemoRoster) {
                    Object.values(ROSTER_STORAGE_KEYS).forEach(key => localStorage.removeItem(key));
                }

                const rosterResult = await loadRosterSnapshot(localStorage);
                if (cancelled) return;
                const hasRosterRows = rosterResult.students.length > 0
                    || rosterResult.groups.length > 0
                    || rosterResult.invites.length > 0;
                const useDemoRoster = shouldUseDemoData() && !hasRosterRows;
                const nextStudents = useDemoRoster ? [] : rosterResult.students;
                const nextGroups = useDemoRoster ? [] : rosterResult.groups;
                const nextInvites = useDemoRoster ? [] : rosterResult.invites;
                // Hydrate client-only localStorage data after mount.
                setStudents(nextStudents);
                setGroups(nextGroups);
                setInvites(nextInvites);
                setRosterDataMode(useDemoRoster ? "demo" : "real");
                if (rosterResult.remoteError) {
                    toast.info(
                        "명단은 로컬 기준으로 표시 중",
                        "Supabase 명단 동기화가 지연되어 현재 기기 데이터를 우선 사용했습니다."
                    );
                }
                const storedCodes = readStudentCodes(localStorage);
                setStudentCodeRegistry(storedCodes);
                const codeEntries = Object.entries(storedCodes).map(([studentId, code]) => ({ studentId, code }));
                if (codeEntries.length > 0) {
                    void syncStudentAccessCodes(codeEntries).then(result => {
                        if (cancelled || result.status === "ok" || result.status === "degraded_local") return;
                        toast.info(
                            "시작 코드는 이 기기에 보관 중",
                            "서버 동기화가 지연되어 다음 명단 로드 때 다시 연결합니다."
                        );
                    });
                }
            } catch {
                if (cancelled) return;
                setStudents([]);
                setGroups([]);
                setInvites([]);
                setStudentCodeRegistry({});
                setRosterDataMode("real");
            }
            setHydrated(true);
        };

        void hydrateRoster();
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        const loadRosterAnalytics = async () => {
            const [attemptResult, examResult] = await Promise.all([
                loadAttempts(),
                loadExams(),
            ]);
            if (cancelled) return;
            setAllAttempts(attemptResult.items);
            setExams(examResult.items);
            if (attemptResult.remoteError || examResult.remoteError) {
                toast.info(
                    "로컬 응시 데이터 기준으로 표시 중",
                    "서버 동기화가 일부 지연되어 학생 평균은 현재 기기 데이터로 계산했습니다."
                );
            }
        };

        void loadRosterAnalytics();
        return () => { cancelled = true; };
    }, []);

    // M7: dismiss the row action popover on outside click or Escape.
    useEffect(() => {
        if (!popoverId) return;
        const handlePointerDown = (event: MouseEvent) => {
            if (popoverMenuRef.current?.contains(event.target as Node)) return;
            setPopoverId(null);
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setPopoverId(null);
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

    // Write-through helpers
    const persistRoster = (nextStudents: RosterStudent[], nextGroups: RosterGroup[], nextInvites: RosterInvite[]) => {
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
        void saveRosterSnapshot(localStorage, {
            students: nextStudents,
            groups: nextGroups,
            invites: nextInvites,
        }).then(result => {
            if (result.remoteError) {
                toast.info(
                    "명단은 로컬에 저장됨",
                    "Supabase 명단 동기화는 다음 로드 때 다시 시도합니다."
                );
            }
        });
    };

    // Recompute group stats from current students
    const recomputeGroups = (studentsList: RosterStudent[], groupsList: RosterGroup[]): RosterGroup[] => (
        recomputeRosterGroupsFromStudents(studentsList, groupsList)
    );

    const examById = useMemo(() => (
        new Map(exams.map(exam => [exam.id, exam]))
    ), [exams]);

    const isDemoRoster = rosterDataMode === "demo";
    const rosterStudents = isDemoRoster ? MOCK_STUDENTS : students;
    const rosterGroups = isDemoRoster ? MOCK_GROUPS : groups;
    const rosterInvites = isDemoRoster ? MOCK_INVITES : invites;

    const performanceByStudentId = useMemo(() => (
        buildRosterPerformanceMap(rosterStudents, allAttempts, examById)
    ), [rosterStudents, allAttempts, examById]);

    const displayStudents = useMemo(() => (
        applyRosterPerformance(rosterStudents, performanceByStudentId)
    ), [rosterStudents, performanceByStudentId]);

    const displayGroups = useMemo(() => (
        recomputeRosterGroupsFromStudents(displayStudents, rosterGroups)
    ), [displayStudents, rosterGroups]);

    const regionalScopes = useMemo(() => (
        buildRegionalLearningScopes({
            students: displayStudents,
            groups: displayGroups,
            attempts: allAttempts,
            exams,
        })
    ), [displayStudents, displayGroups, allAttempts, exams]);

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
    const selectedLegacyStudentId = selected ? studentIdForRoster(selected.name, selected.group, rosterGroups) : "";
    const selectedStartCode = selected ? findStudentStartCode(studentCodeRegistry, selected.id, selectedLegacyStudentId) : "";

    // Recent attempts for the selected student (from omr_attempts)
    const selectedRecentAttempts = useMemo<Attempt[]>(() => {
        if (!selected) return [];
        return performanceByStudentId.get(selected.id)?.attempts.slice(0, 3) || [];
    }, [selected, performanceByStudentId]);

    const selectedProfile = useMemo<StudentProfileInsight | null>(() => {
        if (!selected) return null;
        return buildStudentProfileInsight(selected, allAttempts, examById, {
            recentLimit: 8,
            weaknessLimit: 6,
        });
    }, [selected, allAttempts, examById]);

    const selectedHandwritingCount = selectedProfile?.handwritingArchiveCount ?? 0;

    const selectedGroupProfile = useMemo<GroupProfileInsight | null>(() => {
        if (!selectedGroup) return null;
        return buildGroupProfileInsight(selectedGroup, displayStudents, allAttempts, examById, {
            examLimit: 6,
            weaknessLimit: 6,
            riskLimit: 5,
        });
    }, [selectedGroup, displayStudents, allAttempts, examById]);

    // Detail-panel button handlers
    const handleSendMessage = () => {
        if (isDemoRoster) {
            toast.info("데모 명단은 전송하지 않음", "실제 학생을 추가하거나 CSV로 업로드한 뒤 카카오 메시지를 준비할 수 있습니다.");
            return;
        }
        setShowMessageModal(true);
    };
    const handleOpenDetail = () => {
        if (!studentGrowthReportsEnabled) {
            toast.info("학생 성장 리포트는 Pro 기능입니다", "기본 명단과 최근 점수는 확인할 수 있고, 누적 성장/취약 유형 리포트는 Pro 이상에서 열립니다.");
            return;
        }
        if (!selectedProfile) {
            toast.info("상세 데이터를 찾을 수 없음", "학생을 다시 선택한 뒤 열어주세요.");
            return;
        }
        setShowProfileModal(true);
    };

    const handleOpenGroupProfile = (groupId: string) => {
        if (!advancedAnalyticsEnabled) {
            toast.info("반별 분석 리포트는 Pro 기능입니다", "반 목록과 평균은 확인할 수 있고, 반별 약점/집중 관리 리포트는 Pro 이상에서 열립니다.");
            return;
        }
        setSelectedGroupId(groupId);
        setShowGroupProfileModal(true);
    };

    const handleIssueStudentStartCode = async () => {
        if (!selected || isDemoRoster) {
            toast.info("실제 학생에서만 코드 발급", "저장된 명단의 학생을 선택한 뒤 시작 코드를 발급할 수 있습니다.");
            return;
        }
        if (issuingStudentCode) return;
        setIssuingStudentCode(true);
        const nextCode = generateStartCode();
        const nextRegistry = { ...studentCodeRegistry, [selected.id]: nextCode };
        if (!writeStudentCodes(localStorage, nextRegistry)) {
            toast.error("코드 저장 실패", "브라우저 저장소를 확인한 뒤 다시 시도해주세요.");
            setIssuingStudentCode(false);
            return;
        }
        setStudentCodeRegistry(nextRegistry);
        try {
            const result = await syncStudentAccessCodes([{ studentId: selected.id, code: nextCode }]);
            if (result.status === "error" || result.status === "unauthenticated" || result.missingCount) {
                toast.info(
                    "코드는 이 기기에 발급됨",
                    "학생 서버 계정 연결이 지연되었습니다. 명단 동기화 후 다시 발급해주세요."
                );
                return;
            }
            toast.success(selectedStartCode ? "시작 코드 재발급" : "시작 코드 발급", `${selected.name}: ${nextCode}`);
        } catch {
            toast.info(
                "코드는 이 기기에 발급됨",
                "서버 연결이 지연되었습니다. 온라인 학생 로그인 전 다시 발급해주세요."
            );
        } finally {
            setIssuingStudentCode(false);
        }
    };

    const handleCopyStudentStartCode = async () => {
        if (!selectedStartCode) return;
        try {
            await navigator.clipboard.writeText(selectedStartCode);
            toast.success("시작 코드 복사됨", `${selected?.name || "학생"} 코드 ${selectedStartCode}`);
        } catch {
            toast.error("복사 실패", "브라우저 클립보드 권한을 확인해주세요.");
        }
    };

    const handleCopyStudentId = async () => {
        if (!selected) return;
        try {
            await navigator.clipboard.writeText(selected.id);
            toast.success("학생번호 복사됨", `${selected.name}: ${selected.id}`);
        } catch {
            toast.error("복사 실패", "브라우저 클립보드 권한을 확인해주세요.");
        }
    };

    const handleCopyStudentLoginInfo = async () => {
        if (!selected) return;
        const loginInfo = [
            "OMR Maker 학생 로그인 안내",
            `이름: ${selected.name}`,
            `반: ${selected.group}`,
            `로그인 ID(학생번호): ${selected.id}`,
            `이메일 로그인 ID: ${selected.email}`,
            `시작 코드: ${selectedStartCode || "미발급 - 선생님에게 발급 요청"}`,
        ].join("\n");

        try {
            await navigator.clipboard.writeText(loginInfo);
            toast.success("학생 계정 안내 복사됨", `${selected.name} 로그인 정보를 복사했습니다.`);
        } catch {
            toast.error("복사 실패", "브라우저 클립보드 권한을 확인해주세요.");
        }
    };

    // ===== Student CRUD =====
    const handleAddStudent = (data: StudentFormData) => {
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

    // Deterministic student ids ("${groupId}::${name}") mean a same-named
    // replacement student added later would silently inherit a deleted
    // student's leftover start code unless the registry entry is purged too.
    const purgeStudentCodes = (ids: string[]): Record<string, string> => {
        const idSet = new Set(ids.filter(Boolean));
        const removedEntries: Record<string, string> = {};
        if (idSet.size === 0) return removedEntries;
        const nextRegistry = { ...studentCodeRegistry };
        for (const id of idSet) {
            if (nextRegistry[id]) {
                removedEntries[id] = nextRegistry[id];
                delete nextRegistry[id];
            }
        }
        if (Object.keys(removedEntries).length > 0) {
            setStudentCodeRegistry(nextRegistry);
            writeStudentCodes(localStorage, nextRegistry);
        }
        return removedEntries;
    };

    const clearDeleteUndoTimer = () => {
        if (undoTimeoutRef.current) {
            clearTimeout(undoTimeoutRef.current);
            undoTimeoutRef.current = null;
        }
    };

    const scheduleDeleteUndo = (removed: RosterStudent[], codeEntries: Record<string, string>, label: string) => {
        clearDeleteUndoTimer();
        const undoId = Date.now();
        setPendingDeleteUndo({ id: undoId, students: removed, codeEntries, label });
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
        const removedCodeEntries = purgeStudentCodes(ids);
        scheduleDeleteUndo(removed, removedCodeEntries, label);
    };

    const handleUndoDelete = () => {
        if (!pendingDeleteUndo) return;
        clearDeleteUndoTimer();
        const restored = pendingDeleteUndo;
        setPendingDeleteUndo(null);
        const restoredIds = new Set(restored.students.map(s => s.id));
        const merged = [...restored.students, ...students.filter(s => !restoredIds.has(s.id))];
        persistRoster(merged, recomputeGroups(merged, groups), invites);
        if (Object.keys(restored.codeEntries).length > 0) {
            const nextRegistry = { ...studentCodeRegistry, ...restored.codeEntries };
            setStudentCodeRegistry(nextRegistry);
            writeStudentCodes(localStorage, nextRegistry);
        }
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
        if (isDemoRoster) return;
        setSelectedIds(prev => {
            const n = new Set(prev);
            if (n.has(id)) n.delete(id); else n.add(id);
            return n;
        });
    };
    const toggleSelectAll = (visibleIds: string[]) => {
        if (isDemoRoster) return;
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
                s.avgScore,
                s.examsTaken,
                s.lastActive,
                s.trend,
                s.status,
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
        try {
            const activeWorkspaceId = workspaceId || readActiveWorkspaceContext(sessionStorage).organizationId;
            await navigator.clipboard.writeText(resolveInviteUrl(activeWorkspaceId));
            setCopyFlash(true);
            setTimeout(() => setCopyFlash(false), 1500);
        } catch {}
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
            id: `i-${Date.now()}`,
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

    const handleConfirmCsvImport = (dispositions: Record<number, RosterCsvConflictDisposition>) => {
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

    return (
        <div className="layout-main">
            <div className="orb orb-primary" />
            <div className="orb orb-accent" />
            <TeacherHeader badge="USERS" badgeColor="#22c55e" />

            <main className="container animate-fade-in" style={{ paddingBottom: '4rem', position: 'relative', zIndex: 1 }}>
                <div style={{ margin: '3rem 0 2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: '2rem', flexWrap: 'wrap' }}>
                    <div>
                        <h1 className="title-gradient" style={{ fontSize: '2.5rem', marginBottom: '0.5rem', lineHeight: 1.2 }}>
                            사용자 관리
                        </h1>
                        <p className="text-muted" style={{ fontSize: '1.05rem' }}>
                            학생, 반, 초대를 한 곳에서 관리하세요.
                        </p>
                    </div>
                    <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".csv"
                            style={{ display: 'none' }}
                            onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) handleCsvFile(f);
                                if (fileInputRef.current) fileInputRef.current.value = "";
                            }}
                        />
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
                    </div>
                </div>

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

                {/* KPI */}
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
                                onChange={e => setSelectedRegionKey(e.target.value)}
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
                                            <MiniRegionMetric label="평균" value={`${scope.averageScore}점`} />
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

                {/* Sub-tabs */}
                <div style={{
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
                                                    disabled={isDemoRoster}
                                                    style={{ cursor: isDemoRoster ? 'not-allowed' : 'pointer', accentColor: 'var(--primary)' }}
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
                                                        disabled={isDemoRoster}
                                                        style={{ cursor: isDemoRoster ? 'not-allowed' : 'pointer', accentColor: 'var(--primary)' }}
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
                                                        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: s.avgScore >= 80 ? 'var(--success)' : s.avgScore >= 65 ? 'var(--warning)' : 'var(--error)' }}>{s.avgScore}</span>
                                                        {s.trend === "up" && <TrendingUp size={14} color="var(--success)" />}
                                                        {s.trend === "down" && <TrendingDown size={14} color="var(--error)" />}
                                                    </div>
                                                </td>
                                                <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>{s.examsTaken}회</td>
                                                <td style={{ padding: '0.85rem 0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
                                                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem' }}>
                                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: s.status === "active" ? 'var(--success)' : 'var(--muted)' }} />
                                                        {s.lastActive}
                                                    </span>
                                                </td>
                                                <td
                                                    ref={s.id === popoverId ? popoverMenuRef : undefined}
                                                    style={{ padding: '0.85rem 0.5rem', textAlign: 'right', position: 'relative' }}
                                                >
                                                    {!isDemoRoster && (
                                                        <button
                                                            aria-label={`${s.name} 작업 메뉴 열기`}
                                                            onClick={(e) => {
                                                                e.stopPropagation();
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
                            {hydrated && filtered.length === 0 && (
                                <div style={{ padding: '3rem 2rem', textAlign: 'center' }}>
                                    <div style={{
                                        width: 64, height: 64, borderRadius: '50%',
                                        background: 'rgba(99,102,241,0.08)',
                                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                        color: 'var(--primary)', marginBottom: '1rem'
                                    }}>
                                        <Users size={28} />
                                    </div>
                                    <div style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.35rem' }}>
                                        {displayStudents.length === 0 ? '아직 등록된 학생이 없습니다' : '검색 결과가 없습니다'}
                                    </div>
                                    <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.25rem' }}>
                                        {displayStudents.length === 0
                                            ? '학생을 추가하거나 CSV로 업로드해서 시작하세요.'
                                            : '다른 키워드로 검색해보세요.'}
                                    </div>
                                    {displayStudents.length === 0 && (
                                        <div style={{ display: 'inline-flex', gap: '0.5rem' }}>
                                            <button
                                                onClick={() => { setEditingStudent(null); setShowStudentModal(true); }}
                                                style={{
                                                    padding: '0.55rem 1.1rem', background: 'linear-gradient(135deg, #22c55e, #10b981)',
                                                    color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem',
                                                    display: 'flex', alignItems: 'center', gap: '0.4rem'
                                                }}>
                                                <UserPlus size={14} /> 학생 추가
                                            </button>
                                            <button
                                                onClick={() => fileInputRef.current?.click()}
                                                style={{
                                                    padding: '0.55rem 1.1rem', background: 'var(--surface)',
                                                    border: '1px solid var(--border)',
                                                    borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem',
                                                    display: 'flex', alignItems: 'center', gap: '0.4rem'
                                                }}>
                                                <Upload size={14} /> CSV 업로드
                                            </button>
                                        </div>
                                    )}
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
                                    <MiniStat label="원시험 평균" value={`${selected.avgScore}점`} color="#4f46e5" />
                                    <MiniStat label="원시험" value={`${selected.examsTaken}회`} color="#10b981" />
                                    <MiniStat label="재시험" value={`${selectedProfile?.retakeAttemptCount ?? 0}회`} color="#0f766e" />
                                    <MiniStat label="필기 보관" value={`${selectedHandwritingCount}건`} color="#8b5cf6" />
                                </div>
                                <div data-testid="student-login-guide-panel" style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.75rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontWeight: 800, color: 'var(--muted)', letterSpacing: '0.08em' }}>
                                            <Lock size={13} />
                                            학생 계정 안내
                                        </div>
                                        <button
                                            type="button"
                                            aria-label="학생 계정 안내 복사"
                                            data-testid="copy-student-login-credentials"
                                            onClick={handleCopyStudentLoginInfo}
                                            style={{
                                                padding: '0.35rem 0.55rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.72rem',
                                                fontWeight: 800,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.3rem',
                                                whiteSpace: 'nowrap',
                                            }}
                                        >
                                            <Copy size={12} />
                                            안내 복사
                                        </button>
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
                                            <span style={{ color: 'var(--muted)', fontWeight: 750 }}>시작 코드</span>
                                            <code data-testid="student-login-start-code-value" style={{
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                color: selectedStartCode ? '#047857' : '#b45309',
                                                fontWeight: 850,
                                                letterSpacing: selectedStartCode ? '0.08em' : 0,
                                            }}>{selectedStartCode || '미발급'}</code>
                                        </div>
                                    </div>
                                    <p style={{ fontSize: '0.74rem', color: 'var(--muted)', lineHeight: 1.55, marginTop: '0.75rem', wordBreak: 'keep-all' }}>
                                        학생에게 이름, 반, 로그인 ID, 시작 코드를 함께 전달하세요. 이메일도 로그인 ID로 사용할 수 있습니다.
                                    </p>
                                </div>
                                <div data-testid="student-start-code-panel" style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', marginBottom: '1rem', border: '1px solid var(--border)' }}>
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.7rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', fontWeight: 800, color: 'var(--muted)', letterSpacing: '0.08em' }}>
                                            <KeyRound size={13} />
                                            시작 코드
                                        </div>
                                        <span style={{
                                            minWidth: 86,
                                            textAlign: 'center',
                                            padding: '0.25rem 0.5rem',
                                            borderRadius: '999px',
                                            background: selectedStartCode ? 'rgba(16,185,129,0.1)' : 'rgba(245,158,11,0.12)',
                                            color: selectedStartCode ? '#047857' : '#b45309',
                                            fontSize: '0.72rem',
                                            fontWeight: 850,
                                            fontVariantNumeric: 'tabular-nums',
                                            letterSpacing: selectedStartCode ? '0.08em' : 0,
                                        }} data-testid="student-start-code-value">
                                            {selectedStartCode || '미발급'}
                                        </span>
                                    </div>
                                    <p style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.55, marginBottom: '0.75rem', wordBreak: 'keep-all' }}>
                                        학생 포털 재로그인과 반 제한 시험 입장에 쓰는 6자리 코드입니다.
                                    </p>
                                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                                        <button
                                            type="button"
                                            aria-label={selectedStartCode ? '학생 시작 코드 재발급' : '학생 시작 코드 발급'}
                                            data-testid="issue-student-start-code"
                                            onClick={handleIssueStudentStartCode}
                                            disabled={isDemoRoster || issuingStudentCode}
                                            style={{
                                                flex: 1,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.78rem',
                                                fontWeight: 800,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                                opacity: isDemoRoster || issuingStudentCode ? 0.55 : 1,
                                            }}
                                        >
                                            <RefreshCw size={13} className={issuingStudentCode ? 'animate-spin' : undefined} />
                                            {issuingStudentCode ? '연결 중' : selectedStartCode ? '재발급' : '발급'}
                                        </button>
                                        <button
                                            type="button"
                                            aria-label="학생 시작 코드 복사"
                                            data-testid="copy-student-start-code"
                                            onClick={handleCopyStudentStartCode}
                                            disabled={!selectedStartCode}
                                            style={{
                                                flex: 1,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: selectedStartCode ? 'var(--primary)' : 'var(--surface)',
                                                border: selectedStartCode ? '1px solid var(--primary)' : '1px solid var(--border)',
                                                color: selectedStartCode ? 'white' : 'var(--muted)',
                                                fontSize: '0.78rem',
                                                fontWeight: 800,
                                                display: 'flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                                opacity: selectedStartCode ? 1 : 0.55,
                                            }}
                                        >
                                            <Copy size={13} />
                                            복사
                                        </button>
                                    </div>
                                </div>
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
                                                            <div style={{ marginTop: '0.25rem', display: 'inline-flex', alignItems: 'center', gap: '0.25rem', color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: '999px', padding: '0.1rem 0.4rem', fontSize: '0.7rem', fontWeight: 900 }}>
                                                                재시험 {a.retake.questionIds.length}문항
                                                            </div>
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
                                                                href={`/teacher/attempt/${a.id}`}
                                                                title="학생 필기 리포트 열기"
                                                                style={{
                                                                    display: 'inline-flex',
                                                                    alignItems: 'center',
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
                                <div style={{ display: 'flex', gap: '0.5rem' }}>
                                    <button onClick={handleSendMessage} style={{ flex: 1, padding: '0.7rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem' }}>
                                        <MessageCircle size={14} /> 메시지
                                    </button>
                                    {studentGrowthReportsEnabled ? (
                                        <button onClick={handleOpenDetail} style={{ flex: 1, padding: '0.7rem', background: 'var(--surface)', color: 'var(--foreground)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem' }}>
                                            상세 보기
                                        </button>
                                    ) : (
                                        <NextLink
                                            href="/teacher/billing"
                                            title="Pro 이상에서 학생 성장 리포트를 열 수 있습니다."
                                            style={{
                                                flex: 1,
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
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                )}

                {tab === "groups" && (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '1.25rem' }}>
                        {displayGroups.map(g => {
                            const groupRegion = regionNameForGroup(g, displayStudents);
                            return (
                                <article
                                    key={g.id}
                                    className="bento-card card-hover"
                                    style={{
                                        padding: '1.5rem',
                                        textAlign: 'left',
                                        color: 'var(--foreground)',
                                        minHeight: 220,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: '1rem',
                                    }}
                                >
                                    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.9rem' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', minWidth: 0 }}>
                                            <div style={{
                                                width: 46, height: 46, borderRadius: 'var(--radius-md)',
                                                background: `color-mix(in srgb, ${g.color}, transparent 88%)`, color: g.color,
                                                display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0
                                            }}>
                                                <Users size={22} />
                                            </div>
                                            <div style={{ minWidth: 0 }}>
                                                <h3 style={{
                                                    fontSize: '1.05rem',
                                                    fontWeight: 800,
                                                    lineHeight: 1.25,
                                                    marginBottom: '0.25rem',
                                                    overflow: 'hidden',
                                                    display: '-webkit-box',
                                                    WebkitLineClamp: 2,
                                                    WebkitBoxOrient: 'vertical',
                                                }}>{g.name}</h3>
                                                <p style={{ fontSize: '0.83rem', color: 'var(--muted)' }}>{g.count}명 등록 · {groupRegion}</p>
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 편집`}
                                            onClick={() => handleOpenEditGroup(g)}
                                            disabled={isDemoRoster}
                                            title={isDemoRoster ? "데모 반은 편집할 수 없습니다." : "반 정보 편집"}
                                            style={{
                                                width: 44,
                                                height: 44,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--background)',
                                                border: '1px solid var(--border)',
                                                color: isDemoRoster ? 'var(--muted)' : 'var(--foreground)',
                                                opacity: isDemoRoster ? 0.55 : 1,
                                                flexShrink: 0,
                                            }}
                                        >
                                            <PenLine size={16} />
                                        </button>
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.6rem' }}>
                                        <MiniStat label="학생" value={`${g.count}명`} color={g.color} />
                                        <MiniStat label="평균" value={`${g.avgScore}점`} color={g.color} />
                                    </div>

                                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: '0.5rem', marginTop: 'auto' }}>
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 학생 보기`}
                                            onClick={() => {
                                                setSelectedRegionKey(g.region ? regionKeyFor(g.region) : ALL_REGION_KEY);
                                                setQuery(g.name);
                                                setTab("students");
                                            }}
                                            style={{
                                                minHeight: 44,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.78rem',
                                                fontWeight: 800,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                            }}
                                        >
                                            <Search size={13} />
                                            학생 보기
                                        </button>
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 학생 추가`}
                                            onClick={() => handleAddStudentToGroup(g)}
                                            disabled={isDemoRoster}
                                            style={{
                                                minHeight: 44,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--primary)',
                                                color: 'white',
                                                fontSize: '0.78rem',
                                                fontWeight: 800,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                                opacity: isDemoRoster ? 0.55 : 1,
                                            }}
                                        >
                                            <UserPlus size={13} />
                                            학생 추가
                                        </button>
                                        {advancedAnalyticsEnabled ? (
                                            <button
                                                type="button"
                                                aria-label={`${g.name} 분석 열기`}
                                                onClick={() => handleOpenGroupProfile(g.id)}
                                                style={{
                                                    minHeight: 44,
                                                    padding: '0.55rem 0.65rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: `color-mix(in srgb, ${g.color}, transparent 88%)`,
                                                    color: g.color,
                                                    fontSize: '0.78rem',
                                                    fontWeight: 900,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '0.35rem',
                                                }}
                                            >
                                                <BarChart3 size={13} />
                                                분석
                                            </button>
                                        ) : (
                                            <NextLink
                                                href="/teacher/billing"
                                                aria-label={`${g.name} 반별 리포트 Pro 보기`}
                                                title="Pro 이상에서 반별 분석 리포트를 열 수 있습니다."
                                                style={{
                                                    minHeight: 44,
                                                    padding: '0.55rem 0.65rem',
                                                    borderRadius: 'var(--radius-md)',
                                                    background: 'var(--surface)',
                                                    border: '1px solid var(--border)',
                                                    color: 'var(--muted)',
                                                    fontSize: '0.78rem',
                                                    fontWeight: 900,
                                                    display: 'inline-flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    gap: '0.35rem',
                                                }}
                                            >
                                                <Lock size={13} />
                                                리포트 Pro
                                            </NextLink>
                                        )}
                                        <button
                                            type="button"
                                            aria-label={`${g.name} 삭제`}
                                            onClick={() => handleDeleteGroup(g)}
                                            disabled={isDemoRoster}
                                            style={{
                                                minHeight: 44,
                                                padding: '0.55rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'rgba(239,68,68,0.08)',
                                                border: '1px solid rgba(239,68,68,0.2)',
                                                color: '#ef4444',
                                                fontSize: '0.78rem',
                                                fontWeight: 900,
                                                display: 'inline-flex',
                                                alignItems: 'center',
                                                justifyContent: 'center',
                                                gap: '0.35rem',
                                                opacity: isDemoRoster ? 0.55 : 1,
                                            }}
                                        >
                                            <Trash2 size={13} />
                                            삭제
                                        </button>
                                    </div>
                                </article>
                            );
                        })}
                        <button
                            onClick={() => {
                                setEditingGroup(null);
                                setShowGroupModal(true);
                            }}
                            className="bento-card card-hover"
                            style={{
                                padding: '1.5rem', cursor: 'pointer', display: 'flex',
                                flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                                border: '2px dashed var(--border)', background: 'transparent', gap: '0.5rem',
                                color: 'var(--muted)', minHeight: 160
                            }}>
                            <FolderPlus size={28} />
                            <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>새 반 만들기</span>
                        </button>
                    </div>
                )}

                {tab === "invites" && (
                    <div className="bento-card" style={{ padding: '1.5rem' }}>
                        <div style={{
                            display: 'flex', gap: '0.75rem', padding: '1rem 1.25rem',
                            background: 'linear-gradient(135deg, rgba(99,102,241,0.06), rgba(139,92,246,0.06))',
                            borderRadius: 'var(--radius-md)', border: '1px solid rgba(99,102,241,0.15)',
                            marginBottom: '1.5rem', alignItems: 'center'
                        }}>
                            <LinkIcon size={20} color="var(--primary)" style={{ flexShrink: 0, marginTop: 2 }} />
                            <div style={{ flex: 1 }}>
                                <div style={{ fontSize: '0.85rem', fontWeight: 700, marginBottom: '0.25rem' }}>초대 링크</div>
                                <code style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
                                    현재 도메인/?role=student&amp;workspace={workspaceId || '내-학원'}
                                </code>
                            </div>
                            {copyFlash && (
                                <span style={{ fontSize: '0.8rem', color: 'var(--success)', fontWeight: 700 }}>복사됨</span>
                            )}
                            <button
                                onClick={handleCopyInvite}
                                style={{ padding: '0.5rem 1rem', background: 'var(--surface)', color: 'var(--primary)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.8rem' }}
                            >
                                링크 복사
                            </button>
                            <button
                                onClick={() => setShowInviteModal(true)}
                                style={{ padding: '0.5rem 1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                            >
                                <MessageCircle size={13} /> 카카오 초대 기록
                            </button>
                        </div>

                        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                            <thead>
                                <tr style={{ color: 'var(--muted)', fontSize: '0.8rem', borderBottom: '1px solid var(--border)', fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>초대 연락처</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>기록 시각</th>
                                    <th style={{ padding: '0.85rem 0.5rem' }}>상태</th>
                                    <th style={{ padding: '0.85rem 0.5rem', textAlign: 'right' }}>작업</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rosterInvites.map(inv => {
                                    const map = {
                                        pending: { color: '#f59e0b', bg: 'rgba(245,158,11,0.1)', label: '대기 중' },
                                        accepted: { color: '#10b981', bg: 'rgba(16,185,129,0.1)', label: '수락됨' },
                                        expired: { color: '#94a3b8', bg: 'rgba(148,163,184,0.1)', label: '만료' },
                                    };
                                    const m = map[inv.status as keyof typeof map] ?? map.pending;
                                    return (
                                        <tr key={inv.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.9rem', fontWeight: 600 }}>{inv.email}</td>
                                            <td style={{ padding: '1rem 0.5rem', fontSize: '0.85rem', color: 'var(--muted)' }}>{inv.sentAt}</td>
                                            <td style={{ padding: '1rem 0.5rem' }}>
                                                <span style={{
                                                    background: m.bg, color: m.color, padding: '0.3rem 0.7rem',
                                                    borderRadius: 'var(--radius-full)', fontSize: '0.75rem', fontWeight: 700
                                                }}>{m.label}</span>
                                            </td>
                                            <td style={{ padding: '1rem 0.5rem', textAlign: 'right' }}>
                                                <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
                                                    {inv.status !== "accepted" && (
                                                        <button
                                                            onClick={() => handleResendInvite(inv.id)}
                                                            style={{ fontSize: '0.8rem', color: 'var(--primary)', fontWeight: 600 }}
                                                        >
                                                            기록 갱신
                                                        </button>
                                                    )}
                                                    <button
                                                        onClick={() => handleCancelInvite(inv.id)}
                                                        style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 500 }}
                                                    >
                                                        취소
                                                    </button>
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                        {hydrated && rosterInvites.length === 0 && (
                            <div style={{ padding: '2.5rem 1rem', textAlign: 'center', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                아직 저장된 초대 기록이 없습니다. 위의 <strong style={{ color: 'var(--primary)' }}>카카오 초대 기록</strong> 버튼으로 시작하세요.
                            </div>
                        )}
                    </div>
                )}
            </main>

            {/* Student Modal (add/edit) */}
            {showStudentModal && (
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
            {showGroupModal && (
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
            {showInviteModal && (
                <InviteModal
                    onClose={() => setShowInviteModal(false)}
                    onSubmit={(email) => {
                        if (handleCreateInvite(email)) setShowInviteModal(false);
                    }}
                />
            )}

            {/* Message Modal */}
            {showMessageModal && selected && (
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
            {confirmAction && (
                <ConfirmModal
                    action={confirmAction}
                    onClose={() => setConfirmAction(null)}
                    onConfirm={handleConfirmAction}
                />
            )}

            {/* Group Move Modal (DEV-A / T4) */}
            {showGroupMoveModal && (
                <GroupMoveModal
                    groups={groups}
                    count={selectedIds.size}
                    selectedRegions={displayStudents.filter(s => selectedIds.has(s.id)).map(s => rosterStudentRegionName(s, displayGroups))}
                    onClose={() => setShowGroupMoveModal(false)}
                    onConfirm={handleConfirmGroupMove}
                />
            )}

            {/* CSV import preview (T1/T5): dry-run before committing */}
            {csvPreview && (
                <CsvImportPreviewModal
                    plan={csvPreview}
                    onClose={() => setCsvPreview(null)}
                    onConfirm={handleConfirmCsvImport}
                />
            )}

            {/* T3: the delete/undo affordance now lives in the toast host
                (ToastHost renders the "실행 취소" action button), so the
                bespoke fixed undo bar was removed. pendingDeleteUndo still
                drives the 6s restore window + the toast's action handler. */}

        </div>
    );
}

function KPI({ label, value, color, icon }: { label: string; value: number; color: string; icon: React.ReactNode }) {
    return (
        <div className="bento-card" style={{ padding: '1.25rem 1.4rem', position: 'relative', overflow: 'hidden' }}>
            <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${color}, transparent)` }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem' }}>
                <div>
                    <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: '0.5rem' }}>{label}</div>
                    <div style={{ fontSize: '2rem', fontWeight: 900, letterSpacing: '-0.03em', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
                </div>
                <div style={{
                    color, background: `color-mix(in srgb, ${color}, transparent 88%)`,
                    padding: 10, borderRadius: 12, display: 'flex', alignItems: 'center', justifyContent: 'center'
                }}>{icon}</div>
            </div>
        </div>
    );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
    return (
        <div style={{ padding: '0.85rem', background: `color-mix(in srgb, ${color}, transparent 92%)`, borderRadius: 'var(--radius-md)', border: `1px solid ${color}22` }}>
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--muted)', letterSpacing: '0.05em', marginBottom: '0.25rem' }}>{label}</div>
            <div style={{ fontSize: '1.15rem', fontWeight: 800, color }}>{value}</div>
        </div>
    );
}

function MiniRegionMetric({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <div style={{ fontSize: '0.65rem', color: 'var(--muted)', fontWeight: 800, marginBottom: '0.15rem' }}>{label}</div>
            <div style={{ fontSize: '0.9rem', color: 'var(--foreground)', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        </div>
    );
}

// DEV-B: clickable/keyboard-focusable table header that toggles asc/desc
// sort for a column, with a small arrow indicator. Rendered inside a plain
// <th> so it inherits the header row's text styling via `font: inherit`.
function SortableHeaderButton({
    label, sortKey, sortState, onSort,
}: {
    label: string;
    sortKey: SortKey;
    sortState: { key: SortKey; direction: SortDirection } | null;
    onSort: (key: SortKey) => void;
}) {
    const active = sortState?.key === sortKey;
    return (
        <button
            type="button"
            onClick={() => onSort(sortKey)}
            style={{
                display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
                background: 'transparent', color: 'inherit', font: 'inherit',
                letterSpacing: 'inherit', textTransform: 'inherit', cursor: 'pointer',
                padding: 0,
            }}
        >
            {label}
            <span aria-hidden="true" style={{ fontSize: '0.65rem', opacity: active ? 1 : 0.35 }}>
                {active ? (sortState?.direction === "asc" ? "▲" : "▼") : "↕"}
            </span>
        </button>
    );
}

// ===== Inline modals =====

function formatAttemptDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "일시 없음";
    return new Intl.DateTimeFormat("ko-KR", {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    }).format(date);
}

function scoreColor(score: number): string {
    if (score >= 80) return "var(--success)";
    if (score >= 65) return "var(--warning)";
    return "var(--error)";
}

function weaknessKindLabel(kind: StudentProfileWeaknessInsight["kind"] | GroupProfileWeaknessInsight["kind"]): string {
    const labels: Record<StudentProfileWeaknessInsight["kind"] | GroupProfileWeaknessInsight["kind"], string> = {
        concept: "개념",
        mistakeType: "오답 원인",
        unit: "단원",
        source: "지문",
        skill: "스킬",
        difficulty: "난도",
        label: "라벨",
    };
    return labels[kind] || "유형";
}

function questionNumberLabel(numbers: number[]): string {
    return numbers.length > 0 ? numbers.map(number => `${number}번`).join(", ") : "문항 없음";
}

function formatDuration(totalSec?: number): string {
    const safeSec = Math.max(0, Math.round(totalSec || 0));
    if (safeSec <= 0) return "기록 없음";
    if (safeSec < 60) return `${safeSec}초`;
    const minutes = Math.floor(safeSec / 60);
    const seconds = safeSec % 60;
    if (minutes < 60) return seconds > 0 ? `${minutes}분 ${seconds}초` : `${minutes}분`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes > 0 ? `${hours}시간 ${restMinutes}분` : `${hours}시간`;
}

function weaknessRetakeHref(weakness: StudentProfileWeaknessInsight | GroupProfileWeaknessInsight): string {
    return buildRetakeHref(weakness.examId, weakness.sourceAttemptId, weakness.retakeQuestionIds, weakness.retakeMode, {
        labels: weakness.retakeLabels,
        concepts: weakness.retakeConcepts,
    });
}

function ProfileMetric({ label, value, icon, color }: { label: string; value: string; icon: React.ReactNode; color: string }) {
    return (
        <div style={{
            padding: '1rem',
            background: `color-mix(in srgb, ${color}, transparent 93%)`,
            border: `1px solid ${color}24`,
            borderRadius: 'var(--radius-md)',
            minWidth: 0,
        }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', color, marginBottom: '0.55rem' }}>
                {icon}
                <span style={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: '0.06em' }}>{label}</span>
            </div>
            <div style={{ fontSize: '1.25rem', fontWeight: 900, color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{value}</div>
        </div>
    );
}

function WeaknessRetakeLink({ weakness, enabled }: { weakness: StudentProfileWeaknessInsight | GroupProfileWeaknessInsight; enabled: boolean }) {
    if (weakness.retakeQuestionIds.length === 0) return null;
    return (
        <PremiumActionLink
            enabled={enabled}
            href={weaknessRetakeHref(weakness)}
            lockedTitle="Pro 이상에서 약점 유형 재시험 링크를 만들 수 있습니다."
            style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0.36rem 0.62rem',
                borderRadius: 'var(--radius-md)',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                fontSize: '0.74rem',
                fontWeight: 850,
                lineHeight: 1,
                whiteSpace: 'nowrap',
            }}
        >
            재추천 {weakness.retakeQuestionIds.length}문항
        </PremiumActionLink>
    );
}

function GroupProfileModal({
    group, profile, onClose, retakeAssignmentsEnabled,
}: {
    group: RosterGroup;
    profile: GroupProfileInsight;
    onClose: () => void;
    retakeAssignmentsEnabled: boolean;
}) {
    return (
        <ModalShell title={`${group.name} 반 분석`} onClose={onClose} maxWidth={940}>
            <div style={{ display: 'grid', gap: '1rem' }}>
                <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    padding: '1rem',
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    flexWrap: 'wrap',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', minWidth: 0 }}>
                        <div style={{
                            width: 48,
                            height: 48,
                            borderRadius: 'var(--radius-md)',
                            background: `color-mix(in srgb, ${group.color}, transparent 86%)`,
                            color: group.color,
                            display: 'grid',
                            placeItems: 'center',
                            flexShrink: 0,
                        }}>
                            <Users size={22} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '1.05rem', fontWeight: 900 }}>{group.name}</div>
                            <div style={{ color: 'var(--muted)', fontSize: '0.83rem' }}>
                                등록 {profile.rosterStudentCount}명 · 응시 {profile.activeStudentCount}명 · 원시험 {profile.attemptCount}건 · 재시험 {profile.retakeAttemptCount}건
                            </div>
                        </div>
                    </div>
                    <span style={{
                        padding: '0.35rem 0.7rem',
                        borderRadius: 'var(--radius-full)',
                        background: `color-mix(in srgb, ${group.color}, transparent 88%)`,
                        color: group.color,
                        fontWeight: 900,
                        fontSize: '0.8rem',
                    }}>
                        평균 {profile.averageScore}점
                    </span>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                    <ProfileMetric label="시험 수" value={`${profile.examCount}개`} color="#4f46e5" icon={<FileText size={15} />} />
                    <ProfileMetric label="원시험" value={`${profile.attemptCount}건`} color="#10b981" icon={<CheckCircle2 size={15} />} />
                    <ProfileMetric label="재시험" value={`${profile.retakeAttemptCount}건`} color="#0f766e" icon={<RefreshCw size={15} />} />
                    <ProfileMetric label="응시 학생" value={`${profile.activeStudentCount}명`} color={group.color} icon={<Users size={15} />} />
                    <ProfileMetric label="오답/미응답" value={`${profile.wrongQuestionCount}/${profile.unansweredQuestionCount}`} color="#ef4444" icon={<AlertTriangle size={15} />} />
                    <ProfileMetric label="평균 시험시간" value={formatDuration(profile.averageElapsedTimeSec)} color="#0ea5e9" icon={<Clock size={15} />} />
                    <ProfileMetric label="필기 보관률" value={`${profile.handwritingArchiveRate}%`} color="#7c3aed" icon={<PenLine size={15} />} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <BarChart3 size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>시험별 현황</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.exams.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    아직 이 반의 응시 데이터가 없습니다.
                                </div>
                            ) : profile.exams.map(exam => (
                                <div key={exam.examId} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{exam.examTitle}</div>
                                            <div style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '0.2rem' }}>
                                                응시 {exam.studentCount}명 · 제출 {exam.attemptCount}건
                                            </div>
                                        </div>
                                        <div style={{ color: scoreColor(exam.averageScore), fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{exam.averageScore}점</div>
                                    </div>
                                    <div style={{ color: 'var(--muted)', fontSize: '0.76rem', marginTop: '0.55rem', lineHeight: 1.6 }}>
                                        오답 {exam.wrongQuestionCount}건 · 미응답 {exam.unansweredQuestionCount}건
                                        {exam.averageElapsedTimeSec > 0 ? ` · 평균 ${formatDuration(exam.averageElapsedTimeSec)}` : ""}
                                        {exam.averageQuestionTimeSec > 0 ? ` · 문항 ${formatDuration(exam.averageQuestionTimeSec)}` : ""}
                                        {exam.topWeakness ? ` · 최우선 ${exam.topWeakness.title}` : ""}
                                    </div>
                                    <div style={{ marginTop: '0.7rem', display: 'flex', justifyContent: 'flex-end' }}>
                                        <NextLink
                                            href={`/teacher/exam/${exam.examId}`}
                                            style={{
                                                padding: '0.35rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.76rem',
                                                fontWeight: 800,
                                            }}
                                        >
                                            시험 분석
                                        </NextLink>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Target size={16} color="var(--error)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>반 취약 유형</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.weaknessGroups.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    누적 오답 유형이 아직 없습니다.
                                </div>
                            ) : profile.weaknessGroups.map(weakness => (
                                <div key={weakness.key} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.4rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
                                                <span style={{
                                                    padding: '0.18rem 0.45rem',
                                                    background: 'rgba(239,68,68,0.1)',
                                                    color: '#ef4444',
                                                    borderRadius: 'var(--radius-full)',
                                                    fontSize: '0.68rem',
                                                    fontWeight: 900,
                                                }}>
                                                    {weaknessKindLabel(weakness.kind)}
                                                </span>
                                                <span style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>{weakness.examTitle}</span>
                                            </div>
                                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{weakness.title}</div>
                                        </div>
                                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                            <div style={{ color: '#ef4444', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{weakness.wrongRate}%</div>
                                            <div style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{weakness.wrongCount}/{weakness.totalCount}</div>
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                                        {weakness.basis} · {questionNumberLabel(weakness.questionNumbers)}
                                        {weakness.unansweredCount > 0 ? ` · 미응답 ${weakness.unansweredCount}건` : ""}
                                    </div>
                                    <div style={{ marginTop: '0.28rem', color: 'var(--muted)', fontSize: '0.72rem', lineHeight: 1.45 }}>
                                        {weakness.reason}
                                    </div>
                                    <div style={{ marginTop: '0.55rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.55rem', flexWrap: 'wrap' }}>
                                        <div style={{ color: 'var(--primary)', fontSize: '0.76rem', fontWeight: 850 }}>
                                            {weakness.recommendedAction}
                                        </div>
                                        <WeaknessRetakeLink weakness={weakness} enabled={retakeAssignmentsEnabled} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                {(profile.mostMissedQuestions.length > 0 || profile.tagStats.length > 0) && (
                    <section>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Clock size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>문항/라벨 트래킹</h4>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>가장 많이 놓친 문항</div>
                                {profile.mostMissedQuestions.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>오답 문항이 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.mostMissedQuestions.slice(0, 4).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.examTitle} · {item.questionNumber}번
                                                </span>
                                                <span style={{ color: 'var(--error)', fontWeight: 900 }}>
                                                    {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>라벨별 통계</div>
                                {profile.tagStats.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>라벨 데이터가 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.tagStats.slice(0, 5).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.title} · {item.questionNumbers.slice(0, 4).join(', ')}번
                                                </span>
                                                <span style={{ color: item.wrongRate >= 60 ? 'var(--error)' : 'var(--muted)', fontWeight: 900 }}>
                                                    오답 {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                )}

                <section>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                        <AlertTriangle size={16} color="var(--warning)" />
                        <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>집중 관리 학생</h4>
                    </div>
                    {profile.studentsNeedingAttention.length === 0 ? (
                        <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                            현재 기준으로 집중 관리 학생이 없습니다.
                        </div>
                    ) : (
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.65rem' }}>
                            {profile.studentsNeedingAttention.map(student => (
                                <div key={student.key} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ fontWeight: 900, marginBottom: '0.3rem' }}>{student.name}</div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', color: 'var(--muted)', fontSize: '0.76rem' }}>
                                        <span>평균 {student.averageScore}점</span>
                                        <span>최근 {student.latestScore}점</span>
                                    </div>
                                    <div style={{
                                        marginTop: '0.45rem',
                                        color: student.trendDelta >= 0 ? 'var(--success)' : 'var(--error)',
                                        fontSize: '0.75rem',
                                        fontWeight: 900,
                                    }}>
                                        추세 {student.trendDelta > 0 ? "+" : ""}{student.trendDelta}점 · {student.attemptCount}회
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </section>
            </div>
        </ModalShell>
    );
}

function StudentProfileModal({
    student, profile, onClose, retakeAssignmentsEnabled,
}: {
    student: RosterStudent;
    profile: StudentProfileInsight;
    onClose: () => void;
    retakeAssignmentsEnabled: boolean;
}) {
    const trendColor = profile.trendDelta >= 0 ? "var(--success)" : "var(--error)";
    const trendLabel = profile.trendDelta === 0
        ? "변화 없음"
        : `${profile.trendDelta > 0 ? "+" : ""}${profile.trendDelta}점`;

    return (
        <ModalShell title={`${student.name} 학생 성장 리포트`} onClose={onClose} maxWidth={900}>
            <div style={{ display: 'grid', gap: '1rem' }}>
                <div style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '1rem',
                    padding: '1rem',
                    background: 'var(--background)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--radius-md)',
                    flexWrap: 'wrap',
                }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem', minWidth: 0 }}>
                        <div style={{
                            width: 48,
                            height: 48,
                            borderRadius: '50%',
                            background: student.avatar,
                            color: 'white',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontWeight: 900,
                            flexShrink: 0,
                        }}>
                            {student.name.slice(1, 2)}
                        </div>
                        <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: '1rem', fontWeight: 800 }}>{student.name}</div>
                            <div style={{ color: 'var(--muted)', fontSize: '0.83rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{student.email}</div>
                        </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        <span className="badge badge-primary">{student.group}</span>
                        <span style={{
                            padding: '0.35rem 0.65rem',
                            borderRadius: 'var(--radius-full)',
                            background: `color-mix(in srgb, ${trendColor}, transparent 88%)`,
                            color: trendColor,
                            fontSize: '0.78rem',
                            fontWeight: 800,
                        }}>
                            최근 추세 {trendLabel}
                        </span>
                    </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem' }}>
                    <ProfileMetric label="원시험 평균" value={`${profile.averageScore}점`} color="#4f46e5" icon={<BarChart3 size={15} />} />
                    <ProfileMetric label="최근 원시험" value={`${profile.latestScore}점`} color={scoreColor(profile.latestScore)} icon={<TrendingUp size={15} />} />
                    <ProfileMetric label="재시험" value={`${profile.retakeAttemptCount}회`} color="#0f766e" icon={<RefreshCw size={15} />} />
                    <ProfileMetric label="오답/미응답" value={`${profile.wrongQuestionCount}/${profile.unansweredQuestionCount}`} color="#ef4444" icon={<AlertTriangle size={15} />} />
                    <ProfileMetric label="필기 보관" value={`${profile.handwritingArchiveCount}건`} color="#7c3aed" icon={<PenLine size={15} />} />
                    <ProfileMetric label="평균 시험시간" value={formatDuration(profile.averageElapsedTimeSec)} color="#0ea5e9" icon={<Clock size={15} />} />
                    <ProfileMetric label="문항 평균시간" value={formatDuration(profile.averageQuestionTimeSec)} color="#f59e0b" icon={<Clock size={15} />} />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1rem' }}>
                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <FileText size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>최근 응시</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.attempts.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    아직 응시 이력이 없습니다.
                                </div>
                            ) : profile.attempts.map(attempt => (
                                <div key={attempt.id} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', alignItems: 'flex-start' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ fontSize: '0.9rem', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{attempt.examTitle}</div>
                                            <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center', flexWrap: 'wrap', marginTop: '0.15rem' }}>
                                                <span style={{ fontSize: '0.76rem', color: 'var(--muted)' }}>{formatAttemptDate(attempt.finishedAt)}</span>
                                                {attempt.isRetake && (
                                                    <span style={{ color: '#0f766e', background: '#f0fdfa', border: '1px solid #99f6e4', borderRadius: '999px', padding: '0.08rem 0.38rem', fontSize: '0.68rem', fontWeight: 900 }}>
                                                        재시험 {attempt.retakeQuestionCount}문항
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div style={{ color: scoreColor(attempt.scorePercent), fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{attempt.scorePercent}점</div>
                                    </div>
                                    <div style={{ display: 'grid', gap: '0.35rem', marginTop: '0.65rem', color: 'var(--muted)', fontSize: '0.78rem' }}>
                                        <div>오답 {questionNumberLabel(attempt.wrongQuestionNumbers)}</div>
                                        <div>미응답 {questionNumberLabel(attempt.unansweredQuestionNumbers)}</div>
                                        <div>
                                            응시 {formatDuration(attempt.elapsedTimeSec)}
                                            {attempt.averageQuestionTimeSec > 0 ? ` · 문항 평균 ${formatDuration(attempt.averageQuestionTimeSec)}` : ""}
                                        </div>
                                        {(attempt.slowQuestionNumbers.length > 0 || attempt.revisitedQuestionNumbers.length > 0 || attempt.focusLossCount > 0) && (
                                            <div style={{ color: 'var(--primary)', fontWeight: 800 }}>
                                                {attempt.slowQuestionNumbers.length > 0 ? `오래 머문 ${questionNumberLabel(attempt.slowQuestionNumbers)}` : ""}
                                                {attempt.revisitedQuestionNumbers.length > 0 ? `${attempt.slowQuestionNumbers.length > 0 ? " · " : ""}재방문 ${questionNumberLabel(attempt.revisitedQuestionNumbers)}` : ""}
                                                {attempt.focusLossCount > 0 ? `${attempt.slowQuestionNumbers.length > 0 || attempt.revisitedQuestionNumbers.length > 0 ? " · " : ""}이탈 ${attempt.focusLossCount}회` : ""}
                                            </div>
                                        )}
                                        {attempt.handwritingArchived && (
                                            <div style={{ color: '#7c3aed', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
                                                <PenLine size={12} /> 필기 {attempt.handwritingLabel}
                                            </div>
                                        )}
                                    </div>
                                    <div style={{ marginTop: '0.7rem', display: 'flex', justifyContent: 'flex-end' }}>
                                        <NextLink
                                            href={attempt.detailHref}
                                            style={{
                                                padding: '0.35rem 0.65rem',
                                                borderRadius: 'var(--radius-md)',
                                                background: 'var(--surface)',
                                                border: '1px solid var(--border)',
                                                color: 'var(--foreground)',
                                                fontSize: '0.76rem',
                                                fontWeight: 800,
                                            }}
                                        >
                                            리포트 열기
                                        </NextLink>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>

                    <section style={{ minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Target size={16} color="var(--error)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>취약 유형</h4>
                        </div>
                        <div style={{ display: 'grid', gap: '0.55rem', maxHeight: 360, overflowY: 'auto', paddingRight: '0.25rem' }}>
                            {profile.weaknessGroups.length === 0 ? (
                                <div style={{ padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', color: 'var(--muted)', fontSize: '0.86rem' }}>
                                    누적 오답 유형이 아직 없습니다.
                                </div>
                            ) : profile.weaknessGroups.map(group => (
                                <div key={group.key} style={{ padding: '0.85rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.4rem' }}>
                                        <div style={{ minWidth: 0 }}>
                                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.2rem', flexWrap: 'wrap' }}>
                                                <span style={{
                                                    padding: '0.18rem 0.45rem',
                                                    background: 'rgba(239,68,68,0.1)',
                                                    color: '#ef4444',
                                                    borderRadius: 'var(--radius-full)',
                                                    fontSize: '0.68rem',
                                                    fontWeight: 900,
                                                }}>
                                                    {weaknessKindLabel(group.kind)}
                                                </span>
                                                <span style={{ color: 'var(--muted)', fontSize: '0.72rem' }}>{group.examTitle}</span>
                                            </div>
                                            <div style={{ fontWeight: 900, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.title}</div>
                                        </div>
                                        <div style={{ textAlign: 'right', flexShrink: 0 }}>
                                            <div style={{ color: '#ef4444', fontWeight: 900, fontVariantNumeric: 'tabular-nums' }}>{group.wrongRate}%</div>
                                            <div style={{ color: 'var(--muted)', fontSize: '0.7rem' }}>{group.wrongCount}/{group.totalCount}</div>
                                        </div>
                                    </div>
                                    <div style={{ fontSize: '0.76rem', color: 'var(--muted)', lineHeight: 1.6 }}>
                                        {group.basis} · {questionNumberLabel(group.questionNumbers)}
                                        {group.unansweredCount > 0 ? ` · 미응답 ${group.unansweredCount}건` : ""}
                                    </div>
                                    <div style={{ marginTop: '0.28rem', color: 'var(--muted)', fontSize: '0.72rem', lineHeight: 1.45 }}>
                                        {group.reason}
                                    </div>
                                    <div style={{ marginTop: '0.55rem', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.55rem', flexWrap: 'wrap' }}>
                                        <div style={{ color: 'var(--primary)', fontSize: '0.76rem', fontWeight: 850 }}>
                                            {group.recommendedAction}
                                        </div>
                                        <WeaknessRetakeLink weakness={group} enabled={retakeAssignmentsEnabled} />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>

                {(profile.mostMissedQuestions.length > 0 || profile.tagStats.length > 0) && (
                    <section>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', marginBottom: '0.65rem' }}>
                            <Clock size={16} color="var(--primary)" />
                            <h4 style={{ fontSize: '0.92rem', fontWeight: 800 }}>개인 문항/라벨 트래킹</h4>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>가장 많이 틀린 문항</div>
                                {profile.mostMissedQuestions.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>오답 문항이 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.mostMissedQuestions.slice(0, 4).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.examTitle} · {item.questionNumber}번
                                                </span>
                                                <span style={{ color: 'var(--error)', fontWeight: 900 }}>
                                                    {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                            <div style={{ padding: '0.9rem', background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)' }}>
                                <div style={{ fontWeight: 900, marginBottom: '0.6rem', color: 'var(--foreground)' }}>라벨별 누적 통계</div>
                                {profile.tagStats.length === 0 ? (
                                    <div style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>라벨 데이터가 아직 없습니다.</div>
                                ) : (
                                    <div style={{ display: 'grid', gap: '0.45rem' }}>
                                        {profile.tagStats.slice(0, 5).map(item => (
                                            <div key={item.key} style={{ display: 'flex', justifyContent: 'space-between', gap: '0.7rem', fontSize: '0.8rem' }}>
                                                <span style={{ color: 'var(--foreground)', fontWeight: 850 }}>
                                                    {item.title} · {item.questionNumbers.slice(0, 4).join(', ')}번
                                                </span>
                                                <span style={{ color: item.wrongRate >= 60 ? 'var(--error)' : 'var(--muted)', fontWeight: 900 }}>
                                                    오답 {item.wrongRate}%{item.averageTimeSec ? ` · ${formatDuration(item.averageTimeSec)}` : ""}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    </section>
                )}
            </div>
        </ModalShell>
    );
}

function ModalShell({
    title, onClose, children, maxWidth = 420,
}: {
    title: string;
    onClose: () => void;
    children: React.ReactNode;
    maxWidth?: number | string;
}) {
    return (
        <div
            onClick={onClose}
            style={{
                position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.45)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                zIndex: 100, padding: '1rem', animation: 'fadeIn 0.15s both'
            }}
        >
            <div
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-label={title}
                className="bento-card"
                style={{
                    width: '100%', maxWidth, padding: '1.5rem',
                    maxHeight: 'calc(100vh - 2rem)',
                    overflowY: 'auto',
                    background: 'var(--modal-surface)', borderRadius: 'var(--radius-lg)',
                    boxShadow: '0 24px 64px rgba(15,23,42,0.28), 0 0 0 1px color-mix(in srgb, var(--border), transparent 18%)',
                    backdropFilter: 'none',
                    WebkitBackdropFilter: 'none',
                }}
            >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
                    <h3 style={{ fontSize: '1.1rem', fontWeight: 700 }}>{title}</h3>
                    <button
                        type="button"
                        aria-label="모달 닫기"
                        onClick={onClose}
                        style={{
                            width: 44,
                            height: 44,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            color: 'var(--muted)',
                            borderRadius: 'var(--radius-md)',
                        }}
                    >
                        <X size={18} />
                    </button>
                </div>
                {children}
            </div>
        </div>
    );
}

function StudentModal({
    groups, initial, defaultGroupId, onClose, onSubmit,
}: {
    groups: RosterGroup[];
    initial: RosterStudent | null;
    defaultGroupId?: string;
    onClose: () => void;
    onSubmit: (data: StudentFormData) => void;
}) {
    const initialGroupIdValue = initial ? initialStudentGroupId(initial, groups) : (groups.some(group => group.id === defaultGroupId) ? defaultGroupId || "" : groups[0]?.id ?? "");
    const initialGroup = groups.find(item => item.id === initialGroupIdValue);
    const [name, setName] = useState(initial?.name ?? "");
    const [email, setEmail] = useState(initial?.email ?? "");
    const [groupId, setGroupId] = useState(initialGroupIdValue);
    const [region, setRegion] = useState(initial?.region ?? initialGroup?.region ?? "");
    const selectedGroup = groups.find(item => item.id === groupId);

    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.65rem 0.85rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.9rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    return (
        <ModalShell title={initial ? "학생 편집" : "학생 추가"} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim() || !email.trim() || !selectedGroup) return;
                    onSubmit({
                        name: name.trim(),
                        email: email.trim(),
                        group: selectedGroup.name,
                        groupId: selectedGroup.id,
                        region: region.trim() || selectedGroup.region || "",
                    });
                }}
            >
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이름</label>
                    <input aria-label="학생 이름" value={name} onChange={e => setName(e.target.value)} style={inputStyle} required />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이메일</label>
                    <input aria-label="학생 이메일" type="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} required />
                </div>
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>반</label>
                    <select
                        aria-label="소속 반"
                        value={groupId}
                        onChange={e => {
                            const nextGroup = groups.find(item => item.id === e.target.value);
                            setGroupId(e.target.value);
                            if (nextGroup?.region && !region.trim()) {
                                setRegion(nextGroup.region);
                            }
                        }}
                        style={inputStyle}
                        required
                    >
                        {groups.length === 0 && <option value="">반을 먼저 만들어주세요</option>}
                        {groups.map(g => <option key={g.id} value={g.id}>{groupOptionLabel(g)}</option>)}
                    </select>
                </div>
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>지역</label>
                    <input
                        aria-label="학생 지역"
                        value={region}
                        onChange={e => setRegion(e.target.value)}
                        style={inputStyle}
                        placeholder="예: 서울, 부산, 온라인"
                    />
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'linear-gradient(135deg, #22c55e, #10b981)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        {initial ? "저장" : "추가"}
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

function GroupModal({
    initial, onClose, onSubmit,
}: {
    initial?: RosterGroup | null;
    onClose: () => void;
    onSubmit: (data: GroupFormData) => void;
}) {
    const [name, setName] = useState(initial?.name ?? "");
    const [region, setRegion] = useState(initial?.region ?? "");
    const [color, setColor] = useState(initial?.color ?? GROUP_COLORS[0]);

    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.65rem 0.85rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.9rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    return (
        <ModalShell title={initial ? "반 편집" : "새 반 만들기"} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!name.trim()) return;
                    onSubmit({ name: name.trim(), region: region.trim(), color });
                }}
            >
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이름</label>
                    <input
                        aria-label="반 이름"
                        value={name}
                        onChange={e => setName(e.target.value)}
                        style={inputStyle}
                        autoFocus
                        required
                    />
                </div>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>지역</label>
                    <input
                        aria-label="반 지역"
                        value={region}
                        onChange={e => setRegion(e.target.value)}
                        style={inputStyle}
                        placeholder="예: 서울, 부산, 온라인"
                    />
                </div>
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>색상</label>
                    <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {GROUP_COLORS.map(c => (
                            <button
                                key={c}
                                type="button"
                                onClick={() => setColor(c)}
                                aria-label={`색상 ${c}`}
                                style={{
                                    width: 44, height: 44, borderRadius: '50%', background: c,
                                    border: color === c ? '3px solid var(--foreground)' : '3px solid transparent',
                                    cursor: 'pointer', transition: 'transform 0.15s',
                                    transform: color === c ? 'scale(1.1)' : 'scale(1)',
                                }}
                            />
                        ))}
                    </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        {initial ? "저장" : "만들기"}
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

// DEV-A: bulk group reassignment picker.
function GroupMoveModal({
    groups, count, selectedRegions, onClose, onConfirm,
}: {
    groups: RosterGroup[];
    count: number;
    /** Effective region of each selected student, for the override-impact note. */
    selectedRegions: string[];
    onClose: () => void;
    onConfirm: (groupId: string, applyRegion: boolean) => void;
}) {
    const [groupId, setGroupId] = useState(groups[0]?.id ?? "");
    // T4: default ON keeps the previous behavior (region follows the class),
    // but the teacher can turn it off to preserve each student's region override.
    const [applyRegion, setApplyRegion] = useState(true);
    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.65rem 0.85rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.9rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    const targetGroup = groups.find(g => g.id === groupId);
    const targetRegion = targetGroup?.region?.trim() || DEFAULT_REGION_NAME;
    const differingCount = selectedRegions.filter(region => region !== targetRegion).length;

    return (
        <ModalShell title="선택 학생 반 이동" onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    if (!groupId) return;
                    onConfirm(groupId, applyRegion);
                }}
            >
                <p style={{ color: 'var(--muted)', fontSize: '0.88rem', lineHeight: 1.6, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                    선택된 <strong style={{ color: 'var(--foreground)' }}>{count}명</strong>을 옮길 반을 선택하세요.
                    {applyRegion ? " 반과 지역이 함께 이동됩니다." : " 반만 이동하고 각 학생의 지역은 유지됩니다."}
                </p>
                <div style={{ marginBottom: '1rem' }}>
                    <label style={labelStyle}>이동할 반</label>
                    <select
                        aria-label="이동할 반"
                        value={groupId}
                        onChange={e => setGroupId(e.target.value)}
                        style={inputStyle}
                        required
                    >
                        {groups.length === 0 && <option value="">이동 가능한 반이 없습니다</option>}
                        {groups.map(g => <option key={g.id} value={g.id}>{groupOptionLabel(g)}</option>)}
                    </select>
                </div>

                <label
                    style={{
                        display: 'flex', alignItems: 'flex-start', gap: '0.6rem',
                        padding: '0.6rem 0.7rem', marginBottom: '0.75rem',
                        borderRadius: 'var(--radius-md)', border: '1px solid var(--border)',
                        background: 'var(--background)', cursor: 'pointer', minHeight: 44,
                    }}
                >
                    <input
                        type="checkbox"
                        aria-label="지역도 이동한 반 기준으로 변경"
                        checked={applyRegion}
                        onChange={e => setApplyRegion(e.target.checked)}
                        style={{ marginTop: 3, accentColor: 'var(--primary)', cursor: 'pointer', flexShrink: 0 }}
                    />
                    <span style={{ fontSize: '0.85rem', color: 'var(--foreground)', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                        <span style={{ fontWeight: 700 }}>지역도 이동한 반 기준으로 변경</span>
                        <span style={{ display: 'block', fontSize: '0.78rem', color: 'var(--muted)', marginTop: '0.15rem' }}>
                            체크 해제 시 각 학생의 기존 지역을 그대로 유지합니다.
                        </span>
                    </span>
                </label>

                {differingCount > 0 && (
                    <p style={{
                        fontSize: '0.8rem', lineHeight: 1.55, wordBreak: 'keep-all',
                        color: applyRegion ? 'var(--warning)' : 'var(--muted)',
                        background: applyRegion ? 'rgba(245,158,11,0.09)' : 'var(--background)',
                        border: `1px solid ${applyRegion ? 'rgba(245,158,11,0.28)' : 'var(--border)'}`,
                        borderRadius: 'var(--radius-md)', padding: '0.6rem 0.7rem', marginBottom: '1.25rem',
                    }}>
                        선택한 학생 중 <strong>{differingCount}명</strong>의 현재 지역이 이동할 반의 지역(<strong>{targetRegion}</strong>)과 다릅니다.
                        {applyRegion
                            ? " 확정하면 해당 학생의 지역이 덮어써집니다."
                            : " 체크가 해제되어 이 학생들의 지역은 변경되지 않습니다."}
                    </p>
                )}
                {differingCount === 0 && <div style={{ marginBottom: '1.25rem' }} />}

                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        취소
                    </button>
                    <button
                        type="submit"
                        disabled={!groupId}
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem', opacity: groupId ? 1 : 0.6 }}
                    >
                        이동
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

// T1/T5: dry-run preview of a CSV import. Shows counts + a per-row disposition
// (add / update with field diffs / id-collision conflict / skip with reason)
// and only commits when the teacher presses 가져오기 확정.
const CSV_PREVIEW_ROW_CAP = 100;

const CSV_FIELD_LABEL: Record<RosterCsvFieldChange["field"], string> = {
    name: "이름",
    email: "이메일",
    group: "반",
    region: "지역",
};

function CsvDispositionBadge({ color, bg, label }: { color: string; bg: string; label: string }) {
    return (
        <span style={{
            display: 'inline-block', flexShrink: 0, padding: '0.1rem 0.5rem',
            borderRadius: 'var(--radius-full)', fontSize: '0.72rem', fontWeight: 800,
            color, background: bg, whiteSpace: 'nowrap',
        }}>
            {label}
        </span>
    );
}

function CsvPreviewSection({
    title, count, color, bg, children,
}: {
    title: string;
    count: number;
    color: string;
    bg: string;
    children: React.ReactNode;
}) {
    if (count === 0) return null;
    return (
        <div style={{ marginBottom: '1rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <CsvDispositionBadge color={color} bg={bg} label={title} />
                <span style={{ fontSize: '0.82rem', fontWeight: 800, color: 'var(--foreground)' }}>{count}건</span>
            </div>
            <div style={{
                display: 'flex', flexDirection: 'column', gap: '0.35rem',
                maxHeight: 200, overflowY: 'auto',
                border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                padding: '0.5rem 0.6rem', background: 'var(--background)',
            }}>
                {children}
            </div>
        </div>
    );
}

const CSV_CONFLICT_DISPOSITION_LABEL: Record<RosterCsvConflictDisposition, string> = {
    add: "신규 추가",
    overwrite: "기존 덮어쓰기",
    skip: "건너뛰기",
};

function csvConflictDispositionNote(disposition: RosterCsvConflictDisposition, row: { existingName: string; existingEmail: string }): string {
    if (disposition === "overwrite") return `기존 학생(${row.existingName} · ${row.existingEmail}) 정보를 이 행으로 덮어씁니다.`;
    if (disposition === "skip") return "이 행은 가져오지 않습니다.";
    return "새 id로 별도 학생을 추가합니다. 기존 학생은 그대로 둡니다.";
}

function CsvImportPreviewModal({
    plan, onClose, onConfirm,
}: {
    plan: RosterCsvImportPlan;
    onClose: () => void;
    onConfirm: (dispositions: Record<number, RosterCsvConflictDisposition>) => void;
}) {
    // Per-conflict-row choice, keyed by CSV line. Missing entry = "add" (the
    // historical "add as new" behavior stays the default).
    const [conflictDispositions, setConflictDispositions] = useState<Record<number, RosterCsvConflictDisposition>>({});
    const dispositionFor = (line: number): RosterCsvConflictDisposition => conflictDispositions[line] ?? "add";
    const conflictAddCount = plan.conflicts.filter(row => dispositionFor(row.line) === "add").length;
    const conflictOverwriteCount = plan.conflicts.filter(row => dispositionFor(row.line) === "overwrite").length;
    const conflictSkipCount = plan.conflicts.filter(row => dispositionFor(row.line) === "skip").length;
    const addedTotal = plan.adds.length + conflictAddCount;
    const changedUpdates = plan.updates.filter(update => update.changes.length > 0);
    const unchangedCount = plan.updates.length - changedUpdates.length;
    // Mirrors applyRosterCsvConflictDispositions: skipping every conflict can turn a
    // "has changes" plan into a no-op, so the confirm button tracks the live choices.
    const effectiveHasChanges = plan.adds.length > 0
        || changedUpdates.length > 0
        || conflictAddCount + conflictOverwriteCount > 0;
    const rowStyle: React.CSSProperties = {
        fontSize: '0.8rem', color: 'var(--foreground)', lineHeight: 1.5,
        display: 'flex', alignItems: 'flex-start', gap: '0.5rem', wordBreak: 'keep-all',
    };
    const lineStyle: React.CSSProperties = {
        flexShrink: 0, color: 'var(--muted)', fontVariantNumeric: 'tabular-nums', fontWeight: 700, minWidth: 34,
    };
    const moreNote = (shown: number, total: number) => (
        total > shown
            ? <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600, paddingTop: '0.15rem' }}>…외 {total - shown}건 더</div>
            : null
    );

    return (
        <ModalShell title="CSV 가져오기 미리보기" onClose={onClose} maxWidth={640}>
            <p style={{ color: 'var(--muted)', fontSize: '0.86rem', lineHeight: 1.6, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                아래 내용은 아직 저장되지 않았습니다. 확인 후 <strong style={{ color: 'var(--foreground)' }}>가져오기 확정</strong>을 누르면 반영됩니다.
            </p>

            <div style={{
                display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1.25rem',
            }}>
                <CsvDispositionBadge color="var(--success)" bg="rgba(16,185,129,0.1)" label={`추가 ${addedTotal}`} />
                <CsvDispositionBadge color="var(--primary)" bg="rgba(99,102,241,0.1)" label={`업데이트 ${changedUpdates.length + conflictOverwriteCount}`} />
                {unchangedCount > 0 && (
                    <CsvDispositionBadge color="var(--muted)" bg="var(--background)" label={`변경 없음 ${unchangedCount}`} />
                )}
                {plan.conflicts.length > 0 && (
                    <CsvDispositionBadge color="var(--warning)" bg="rgba(245,158,11,0.12)" label={`id 충돌 ${plan.conflicts.length}`} />
                )}
                {conflictSkipCount > 0 && (
                    <CsvDispositionBadge color="var(--muted)" bg="var(--background)" label={`충돌 건너뜀 ${conflictSkipCount}`} />
                )}
                {plan.createdGroups.length > 0 && (
                    <CsvDispositionBadge color="var(--foreground)" bg="var(--background)" label={`새 반 ${plan.createdGroups.length}`} />
                )}
                {plan.skips.length > 0 && (
                    <CsvDispositionBadge color="var(--error)" bg="rgba(239,68,68,0.1)" label={`제외 ${plan.skips.length}`} />
                )}
            </div>

            <CsvPreviewSection title="추가" count={plan.adds.length} color="var(--success)" bg="rgba(16,185,129,0.1)">
                {plan.adds.slice(0, CSV_PREVIEW_ROW_CAP).map(row => (
                    <div key={`add-${row.line}`} style={rowStyle}>
                        <span style={lineStyle}>#{row.line}</span>
                        <span><strong>{row.name}</strong> · {row.email} · {row.group}{row.region ? ` · ${row.region}` : ""}</span>
                    </div>
                ))}
                {moreNote(CSV_PREVIEW_ROW_CAP, plan.adds.length)}
            </CsvPreviewSection>

            <CsvPreviewSection title="업데이트" count={changedUpdates.length} color="var(--primary)" bg="rgba(99,102,241,0.1)">
                {changedUpdates.slice(0, CSV_PREVIEW_ROW_CAP).map(row => (
                    <div key={`upd-${row.line}`} style={rowStyle}>
                        <span style={lineStyle}>#{row.line}</span>
                        <span>
                            <strong>{row.name}</strong> · {row.email}
                            <span style={{ color: 'var(--muted)' }}> ({row.matchedBy === "email" ? "이메일 일치" : "id 일치"})</span>
                            <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.75rem' }}>
                                {row.changes.map(change => (
                                    <span key={change.field} style={{ display: 'block' }}>
                                        {CSV_FIELD_LABEL[change.field]}: {change.from || "—"} → <strong style={{ color: 'var(--foreground)' }}>{change.to || "—"}</strong>
                                    </span>
                                ))}
                            </span>
                        </span>
                    </div>
                ))}
                {moreNote(CSV_PREVIEW_ROW_CAP, changedUpdates.length)}
            </CsvPreviewSection>

            <CsvPreviewSection title="id 충돌" count={plan.conflicts.length} color="var(--warning)" bg="rgba(245,158,11,0.12)">
                {plan.conflicts.slice(0, CSV_PREVIEW_ROW_CAP).map(row => {
                    const disposition = dispositionFor(row.line);
                    return (
                        <div key={`cft-${row.line}`} style={{ ...rowStyle, flexWrap: 'wrap', rowGap: '0.35rem' }}>
                            <span style={lineStyle}>#{row.line}</span>
                            <span style={{ flex: '1 1 200px', minWidth: 0 }}>
                                <strong>{row.name}</strong> · {row.email} · {row.group}
                                <span style={{ display: 'block', color: 'var(--muted)', fontSize: '0.75rem' }}>
                                    id <code>{row.importedId}</code>가 기존 학생({row.existingName} · {row.existingEmail})과 겹칩니다.
                                </span>
                                <span style={{ display: 'block', color: disposition === "skip" ? 'var(--muted)' : 'var(--warning)', fontSize: '0.75rem', fontWeight: 700 }}>
                                    {csvConflictDispositionNote(disposition, row)}
                                </span>
                            </span>
                            <select
                                aria-label={`${row.line}행 id 충돌 처리 방법`}
                                value={disposition}
                                onChange={e => setConflictDispositions(prev => ({
                                    ...prev,
                                    [row.line]: e.target.value as RosterCsvConflictDisposition,
                                }))}
                                style={{
                                    flexShrink: 0,
                                    minHeight: 44,
                                    padding: '0.45rem 0.6rem',
                                    background: 'var(--background)',
                                    border: '1px solid var(--border)',
                                    borderRadius: 'var(--radius-md)',
                                    color: 'var(--foreground)',
                                    fontSize: '0.78rem',
                                    fontWeight: 700,
                                }}
                            >
                                {(Object.keys(CSV_CONFLICT_DISPOSITION_LABEL) as RosterCsvConflictDisposition[]).map(option => (
                                    <option key={option} value={option}>{CSV_CONFLICT_DISPOSITION_LABEL[option]}</option>
                                ))}
                            </select>
                        </div>
                    );
                })}
                {moreNote(CSV_PREVIEW_ROW_CAP, plan.conflicts.length)}
                {plan.conflicts.length > CSV_PREVIEW_ROW_CAP && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)', fontWeight: 600 }}>
                        표시되지 않은 충돌 행은 기본값(신규 추가)으로 처리됩니다.
                    </div>
                )}
            </CsvPreviewSection>

            <CsvPreviewSection title="제외" count={plan.skips.length} color="var(--error)" bg="rgba(239,68,68,0.1)">
                {plan.skips.slice(0, CSV_PREVIEW_ROW_CAP).map(row => (
                    <div key={`skp-${row.line}`} style={rowStyle}>
                        <span style={lineStyle}>#{row.line}</span>
                        <span>
                            {row.name || row.email || row.group
                                ? <>{row.name || "(이름 없음)"} · {row.email || "(이메일 없음)"} · {row.group || "(반 없음)"}</>
                                : <span style={{ color: 'var(--muted)' }}>빈 행</span>}
                            <span style={{ display: 'block', color: 'var(--error)', fontSize: '0.75rem' }}>
                                {row.reason === "missing-fields" ? "필수 항목 누락 (이름/이메일/반)" : "이메일 형식 오류"}
                            </span>
                        </span>
                    </div>
                ))}
                {moreNote(CSV_PREVIEW_ROW_CAP, plan.skips.length)}
            </CsvPreviewSection>

            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1.25rem' }}>
                <button
                    type="button"
                    onClick={onClose}
                    style={{ minHeight: 44, padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                >
                    취소
                </button>
                <button
                    type="button"
                    onClick={() => onConfirm(conflictDispositions)}
                    disabled={!effectiveHasChanges}
                    title={effectiveHasChanges ? undefined : "반영할 변경 사항이 없습니다."}
                    style={{
                        minHeight: 44, padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white',
                        borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem',
                        opacity: effectiveHasChanges ? 1 : 0.5, cursor: effectiveHasChanges ? 'pointer' : 'not-allowed',
                    }}
                >
                    가져오기 확정
                </button>
            </div>
        </ModalShell>
    );
}


function InviteModal({
    onClose, onSubmit,
}: {
    onClose: () => void;
    onSubmit: (email: string) => void;
}) {
    const [contact, setContact] = useState("");
    const inputStyle: React.CSSProperties = {
        width: '100%', padding: '0.75rem 0.9rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.95rem', color: 'var(--foreground)', outline: 'none',
    };
    const labelStyle: React.CSSProperties = {
        display: 'block', fontSize: '0.75rem', fontWeight: 700,
        color: 'var(--muted)', letterSpacing: '0.05em',
        textTransform: 'uppercase', marginBottom: '0.4rem',
    };

    return (
        <ModalShell title="카카오 초대 기록" onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    onSubmit(contact);
                }}
            >
                <div style={{ marginBottom: '1.25rem' }}>
                    <label style={labelStyle}>초대 연락처</label>
                    <input
                        type="email"
                        value={contact}
                        onChange={e => setContact(e.target.value)}
                        style={inputStyle}
                        placeholder="student@example.com"
                        autoFocus
                        required
                    />
                    <p style={{ marginTop: '0.45rem', color: 'var(--muted)', fontSize: '0.78rem', lineHeight: 1.55, wordBreak: 'keep-all' }}>
                        현재는 초대 기록만 저장합니다. 실제 카카오 발송은 채널 연동 후 지원합니다.
                    </p>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        기록 추가
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

function MessageModal({
    recipient, onClose, onSubmit,
}: {
    recipient: string;
    onClose: () => void;
    onSubmit: (body: string) => void;
}) {
    const [body, setBody] = useState("");
    const textareaStyle: React.CSSProperties = {
        width: '100%', minHeight: 120, resize: 'vertical',
        padding: '0.75rem 0.9rem', background: 'var(--background)',
        border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        fontSize: '0.95rem', color: 'var(--foreground)', outline: 'none',
        lineHeight: 1.6,
    };

    return (
        <ModalShell title={`${recipient} 메시지`} onClose={onClose}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    const trimmed = body.trim();
                    if (!trimmed) return;
                    onSubmit(trimmed);
                }}
            >
                <textarea
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    style={textareaStyle}
                    placeholder="전달할 내용을 입력하세요"
                    autoFocus
                    required
                />
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '1rem' }}>
                    <button
                        type="button"
                        onClick={onClose}
                        style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                    >
                        닫기
                    </button>
                    <button
                        type="submit"
                        style={{ padding: '0.65rem 1.1rem', background: 'var(--primary)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                    >
                        보내기
                    </button>
                </div>
            </form>
        </ModalShell>
    );
}

function ConfirmModal({
    action, onClose, onConfirm,
}: {
    action: ConfirmAction;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const copy = action.kind === "student"
        ? {
            title: "학생 삭제",
            body: `${action.label} 학생을 삭제합니다. 목록과 반 통계에서 바로 제외됩니다.`,
            confirm: "삭제",
        }
        : action.kind === "bulk"
            ? {
                title: "선택 학생 삭제",
                body: `선택된 ${action.count}명을 삭제합니다. 목록과 반 통계에서 바로 제외됩니다.`,
                confirm: "삭제",
            }
            : action.kind === "invite"
                ? {
                    title: "초대 취소",
                    body: `${action.label} 초대를 취소합니다. 취소된 초대는 목록에서 제거됩니다.`,
                    confirm: "초대 취소",
                }
            : {
                title: "반 삭제",
                body: `${action.label} 반을 삭제합니다. 학생이 남아 있으면 삭제되지 않습니다.`,
                confirm: "반 삭제",
            };

    return (
        <ModalShell title={copy.title} onClose={onClose}>
            <p style={{ color: 'var(--muted)', fontSize: '0.95rem', lineHeight: 1.7, marginBottom: '1.25rem', wordBreak: 'keep-all' }}>
                {copy.body}
            </p>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                <button
                    onClick={onClose}
                    style={{ padding: '0.65rem 1rem', background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', fontWeight: 600, fontSize: '0.85rem', color: 'var(--foreground)' }}
                >
                    닫기
                </button>
                <button
                    onClick={onConfirm}
                    style={{ padding: '0.65rem 1.1rem', background: 'var(--error)', color: 'white', borderRadius: 'var(--radius-md)', fontWeight: 700, fontSize: '0.85rem' }}
                >
                    {copy.confirm}
                </button>
            </div>
        </ModalShell>
    );
}
