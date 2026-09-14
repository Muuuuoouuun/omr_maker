"use client";

import { useMemo, useState, useEffect, useId, useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Check, Copy, Lock, Plus, Radio, Share2, Sparkles, UserPlus } from 'lucide-react';
import type { Exam } from '@/types/omr';
import { formatRegionScopedLabel } from '@/lib/dashboardSelection';
import type { ExamValidationSummary } from '@/lib/examValidation';
import { isValidExamPin, normalizeExamPin } from '@/lib/examAccess';
import type { RosterGroup, RosterInvite, RosterStudent } from '@/lib/rosterStorage';
import { countDistributionGroupMembers, summarizeDistributionTargets } from '@/lib/distributionTargets';
import { isShareUrlReachableByStudents } from '@/lib/shareLink';
import { addRosterGroup, addRosterStudent } from '@/lib/rosterMutations';
import { loadTeacherRosterSnapshot, saveTeacherRosterSnapshotIfCurrent } from '@/lib/teacherRosterClient';
import {
    beginTeacherRosterIdentityOperation,
    canContinueTeacherRosterIdentityOperation,
    persistTeacherRosterCompletionIfCurrent,
    readTeacherRosterDegradedCache,
    sanitizeTeacherRosterCandidate,
    sameTeacherRosterLoadIdentity,
    toTeacherRosterDegradedDisplayData,
    type TeacherRosterLoadIdentity,
    type TeacherRosterIdentityOperation,
} from '@/lib/teacherRosterCanonicalCache';
import {
    TEACHER_SESSION_IDENTITY_CHANGED_EVENT,
    TEACHER_SESSION_KEY,
    readTeacherSession,
} from '@/lib/teacherSession';
import { toast } from '@/components/Toast';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import {
    confirmExistingGroupInviteRotation,
    isGroupInviteShareUrl,
    normalizeDistributionShareResult,
    resolveInviteRotationExamId,
    type DistributionShareResultLike,
} from '@/lib/distributionInviteRotation';
import type {
    ClearTeacherIndividualAssignmentInput,
    ClearTeacherIndividualAssignmentResult,
    LoadTeacherIndividualAssignmentResult,
    SaveTeacherIndividualAssignmentInput,
    SaveTeacherIndividualAssignmentResult,
} from '@/lib/individualAssignmentGateway';
import { reloadLatestAssignmentAfterConflict } from '@/lib/studentAssignmentClassification';
import {
    resolveInviteCapability,
    type ExamEntryInviteCapability,
    type ExamEntryInviteMetadata,
    type ExamEntryInviteRawUrlState,
} from '@/lib/examEntryInviteLifecycle';
import type {
    TeacherExamEntryInviteMetadataResult,
    TeacherExamEntryInviteRevokeResult,
} from '@/app/actions/teacherExam';
import { resolveCanonicalLoad, type CanonicalLoadState } from '@/lib/canonicalLoadState';

type AccessConfig = NonNullable<Exam["accessConfig"]>;

interface DistributeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaveAndShare: (config: AccessConfig) => Promise<DistributionShareResultLike>;
    onAssignStudents: (input: SaveTeacherIndividualAssignmentInput) => Promise<SaveTeacherIndividualAssignmentResult | { status: "local_only" }>;
    onClearStudentAssignment: (input: ClearTeacherIndividualAssignmentInput) => Promise<ClearTeacherIndividualAssignmentResult | { status: "local_only" }>;
    onLoadStudentAssignment: (examId: string) => Promise<LoadTeacherIndividualAssignmentResult | { status: "local_only" }>;
    onLoadInviteMetadata: (examId: string) => Promise<TeacherExamEntryInviteMetadataResult>;
    onRevokeInvite: (examId: string) => Promise<TeacherExamEntryInviteRevokeResult>;
    inviteRawUrlState: ExamEntryInviteRawUrlState | null;
    onInviteRawUrlStateChange: (state: ExamEntryInviteRawUrlState | null) => void;
    retakeAssignmentsEnabled: boolean;
    onAutoMatchRegions?: () => void;
    validationSummary?: ExamValidationSummary;
    initialAccessConfig?: AccessConfig;
    initialShareUrl?: string;
    initialShareExpiresAt?: string;
    examId?: string;
    isExistingExam?: boolean;
}

type InviteMetadataLoadState =
    | { status: "idle" | "loading" | "not_found" | "forbidden" | "dependency_unavailable" }
    | { status: "found"; metadata: ExamEntryInviteMetadata };
type DistributionRosterData = { groups: RosterGroup[]; students: RosterStudent[] };

function captureTeacherRosterLoadIdentity(requestGeneration: number): TeacherRosterLoadIdentity | null {
    const session = readTeacherSession();
    if (!session?.organizationId
        || !session.teacherId
        || !Number.isSafeInteger(session.accountSessionGeneration)
        || (session.accountSessionGeneration || 0) < 1) return null;
    return {
        organizationId: session.organizationId,
        accountId: session.teacherId,
        sessionGeneration: session.accountSessionGeneration as number,
        requestGeneration,
    };
}

export default function DistributeModal({ isOpen, onClose, onSaveAndShare, onAssignStudents, onClearStudentAssignment, onLoadStudentAssignment, onLoadInviteMetadata, onRevokeInvite, inviteRawUrlState, onInviteRawUrlStateChange, retakeAssignmentsEnabled, onAutoMatchRegions, validationSummary, initialAccessConfig, initialShareUrl, initialShareExpiresAt, examId, isExistingExam = false }: DistributeModalProps) {
    const [accessType, setAccessType] = useState<'public' | 'group' | 'student'>('public');
    const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
    const [groups, setGroups] = useState<RosterGroup[]>([]);
    const [students, setStudents] = useState<RosterStudent[]>([]);
    const [shareUrl, setShareUrl] = useState<string | null>(initialShareUrl || null);
    const [shareExpiresAt, setShareExpiresAt] = useState<string | null>(initialShareExpiresAt || null);
    const [isSaving, setIsSaving] = useState(false);
    const [pin, setPin] = useState("");
    const [formError, setFormError] = useState("");
    const [copyStatus, setCopyStatus] = useState("");
    // Inline roster setup so teachers can build the exam target without leaving the share flow.
    const [showNewGroup, setShowNewGroup] = useState(false);
    const [newGroupName, setNewGroupName] = useState("");
    const [newGroupRegion, setNewGroupRegion] = useState("");
    const [studentFormGroupId, setStudentFormGroupId] = useState<string | null>(null);
    const [newStudentName, setNewStudentName] = useState("");
    const [newStudentEmail, setNewStudentEmail] = useState("");
    const [isRosterLoading, setIsRosterLoading] = useState(false);
    const [rosterLoadError, setRosterLoadError] = useState("");
    const [distributionRosterState, setDistributionRosterState] = useState<CanonicalLoadState<DistributionRosterData>>({ state: "loading" });
    const [rosterRetryGeneration, setRosterRetryGeneration] = useState(0);
    const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
    const [studentSearch, setStudentSearch] = useState("");
    const [assignmentMode, setAssignmentMode] = useState<"base" | "retake">("base");
    const [assignmentRevision, setAssignmentRevision] = useState(0);
    const [assignmentLoadError, setAssignmentLoadError] = useState("");
    const [isAssignmentLoading, setIsAssignmentLoading] = useState(false);
    const [assignmentRetryGeneration, setAssignmentRetryGeneration] = useState(0);
    const [inviteMetadataLoad, setInviteMetadataLoad] = useState<InviteMetadataLoadState>({ status: "idle" });
    const [inviteMetadataRetryGeneration, setInviteMetadataRetryGeneration] = useState(0);
    const [inviteClock, setInviteClock] = useState(() => Date.now());
    const [isInviteRevoking, setIsInviteRevoking] = useState(false);
    const wasOpenRef = useRef(false);
    const rosterLoadGenerationRef = useRef(0);
    const inviteMetadataLoadGenerationRef = useRef(0);
    const distributionOperationEpochRef = useRef(0);
    const modalRosterMutationVersionRef = useRef(0);
    const rosterInvitesRef = useRef<RosterInvite[] | null>(null);
    const rosterExpectedRevisionRef = useRef<number | undefined>(undefined);
    const modalRosterSnapshotRef = useRef<{ students: RosterStudent[]; groups: RosterGroup[]; invites: RosterInvite[] }>({
        students: [],
        groups: [],
        invites: [],
    });
    const copyResetTimerRef = useRef<number | undefined>(undefined);
    const dialogRef = useDialogFocus(isOpen, onClose);
    const dialogTitleId = useId();
    const beginIdentityOperation = (): TeacherRosterIdentityOperation | null => {
        const identity = captureTeacherRosterLoadIdentity(0);
        return identity
            ? beginTeacherRosterIdentityOperation(identity, distributionOperationEpochRef.current)
            : null;
    };
    const operationIsCurrent = (operation: TeacherRosterIdentityOperation | null): boolean => (
        !!operation
        && canContinueTeacherRosterIdentityOperation(
            operation,
            captureTeacherRosterLoadIdentity(0),
            distributionOperationEpochRef.current,
        )
    );

    useEffect(() => {
        const reloadForIdentityChange = () => {
            distributionOperationEpochRef.current += 1;
            modalRosterMutationVersionRef.current += 1;
            rosterLoadGenerationRef.current += 1;
            inviteMetadataLoadGenerationRef.current += 1;
            setGroups([]);
            setStudents([]);
            rosterInvitesRef.current = null;
            rosterExpectedRevisionRef.current = undefined;
            modalRosterSnapshotRef.current = { students: [], groups: [], invites: [] };
            setSelectedGroups([]);
            setSelectedStudentIds([]);
            setShareUrl(null);
            setShareExpiresAt(null);
            onInviteRawUrlStateChange(null);
            setInviteMetadataLoad({ status: "idle" });
            setAssignmentRetryGeneration(value => value + 1);
            setInviteMetadataRetryGeneration(value => value + 1);
            setAssignmentRevision(0);
            setAssignmentLoadError("");
            setIsAssignmentLoading(false);
            setIsSaving(false);
            setIsInviteRevoking(false);
            setFormError("");
            setCopyStatus("");
            setDistributionRosterState({ state: "loading" });
            if (isOpen) setRosterRetryGeneration(value => value + 1);
        };
        const handleStorage = (event: StorageEvent) => {
            if (event.storageArea === window.sessionStorage && event.key === TEACHER_SESSION_KEY) {
                reloadForIdentityChange();
            }
        };
        window.addEventListener(TEACHER_SESSION_IDENTITY_CHANGED_EVENT, reloadForIdentityChange);
        window.addEventListener("storage", handleStorage);
        return () => {
            window.removeEventListener(TEACHER_SESSION_IDENTITY_CHANGED_EVENT, reloadForIdentityChange);
            window.removeEventListener("storage", handleStorage);
        };
    }, [isOpen, onInviteRawUrlStateChange]);

    useEffect(() => {
        distributionOperationEpochRef.current += 1;
        return () => { distributionOperationEpochRef.current += 1; };
    }, [isOpen]);

    useEffect(() => () => {
        if (copyResetTimerRef.current !== undefined) {
            window.clearTimeout(copyResetTimerRef.current);
        }
    }, []);

    useEffect(() => {
        const loadGeneration = ++rosterLoadGenerationRef.current;
        modalRosterMutationVersionRef.current += 1;
        rosterInvitesRef.current = null;
        rosterExpectedRevisionRef.current = undefined;
        modalRosterSnapshotRef.current = { students: [], groups: [], invites: [] };
        if (!isOpen) {
            setIsRosterLoading(false);
            setRosterLoadError("");
            setDistributionRosterState({ state: "loading" });
            return;
        }

        const loadObservedAt = new Date().toISOString();
        const capturedIdentity = captureTeacherRosterLoadIdentity(loadGeneration);
        const completionIsCurrent = () => {
            if (!capturedIdentity || rosterLoadGenerationRef.current !== loadGeneration) return false;
            const current = captureTeacherRosterLoadIdentity(loadGeneration);
            return !!current && sameTeacherRosterLoadIdentity(capturedIdentity, current);
        };
        let cachedData: DistributionRosterData | null = null;
        let cachedAt: string | null = null;
        try {
            const degraded = capturedIdentity
                ? readTeacherRosterDegradedCache(localStorage, capturedIdentity, new Date(loadObservedAt))
                : null;
            if (degraded) {
                const display = toTeacherRosterDegradedDisplayData(degraded);
                cachedData = { groups: display.groups, students: display.students };
                cachedAt = degraded.staleAt;
            }
        } catch {
            cachedData = null;
        }

        setIsRosterLoading(true);
        setDistributionRosterState({ state: "loading" });
        setRosterLoadError("");
        if (!capturedIdentity) {
            setDistributionRosterState(resolveCanonicalLoad({
                remote: { ok: false },
                cache: null,
                now: loadObservedAt,
            }, data => data.groups.length === 0 && data.students.length === 0));
            setGroups([]);
            setStudents([]);
            setRosterLoadError("서버 명단을 불러오지 못했고 검증된 저장 명단이 없습니다.");
            setIsRosterLoading(false);
            return () => {
                if (rosterLoadGenerationRef.current === loadGeneration) rosterLoadGenerationRef.current += 1;
            };
        }
        void loadTeacherRosterSnapshot(localStorage)
            .then(snapshot => {
                if (!completionIsCurrent()) return;
                const currentIdentity = captureTeacherRosterLoadIdentity(loadGeneration);
                if (!currentIdentity || !capturedIdentity) return;
                let remoteReady = snapshot.remoteLoaded === true
                    && snapshot.remoteSynced === true
                    && !snapshot.remoteError
                    && !!snapshot.candidate
                    && snapshot.meta?.organizationId === capturedIdentity.organizationId;
                const safeCandidate = remoteReady && snapshot.candidate
                    ? sanitizeTeacherRosterCandidate(snapshot.candidate)
                    : null;
                if (remoteReady && !safeCandidate) remoteReady = false;
                if (remoteReady && safeCandidate) {
                    const persisted = persistTeacherRosterCompletionIfCurrent(
                        localStorage,
                        safeCandidate,
                        capturedIdentity,
                        currentIdentity,
                        new Date(loadObservedAt),
                    );
                    if (persisted.status === "stale" || !completionIsCurrent()) return;
                    if (persisted.status === "rejected") remoteReady = false;
                }
                const loadedData = remoteReady && safeCandidate
                    ? { groups: safeCandidate.snapshot.groups, students: safeCandidate.snapshot.students }
                    : { groups: [], students: [] };
                const nextState = resolveCanonicalLoad({
                    remote: remoteReady ? { ok: true, data: loadedData } : { ok: false },
                    cache: cachedData && cachedAt ? { data: cachedData, staleAt: cachedAt } : null,
                    now: loadObservedAt,
                }, data => data.groups.length === 0 && data.students.length === 0);
                if (!remoteReady) {
                    rosterInvitesRef.current = null;
                    rosterExpectedRevisionRef.current = undefined;
                    distributionOperationEpochRef.current += 1;
                    inviteMetadataLoadGenerationRef.current += 1;
                    setIsSaving(false);
                    setIsInviteRevoking(false);
                    setShareUrl(null);
                    setShareExpiresAt(null);
                    onInviteRawUrlStateChange(null);
                    setInviteMetadataLoad({ status: "idle" });
                }
                if (remoteReady && safeCandidate) {
                    rosterInvitesRef.current = safeCandidate.snapshot.invites.map(invite => ({ ...invite }));
                    rosterExpectedRevisionRef.current = safeCandidate.revision;
                }
                setDistributionRosterState(nextState);
                const visibleData = nextState.state === "loaded_empty" || nextState.state === "loaded_data" || nextState.state === "degraded_with_cache"
                    ? nextState.data
                    : { groups: [], students: [] };
                setGroups(visibleData.groups);
                setStudents(visibleData.students);
                modalRosterSnapshotRef.current = {
                    groups: visibleData.groups,
                    students: visibleData.students,
                    invites: remoteReady && safeCandidate ? safeCandidate.snapshot.invites : [],
                };
                if (!remoteReady) {
                    setRosterLoadError(nextState.state === "degraded_with_cache"
                        ? "서버 명단을 불러오지 못해 검증된 저장 명단을 표시합니다."
                        : "서버 명단을 불러오지 못했고 검증된 저장 명단이 없습니다.");
                }
            })
            .catch(() => {
                if (!completionIsCurrent()) return;
                distributionOperationEpochRef.current += 1;
                rosterInvitesRef.current = null;
                rosterExpectedRevisionRef.current = undefined;
                inviteMetadataLoadGenerationRef.current += 1;
                setIsSaving(false);
                setIsInviteRevoking(false);
                setShareUrl(null);
                setShareExpiresAt(null);
                onInviteRawUrlStateChange(null);
                setInviteMetadataLoad({ status: "idle" });
                const nextState = resolveCanonicalLoad({
                    remote: { ok: false },
                    cache: cachedData && cachedAt ? { data: cachedData, staleAt: cachedAt } : null,
                    now: loadObservedAt,
                }, data => data.groups.length === 0 && data.students.length === 0);
                setDistributionRosterState(nextState);
                const visibleData = nextState.state === "degraded_with_cache" ? nextState.data : { groups: [], students: [] };
                setGroups(visibleData.groups);
                setStudents(visibleData.students);
                modalRosterSnapshotRef.current = {
                    groups: visibleData.groups,
                    students: visibleData.students,
                    invites: [],
                };
                setRosterLoadError(nextState.state === "degraded_with_cache"
                    ? "서버 명단을 불러오지 못해 검증된 저장 명단을 표시합니다."
                    : "서버 명단을 불러오지 못했고 검증된 저장 명단이 없습니다.");
            })
            .finally(() => {
                if (completionIsCurrent()) {
                    setIsRosterLoading(false);
                }
            });

        return () => {
            if (rosterLoadGenerationRef.current === loadGeneration) {
                rosterLoadGenerationRef.current += 1;
            }
        };
    }, [isOpen, onInviteRawUrlStateChange, rosterRetryGeneration]);

    useEffect(() => {
        if (!isOpen) {
            wasOpenRef.current = false;
            if (copyResetTimerRef.current !== undefined) {
                window.clearTimeout(copyResetTimerRef.current);
                copyResetTimerRef.current = undefined;
            }
            return;
        }
        if (wasOpenRef.current) {
            return;
        }
        wasOpenRef.current = true;

        const initialType = initialAccessConfig?.type === 'targeted' ? 'student' : initialAccessConfig?.type === 'group' ? 'group' : 'public';

        setShareUrl(initialShareUrl || null);
        setShareExpiresAt(initialShareExpiresAt || null);
        setAccessType(initialType);
        setSelectedGroups(initialType === 'group' ? [...(initialAccessConfig?.groupIds || [])] : []);
        setIsSaving(false);
        setPin(initialType === 'public' ? normalizeExamPin(initialAccessConfig?.pin || "") : "");
        setFormError("");
        setCopyStatus("");
        setShowNewGroup(false);
        setNewGroupName("");
        setNewGroupRegion("");
        setStudentFormGroupId(null);
        setNewStudentName("");
        setNewStudentEmail("");
        setSelectedStudentIds([]);
        setStudentSearch("");
        setAssignmentMode("base");
        setAssignmentRevision(0);
        setAssignmentLoadError("");
        setIsAssignmentLoading(Boolean(examId));
    }, [examId, isOpen, initialAccessConfig, initialShareUrl, initialShareExpiresAt]);

    useEffect(() => {
        if (!isOpen || !examId) {
            setIsAssignmentLoading(false);
            return;
        }
        let cancelled = false;
        const operation = beginIdentityOperation();
        setIsAssignmentLoading(true);
        void onLoadStudentAssignment(examId).then(result => {
            if (cancelled || !operationIsCurrent(operation)) return;
            if (result.status === "loaded") {
                setAccessType("student");
                setSelectedStudentIds(result.targetStudentIds);
                setAssignmentMode(result.mode === "retake" && !retakeAssignmentsEnabled ? "base" : result.mode);
                setAssignmentRevision(result.revision);
            } else if (result.status !== "not_found" && result.status !== "local_only") {
                setAssignmentLoadError("기존 개별 배정 상태를 불러오지 못했습니다. 다시 시도해주세요.");
            }
        }).catch(() => {
            if (!cancelled && operationIsCurrent(operation)) setAssignmentLoadError("기존 개별 배정 상태를 불러오지 못했습니다. 다시 시도해주세요.");
        }).finally(() => {
            if (!cancelled && operationIsCurrent(operation)) setIsAssignmentLoading(false);
        });
        return () => { cancelled = true; };
    }, [assignmentRetryGeneration, examId, isOpen, onLoadStudentAssignment, retakeAssignmentsEnabled]);

    useEffect(() => {
        const loadGeneration = ++inviteMetadataLoadGenerationRef.current;
        if (!isOpen || !examId) {
            setInviteMetadataLoad({ status: "idle" });
            return;
        }

        const expectedExamId = examId;
        const operation = beginIdentityOperation();
        setInviteMetadataLoad({ status: "loading" });
        void onLoadInviteMetadata(expectedExamId)
            .then(result => {
                if (inviteMetadataLoadGenerationRef.current !== loadGeneration || !operationIsCurrent(operation)) return;
                if (result.status === "found") {
                    if (result.metadata.examId !== expectedExamId) {
                        setInviteMetadataLoad({ status: "dependency_unavailable" });
                        return;
                    }
                    setInviteClock(Date.now());
                    setInviteMetadataLoad({ status: "found", metadata: result.metadata });
                    return;
                }
                setInviteMetadataLoad({ status: result.status });
            })
            .catch(() => {
                if (inviteMetadataLoadGenerationRef.current === loadGeneration && operationIsCurrent(operation)) {
                    setInviteMetadataLoad({ status: "dependency_unavailable" });
                }
            });

        return () => {
            if (inviteMetadataLoadGenerationRef.current === loadGeneration) {
                inviteMetadataLoadGenerationRef.current += 1;
            }
        };
    }, [examId, inviteMetadataRetryGeneration, isOpen, onLoadInviteMetadata]);

    const inviteCapability: ExamEntryInviteCapability | null = inviteMetadataLoad.status === "found"
        ? resolveInviteCapability({
            metadata: inviteMetadataLoad.metadata,
            rawUrl: inviteRawUrlState,
            now: inviteClock,
        })
        : null;

    useEffect(() => {
        if (inviteMetadataLoad.status !== "found") return;
        const expiryMs = Date.parse(inviteMetadataLoad.metadata.expiresAt);
        if (!Number.isFinite(expiryMs) || expiryMs <= inviteClock) return;
        const timer = window.setTimeout(
            () => setInviteClock(Date.now()),
            Math.min(expiryMs - inviteClock + 25, 2_147_483_647),
        );
        return () => window.clearTimeout(timer);
    }, [inviteClock, inviteMetadataLoad]);

    useEffect(() => {
        const shouldDiscardGroupBearer = inviteMetadataLoad.status === "not_found"
            || (inviteMetadataLoad.status === "found" && inviteCapability !== "copyable_here");
        if (!shouldDiscardGroupBearer) return;
        if (inviteRawUrlState) onInviteRawUrlStateChange(null);
        if (isGroupInviteShareUrl(shareUrl)) {
            setShareUrl(null);
            setShareExpiresAt(null);
        }
    }, [inviteCapability, inviteMetadataLoad, inviteRawUrlState, onInviteRawUrlStateChange, shareUrl]);

    const targetSummary = useMemo(() => summarizeDistributionTargets({
        selectedGroupIds: selectedGroups,
        groups,
        students,
    }), [groups, selectedGroups, students]);
    const visibleStudents = useMemo(() => {
        const query = studentSearch.trim().toLocaleLowerCase("ko-KR");
        return students.filter(student => student.status === "active" && (!query || [student.name, student.group, student.region, student.email]
            .some(value => (value || "").toLocaleLowerCase("ko-KR").includes(query))));
    }, [studentSearch, students]);
    const isRotatingExistingGroupInvite = isExistingExam
        && initialAccessConfig?.type === 'group'
        && accessType === 'group';
    const isGroupReissue = accessType === "group"
        && (isRotatingExistingGroupInvite || inviteMetadataLoad.status === "found");
    const hasActiveGroupInvite = accessType === "group"
        && (inviteCapability === "copyable_here" || inviteCapability === "active_but_raw_unavailable");
    const inviteLifecycleBlocksIssuance = isExistingExam
        && accessType === "group"
        && (inviteMetadataLoad.status === "idle"
            || inviteMetadataLoad.status === "loading"
            || inviteMetadataLoad.status === "forbidden"
            || inviteMetadataLoad.status === "dependency_unavailable");
    const distributionRosterReadOnly = (distributionRosterState.state !== "loaded_empty"
        && distributionRosterState.state !== "loaded_data")
        || rosterExpectedRevisionRef.current === undefined;
    const visibleShareUrl = accessType === "group"
        ? inviteCapability === "copyable_here" ? inviteRawUrlState?.url || null : null
        : isGroupInviteShareUrl(shareUrl) ? null : shareUrl;

    if (!isOpen) return null;

    const reloadConflictedAssignment = async (
        targetExamId: string,
        operation: TeacherRosterIdentityOperation,
    ) => {
        const latest = await reloadLatestAssignmentAfterConflict(targetExamId, onLoadStudentAssignment);
        if (!operationIsCurrent(operation)) return false;
        if (latest.status !== "loaded") {
            setAssignmentLoadError("최신 개별 배정 상태를 불러오지 못했습니다. 창을 닫고 다시 열어주세요.");
            return false;
        }
        setSelectedStudentIds(latest.targetStudentIds);
        setAssignmentMode(latest.mode === "retake" && !retakeAssignmentsEnabled ? "base" : latest.mode);
        setAssignmentRevision(latest.revision);
        return true;
    };

    const handleShareClick = async () => {
        setFormError("");
        if (distributionRosterReadOnly) {
            setFormError("최신 서버 명단을 확인할 때까지 읽기 전용이며 배포를 진행하지 않습니다. 다시 시도해주세요.");
            return;
        }
        if (accessType === "group" && inviteLifecycleBlocksIssuance) {
            setFormError("기존 배포 링크 상태를 확인한 뒤 새 링크를 발급할 수 있습니다. 다시 시도해주세요.");
            return;
        }
        if (validationSummary && !validationSummary.isPublishable) {
            setFormError(validationSummary.errors[0]?.message || "배포 전 시험 설정을 확인해주세요.");
            return;
        }

        if (accessType === 'group' && selectedGroups.length === 0) {
            setFormError("공유할 그룹을 최소 하나 선택해주세요.");
            return;
        }

        if (accessType === 'group' && isRosterLoading) {
            setFormError("서버 명단을 불러온 뒤 다시 시도해주세요.");
            return;
        }

        if (accessType === 'student' && (isRosterLoading || selectedStudentIds.length < 1 || selectedStudentIds.length > 100)) {
            setFormError(isRosterLoading
                ? "서버 명단을 불러온 뒤 다시 시도해주세요."
                : "개별 배포할 학생을 1명 이상 100명 이하로 선택해주세요.");
            return;
        }

        if (isAssignmentLoading) {
            setFormError("최신 개별 배정 상태를 확인한 뒤 다시 시도해주세요.");
            return;
        }

        if (accessType === "student" && assignmentMode === "retake" && !retakeAssignmentsEnabled) {
            setAssignmentMode("base");
            setFormError("재시험 배정은 Pro 플랜에서 사용할 수 있습니다.");
            return;
        }

        if (accessType === 'public' && pin && !isValidExamPin(pin)) {
            setFormError("PIN은 4~6자리 숫자여야 합니다.");
            return;
        }

        const config: AccessConfig = {
            type: accessType === 'student' ? 'targeted' : accessType,
            groupIds: accessType === 'group' ? selectedGroups : undefined,
            pin: accessType === 'public' && pin ? pin : undefined,
        };
        const operation = beginIdentityOperation();
        if (!operation) return;

        try {
            if (accessType === "student") {
                setIsSaving(true);
                let shareResult = examId ? null : normalizeDistributionShareResult(await onSaveAndShare(config));
                if (!operationIsCurrent(operation)) return;
                const targetExamId = examId || shareResult?.examId || "";
                if (!targetExamId) {
                    setFormError("시험 저장 결과를 확인하지 못했습니다. 다시 시도해주세요.");
                    return;
                }
                const assigned = await onAssignStudents({
                    examId: targetExamId,
                    targetStudentIds: selectedStudentIds,
                    mode: assignmentMode,
                    expectedRevision: assignmentRevision,
                });
                if (!operationIsCurrent(operation)) return;
                if (assigned.status !== "saved") {
                    if (assigned.status === "conflict") {
                        const reloaded = await reloadConflictedAssignment(targetExamId, operation);
                        if (!operationIsCurrent(operation)) return;
                        setFormError(reloaded
                            ? "다른 기기에서 배정이 변경되어 최신 학생과 유형을 다시 불러왔습니다. 확인 후 다시 시도해주세요."
                            : "다른 기기에서 배정이 변경되었습니다. 창을 닫고 다시 열어주세요.");
                    } else if (assigned.status === "retake_unavailable") {
                        setFormError("선택한 학생 중 제출했거나 오답이 있는 원시험 기록이 없는 학생이 있습니다.");
                    } else if (assigned.status === "plan_denied") {
                        setAssignmentMode("base");
                        setFormError("현재 서버 플랜에서는 재시험을 배정할 수 없습니다.");
                    } else if (assigned.status === "active_sessions") {
                        setFormError("현재 응시 중인 학생이 있어 배정 대상을 변경할 수 없습니다.");
                    } else if (assigned.status === "invalid_targets") {
                        setFormError("선택한 학생의 활성 명단 상태가 변경되었습니다. 명단을 새로고침한 뒤 다시 시도해주세요.");
                    } else {
                        setFormError("개별 학생 배정에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.");
                    }
                    return;
                }
                setAssignmentRevision(assigned.revision);
                // For existing exams the assignment RPC owns the public/group → targeted
                // transition atomically. Persist any editor changes only after that scope exists.
                if (!shareResult) shareResult = normalizeDistributionShareResult(await onSaveAndShare(config));
                if (!operationIsCurrent(operation)) return;
                if (!shareResult.shareUrl) {
                    setFormError("개별 배정은 저장됐지만 시험 편집 내용 저장에 실패했습니다. 다시 시도해주세요.");
                    return;
                }
                const targetedUrl = new URL(shareResult.shareUrl, window.location.origin);
                targetedUrl.searchParams.set("assignment", assigned.assignmentId);
                if (!operationIsCurrent(operation)) return;
                setShareUrl(targetedUrl.toString());
                setShareExpiresAt(null);
                return;
            }
            if (assignmentRevision > 0 && examId) {
                setIsSaving(true);
                const cleared = await onClearStudentAssignment({
                    examId,
                    expectedRevision: assignmentRevision,
                    accessType,
                    groupIds: accessType === "group" ? selectedGroups : undefined,
                });
                if (!operationIsCurrent(operation)) return;
                if (cleared.status !== "cleared") {
                    if (cleared.status === "conflict") {
                        const reloaded = await reloadConflictedAssignment(examId, operation);
                        if (!operationIsCurrent(operation)) return;
                        if (reloaded) setAccessType("student");
                        setFormError(reloaded
                            ? "다른 기기에서 배정이 변경되어 최신 학생과 유형을 다시 불러왔습니다. 확인 후 다시 시도해주세요."
                            : "다른 기기에서 배정이 변경되었습니다. 창을 닫고 다시 열어주세요.");
                    } else if (cleared.status === "active_sessions") {
                        setFormError("현재 응시 중인 학생이 있어 개별 배정을 해제할 수 없습니다.");
                    } else {
                        setFormError("개별 배정을 안전하게 해제하지 못했습니다. 기존 배정은 유지됩니다.");
                    }
                    return;
                }
                setAssignmentRevision(0);
                setSelectedStudentIds([]);
                setAssignmentMode("base");
            }
            const outcome = await confirmExistingGroupInviteRotation({
                needsConfirmation: hasActiveGroupInvite,
                confirm: message => window.confirm(message),
                rotateAndSave: async () => {
                    setIsSaving(true);
                    return onSaveAndShare(config);
                },
            });
            if (!operationIsCurrent(operation)) return;
            if (outcome.status === "cancelled") return;
            const shareResult = normalizeDistributionShareResult(outcome.result);
            if (!shareResult.shareUrl) {
                setFormError("링크 생성에 실패했습니다. 배포 체크와 저장 상태를 확인한 뒤 다시 시도해주세요.");
                return;
            }
            if (accessType === "group") {
                const boundExamId = resolveInviteRotationExamId(shareResult, examId);
                if (!shareResult.metadata || !boundExamId) {
                    setFormError("새 링크는 발급됐지만 현재 배포 상태를 확인하지 못했습니다. 창을 닫고 다시 확인해주세요.");
                    onInviteRawUrlStateChange(null);
                    return;
                }
                const nextRawUrlState: ExamEntryInviteRawUrlState = {
                    url: shareResult.shareUrl,
                    examId: boundExamId,
                    generation: shareResult.metadata.generation,
                    issuedAt: shareResult.metadata.issuedAt,
                };
                if (!operationIsCurrent(operation)) return;
                setInviteClock(Date.now());
                setInviteMetadataLoad({ status: "found", metadata: shareResult.metadata });
                onInviteRawUrlStateChange(nextRawUrlState);
            }
            setShareUrl(shareResult.shareUrl);
            setShareExpiresAt(shareResult.expiresAt || null);
        } catch {
            if (operationIsCurrent(operation)) setFormError("링크 생성에 실패했습니다. 시험 저장 상태를 확인한 뒤 다시 시도해주세요.");
        } finally {
            if (operationIsCurrent(operation)) setIsSaving(false);
        }
    };

    const copyShareLink = async () => {
        if (!visibleShareUrl) return;
        const operation = beginIdentityOperation();
        if (!operation) return;
        if (copyResetTimerRef.current !== undefined) {
            window.clearTimeout(copyResetTimerRef.current);
            copyResetTimerRef.current = undefined;
        }
        try {
            await navigator.clipboard.writeText(visibleShareUrl);
            if (!operationIsCurrent(operation)) return;
            setCopyStatus("복사됨");
            toast.success("링크 복사 완료", "학생용 응시 링크가 클립보드에 복사되었습니다.");
            copyResetTimerRef.current = window.setTimeout(() => {
                copyResetTimerRef.current = undefined;
                setCopyStatus("");
            }, 1600);
        } catch {
            if (operationIsCurrent(operation)) setCopyStatus("복사 실패");
        }
    };

    const copyGuideMessage = async () => {
        if (!visibleShareUrl) return;
        const operation = beginIdentityOperation();
        if (!operation) return;
        if (copyResetTimerRef.current !== undefined) {
            window.clearTimeout(copyResetTimerRef.current);
            copyResetTimerRef.current = undefined;
        }
        try {
            const message = `[OMR 시험 응시 안내]\n선생님이 배포한 시험에 접속하여 응시해주세요.\n👉 응시 링크: ${visibleShareUrl}`;
            await navigator.clipboard.writeText(message);
            if (!operationIsCurrent(operation)) return;
            setCopyStatus("안내 문구 복사됨");
            toast.success("복사 완료", "학생에게 전달할 응시 안내 문구가 복사되었습니다.");
            copyResetTimerRef.current = window.setTimeout(() => {
                copyResetTimerRef.current = undefined;
                setCopyStatus("");
            }, 1600);
        } catch {
            if (operationIsCurrent(operation)) setCopyStatus("복사 실패");
        }
    };

    const revokeGroupInvite = async () => {
        if (!examId || isInviteRevoking) return;
        if (distributionRosterReadOnly) {
            setFormError("최신 서버 명단을 확인한 뒤 링크를 해지할 수 있습니다.");
            return;
        }
        setFormError("");
        setIsInviteRevoking(true);
        const operation = beginIdentityOperation();
        if (!operation) {
            setIsInviteRevoking(false);
            return;
        }
        try {
            const result = await onRevokeInvite(examId);
            if (!operationIsCurrent(operation)) return;
            if (result.status === "revoked") {
                if (result.metadata.examId !== examId) {
                    setInviteMetadataLoad({ status: "dependency_unavailable" });
                    setFormError("링크 해지 결과의 시험 범위를 확인하지 못했습니다. 다시 시도해주세요.");
                    return;
                }
                onInviteRawUrlStateChange(null);
                setShareUrl(null);
                setShareExpiresAt(null);
                setInviteClock(Date.now());
                setInviteMetadataLoad({ status: "found", metadata: result.metadata });
                return;
            }
            if (result.status === "not_found") {
                onInviteRawUrlStateChange(null);
                setShareUrl(null);
                setShareExpiresAt(null);
                setInviteMetadataLoad({ status: "not_found" });
                return;
            }
            setInviteMetadataLoad({ status: result.status });
            setFormError(result.status === "forbidden"
                ? "이 링크를 해지할 권한이 없습니다."
                : "링크 해지 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.");
        } catch {
            if (operationIsCurrent(operation)) {
                setInviteMetadataLoad({ status: "dependency_unavailable" });
                setFormError("링크 해지 서비스를 사용할 수 없습니다. 잠시 후 다시 시도해주세요.");
            }
        } finally {
            if (operationIsCurrent(operation)) setIsInviteRevoking(false);
        }
    };

    const downloadQR = () => {
        const canvas = document.getElementById("qr-code-canvas") as HTMLCanvasElement;
        if (canvas) {
            const pngUrl = canvas.toDataURL("image/png");
            const downloadLink = document.createElement("a");
            downloadLink.href = pngUrl;
            downloadLink.download = "exam_qr.png";
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);
        }
    };

    const toggleGroup = (id: string) => {
        setSelectedGroups(prev =>
            prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
        );
    };

    const retryCanonicalRoster = () => {
        distributionOperationEpochRef.current += 1;
        rosterLoadGenerationRef.current += 1;
        inviteMetadataLoadGenerationRef.current += 1;
        setIsSaving(false);
        setIsInviteRevoking(false);
        setShareUrl(null);
        setShareExpiresAt(null);
        onInviteRawUrlStateChange(null);
        setInviteMetadataLoad({ status: "idle" });
        modalRosterMutationVersionRef.current += 1;
        rosterInvitesRef.current = null;
        rosterExpectedRevisionRef.current = undefined;
        modalRosterSnapshotRef.current = { students: [], groups: [], invites: [] };
        setDistributionRosterState({ state: "loading" });
        setAssignmentRetryGeneration(value => value + 1);
        setInviteMetadataRetryGeneration(value => value + 1);
        setRosterRetryGeneration(value => value + 1);
    };

    // Write the full roster snapshot through (preserving invites) and reflect it locally.
    const persistRoster = (nextStudents: RosterStudent[], nextGroups: RosterGroup[]) => {
        if (distributionRosterReadOnly) {
            setFormError("최신 서버 명단을 확인한 뒤 명단을 변경할 수 있습니다.");
            return;
        }
        const operation = beginIdentityOperation();
        if (!operation) return;
        const rosterInvites = rosterInvitesRef.current;
        const expectedRevision = rosterExpectedRevisionRef.current;
        if (!rosterInvites || expectedRevision === undefined) {
            setFormError("최신 서버 초대 명단을 확인한 뒤 명단을 변경할 수 있습니다.");
            return;
        }
        const mutationVersion = ++modalRosterMutationVersionRef.current;
        const previousSnapshot = modalRosterSnapshotRef.current;
        const nextSnapshot = {
            students: nextStudents,
            groups: nextGroups,
            invites: rosterInvites.map(invite => ({ ...invite })),
        };
        const mutationIsCurrent = () => mutationVersion === modalRosterMutationVersionRef.current
            && operationIsCurrent(operation);
        modalRosterSnapshotRef.current = nextSnapshot;
        setStudents(nextStudents);
        setGroups(nextGroups);
        void saveTeacherRosterSnapshotIfCurrent(
            localStorage,
            nextSnapshot,
            mutationIsCurrent,
            expectedRevision,
            operation.identity,
        )
            .then(result => {
                if ("status" in result || !mutationIsCurrent()) return;
                if (result.remoteRevision !== undefined) rosterExpectedRevisionRef.current = result.remoteRevision;
                if (result.remoteError && !result.localSaved) {
                    modalRosterSnapshotRef.current = previousSnapshot;
                    setStudents(previousSnapshot.students);
                    setGroups(previousSnapshot.groups);
                    toast.error("명단 저장 실패", "서버에 저장되지 않아 방금 변경을 되돌렸습니다.");
                }
            })
            .catch(() => {
                if (mutationIsCurrent()) toast.error("명단 저장 실패", "브라우저 저장소 권한을 확인해주세요.");
            });
    };

    const handleCreateGroup = () => {
        if (distributionRosterReadOnly) {
            setFormError("서버 명단을 불러온 뒤 반을 추가해주세요.");
            return;
        }
        const result = addRosterGroup(students, groups, { name: newGroupName, region: newGroupRegion });
        if (!result.ok) {
            if (result.reason === "duplicate" && result.group) {
                // Same name+region already exists — just select it instead of erroring out.
                setSelectedGroups(prev => prev.includes(result.group!.id) ? prev : [...prev, result.group!.id]);
                setShowNewGroup(false);
                setNewGroupName("");
                setNewGroupRegion("");
                toast.info("이미 있는 반", `${formatRegionScopedLabel(result.group.name, result.group.region)} 반을 대상으로 선택했습니다.`);
                return;
            }
            setFormError("반 이름을 입력해주세요.");
            return;
        }
        persistRoster(result.students, result.groups);
        if (result.group) {
            setSelectedGroups(prev => [...prev, result.group!.id]);
            toast.success("반 추가됨", `${formatRegionScopedLabel(result.group.name, result.group.region)} 반을 만들고 대상으로 선택했습니다.`);
        }
        setShowNewGroup(false);
        setNewGroupName("");
        setNewGroupRegion("");
        setFormError("");
    };

    const handleAddStudent = (groupId: string) => {
        if (distributionRosterReadOnly) {
            setFormError("서버 명단을 불러온 뒤 학생을 추가해주세요.");
            return;
        }
        const result = addRosterStudent(students, groups, { name: newStudentName, email: newStudentEmail, groupId });
        if (!result.ok) {
            const message = result.reason === "invalid-email"
                ? "올바른 이메일을 입력해주세요."
                : result.reason === "duplicate"
                    ? "같은 이메일 또는 학생번호가 이미 있습니다."
                    : result.reason === "missing-name"
                        ? "학생 이름을 입력해주세요."
                        : "대상 반을 찾을 수 없습니다.";
            setFormError(message);
            return;
        }
        persistRoster(result.students, result.groups);
        if (!selectedGroups.includes(groupId)) {
            setSelectedGroups(prev => [...prev, groupId]);
        }
        toast.success("학생 추가됨", `${result.student?.name || "학생"}을(를) 명단에 추가했습니다.`);
        setNewStudentName("");
        setNewStudentEmail("");
        setFormError("");
    };

    return (
        <div
            className="distribute-dialog-backdrop"
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            style={{
            position: 'fixed',
            top: 'var(--app-visual-viewport-offset-top)',
            left: 'var(--app-visual-viewport-offset-left)',
            width: 'var(--app-viewport-width, 100vw)',
            height: 'var(--app-viewport-height, 100dvh)',
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000,
            padding: 'max(0.5rem, var(--app-safe-area-top)) max(0.5rem, var(--app-safe-area-right)) max(0.5rem, var(--app-safe-area-bottom)) max(0.5rem, var(--app-safe-area-left))'
        }}>
            <div
                ref={dialogRef}
                className="balanced-dialog-panel distribute-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={dialogTitleId}
                tabIndex={-1}
                style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                borderRadius: '8px',
                display: 'flex', flexDirection: 'column',
                border: '1px solid var(--border)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.22)'
            }}>
                <header style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 id={dialogTitleId} style={{ fontSize: '1.25rem', fontWeight: 600 }}>시험 배포하기</h2>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="닫기"
                        style={{
                            border: 'none',
                            background: 'none',
                            color: 'var(--muted)',
                            fontSize: '1.5rem',
                            cursor: 'pointer',
                            width: 44,
                            height: 44,
                        }}
                    >
                        &times;
                    </button>
                </header>

                <div className="distribute-dialog-body">
                    {distributionRosterState.state === "loading" && (
                        <div
                            data-testid="canonical-distribution-roster-loading"
                            role="status"
                            aria-live="polite"
                            style={{ marginBottom: '1rem', padding: '0.85rem', borderRadius: 8, border: '1px solid rgba(99,102,241,0.25)', background: 'rgba(99,102,241,0.08)', color: 'var(--muted)', fontSize: '0.82rem', fontWeight: 700 }}
                        >
                            서버 명단을 불러오는 중입니다. 확인이 끝날 때까지 배포와 명단 변경은 비활성화됩니다.
                        </div>
                    )}
                    {distributionRosterState.state === "error_without_cache" && (
                        <div data-testid="canonical-error-no-cache" role="alert" style={{ marginBottom: '1rem', padding: '0.85rem', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', fontSize: '0.82rem', lineHeight: 1.5 }}>
                            <strong style={{ display: 'block', marginBottom: '0.25rem' }}>서버 명단을 불러오지 못했습니다.</strong>
                            검증된 저장 명단이 없어 배포와 명단 변경을 비활성화했습니다.
                            <button data-testid="canonical-distribution-roster-retry" type="button" className="btn btn-secondary" onClick={retryCanonicalRoster} style={{ display: 'block', marginTop: '0.65rem' }}>
                                다시 시도
                            </button>
                        </div>
                    )}
                    {distributionRosterState.state === "degraded_with_cache" && (
                        <div data-testid="canonical-degraded-cache" role="status" style={{ marginBottom: '1rem', padding: '0.85rem', borderRadius: 8, border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e', fontSize: '0.82rem', lineHeight: 1.5 }}>
                            <strong style={{ display: 'block' }}>저장된 데이터를 읽기 전용으로 표시 중</strong>
                            마지막 저장 {new Date(distributionRosterState.staleAt).toLocaleString('ko-KR')} · 서버 명단을 다시 확인해주세요.
                            <button type="button" className="btn btn-secondary" onClick={retryCanonicalRoster} style={{ display: 'block', marginTop: '0.65rem' }}>다시 시도</button>
                        </div>
                    )}
                    {!visibleShareUrl ? (
                        <>
                            {accessType === "group" && inviteMetadataLoad.status === "loading" && (
                                <div
                                    role="status"
                                    aria-live="polite"
                                    style={{ marginBottom: '1rem', padding: '0.8rem', borderRadius: 8, background: 'rgba(99,102,241,0.08)', color: 'var(--muted)', fontSize: '0.82rem', fontWeight: 700 }}
                                >
                                    현재 배포 링크 상태를 확인하고 있습니다.
                                </div>
                            )}
                            {accessType === "group" && inviteMetadataLoad.status === "dependency_unavailable" && (
                                <div
                                    role="alert"
                                    style={{ marginBottom: '1rem', padding: '0.85rem', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', fontSize: '0.82rem', lineHeight: 1.5 }}
                                >
                                    <strong style={{ display: 'block', marginBottom: '0.25rem' }}>배포 링크 상태를 불러오지 못했습니다.</strong>
                                    없는 링크로 처리하지 않았습니다. 네트워크를 확인한 뒤 다시 시도해주세요.
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        onClick={() => setInviteMetadataRetryGeneration(value => value + 1)}
                                        style={{ display: 'block', marginTop: '0.65rem' }}
                                    >
                                        다시 시도
                                    </button>
                                </div>
                            )}
                            {accessType === "group" && inviteMetadataLoad.status === "forbidden" && (
                                <div
                                    role="alert"
                                    style={{ marginBottom: '1rem', padding: '0.85rem', borderRadius: 8, border: '1px solid #fecaca', background: '#fef2f2', color: '#b91c1c', fontSize: '0.82rem', lineHeight: 1.5 }}
                                >
                                    현재 계정에는 배포 링크를 조회하거나 변경할 권한이 없습니다.
                                </div>
                            )}
                            {accessType === "group" && inviteMetadataLoad.status === "found" && inviteCapability && (
                                <div
                                    data-testid={`distribution-invite-${inviteCapability}`}
                                    role="status"
                                    aria-live="polite"
                                    style={{ marginBottom: '1rem', padding: '0.9rem', borderRadius: 8, border: '1px solid rgba(99,102,241,0.25)', background: 'rgba(99,102,241,0.07)', fontSize: '0.82rem', lineHeight: 1.55 }}
                                >
                                    <strong style={{ display: 'block', marginBottom: '0.25rem' }}>
                                        {inviteCapability === "active_but_raw_unavailable"
                                            ? "활성 링크가 있습니다"
                                            : inviteCapability === "expired"
                                                ? "링크가 만료되었습니다"
                                                : "링크가 해지되었습니다"}
                                    </strong>
                                    {inviteCapability === "active_but_raw_unavailable" && (
                                        <>
                                            <p style={{ margin: 0 }}>이 기기에는 링크 원문이 없습니다. 보안을 위해 서버에서 원문을 복구하지 않습니다.</p>
                                            <p style={{ margin: '0.35rem 0 0', fontWeight: 800 }}>새 링크를 발급하면 기존 링크와 QR은 즉시 무효화됩니다.</p>
                                        </>
                                    )}
                                    <p style={{ margin: '0.35rem 0 0' }}>
                                        만료 시각: {new Date(inviteMetadataLoad.metadata.expiresAt).toLocaleString('ko-KR')}
                                    </p>
                                    {inviteCapability !== "revoked" && (
                                        <button
                                            type="button"
                                            className="btn btn-secondary"
                                            onClick={revokeGroupInvite}
                                            disabled={isInviteRevoking || distributionRosterReadOnly}
                                            style={{ marginTop: '0.65rem' }}
                                        >
                                            {isInviteRevoking ? "해지 중..." : "링크 해지"}
                                        </button>
                                    )}
                                </div>
                            )}
                            {validationSummary && (
                                <div style={{
                                    marginBottom: '1.25rem',
                                    padding: '0.9rem',
                                    borderRadius: '8px',
                                    border: validationSummary.isPublishable ? '1px solid #bbf7d0' : '1px solid #fecaca',
                                    background: validationSummary.isPublishable ? '#f0fdf4' : '#fef2f2',
                                }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '0.4rem' }}>
                                        <span style={{
                                            fontSize: '0.85rem',
                                            fontWeight: 800,
                                            color: validationSummary.isPublishable ? '#15803d' : '#dc2626',
                                        }}>
                                            배포 체크
                                        </span>
                                        <span style={{ fontSize: '0.76rem', color: '#64748b', fontWeight: 700 }}>
                                            {validationSummary.answeredCount}/{validationSummary.totalQuestions} 정답 · 총점 {validationSummary.totalScore}점
                                        </span>
                                    </div>
                                    {[...validationSummary.errors, ...validationSummary.warnings].slice(0, 3).map(item => (
                                        <div key={item.code} style={{
                                            fontSize: '0.78rem',
                                            color: item.severity === 'error' ? '#dc2626' : '#b45309',
                                            lineHeight: 1.45,
                                            fontWeight: 700,
                                        }}>
                                            {item.message}
                                        </div>
                                    ))}
                                    {onAutoMatchRegions && validationSummary.warnings.some(w => w.code === 'pdf_regions_incomplete') && (
                                        <button
                                            type="button"
                                            onClick={onAutoMatchRegions}
                                            style={{
                                                marginTop: '0.6rem',
                                                padding: '0.45rem 0.75rem',
                                                fontSize: '0.74rem',
                                                fontWeight: 800,
                                                borderRadius: '6px',
                                                border: '1px solid #fcd34d',
                                                background: '#fffbeb',
                                                color: '#b45309',
                                                cursor: 'pointer',
                                            }}
                                        >
                                            지금 자동 매칭 · 필기 수집 영역 채우기
                                        </button>
                                    )}
                                    {validationSummary.errors.length === 0 && validationSummary.warnings.length === 0 && (
                                        <div style={{ fontSize: '0.78rem', color: '#15803d', lineHeight: 1.45, fontWeight: 700 }}>
                                            필수 항목이 모두 준비됐습니다.
                                        </div>
                                    )}
                                </div>
                            )}

                            <div style={{ marginBottom: '1.5rem' }}>
                                <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 600 }}>접근 권한 설정</label>
                                <div className="distribute-access-options">
                                    <label className="distribute-access-option">
                                        <input type="radio" name="access" checked={accessType === 'public'} disabled={distributionRosterReadOnly} onChange={() => setAccessType('public')} />
                                        전체 공개 (링크 공유)
                                    </label>
                                    <label className="distribute-access-option">
                                        <input type="radio" name="access" checked={accessType === 'group'} disabled={distributionRosterReadOnly} onChange={() => setAccessType('group')} />
                                        특정 그룹만
                                    </label>
                                    <label className="distribute-access-option">
                                        <input type="radio" name="access" checked={accessType === 'student'} disabled={distributionRosterReadOnly} onChange={() => setAccessType('student')} />
                                        개별 학생
                                    </label>
                                </div>
                            </div>

                            {accessType === 'public' && (
                                <div style={{ marginBottom: '1.5rem' }}>
                                    <label htmlFor="distribute-pin" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                                        <Lock size={14} />
                                        PIN (선택)
                                    </label>
                                    <input
                                        id="distribute-pin"
                                        type="text"
                                        inputMode="numeric"
                                        pattern="[0-9]{4,6}"
                                        maxLength={6}
                                        disabled={distributionRosterReadOnly}
                                        placeholder="예: 1234 (4~6자리 숫자)"
                                        value={pin}
                                        onChange={(e) => setPin(normalizeExamPin(e.target.value))}
                                        style={{
                                            width: '100%',
                                            padding: '0.6rem 0.8rem',
                                            borderRadius: '6px',
                                            border: '1px solid #e5e7eb',
                                            fontSize: '0.95rem',
                                            letterSpacing: '2px',
                                        }}
                                    />
                                    <p style={{ fontSize: '0.8rem', color: '#666', marginTop: '0.4rem' }}>
                                        응시자가 PIN을 입력해야 시험에 접근할 수 있습니다.
                                    </p>
                                </div>
                            )}

                            {accessType === 'group' && (
                                <div style={{ marginBottom: '1.5rem', background: 'var(--background)', border: '1px solid var(--border)', padding: '1rem', borderRadius: '8px' }}>
                                    {isRotatingExistingGroupInvite && (
                                        <div role="status" style={{ marginBottom: '0.85rem', padding: '0.75rem', borderRadius: '8px', border: '1px solid #fcd34d', background: '#fffbeb', color: '#92400e', fontSize: '0.8rem', fontWeight: 750, lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                            새 링크를 발급하면 기존 링크와 QR은 즉시 무효화됩니다. 학생에게 새 링크와 QR을 다시 전달해야 합니다.
                                        </div>
                                    )}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.6rem' }}>
                                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)', margin: 0 }}>응시할 그룹 선택:</p>
                                        <button
                                            type="button"
                                            onClick={() => { setShowNewGroup(v => !v); setFormError(""); }}
                                            disabled={distributionRosterReadOnly}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem', fontSize: '0.78rem', fontWeight: 700, borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--foreground)', cursor: 'pointer' }}
                                        >
                                            <Plus size={13} /> 새 반
                                        </button>
                                    </div>

                                    {isRosterLoading && (
                                        <div role="status" style={{ marginBottom: '0.65rem', fontSize: '0.8rem', color: 'var(--muted)' }}>
                                            서버 명단을 불러오는 중입니다.
                                        </div>
                                    )}
                                    {rosterLoadError && (
                                        <div role="status" style={{ marginBottom: '0.65rem', fontSize: '0.78rem', color: 'var(--warning)', lineHeight: 1.45 }}>
                                            {rosterLoadError}
                                        </div>
                                    )}

                                    {showNewGroup && (
                                        <div style={{ marginBottom: '0.75rem', padding: '0.75rem', borderRadius: '8px', border: '1px dashed var(--border)', background: 'var(--surface)' }}>
                                            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem', flexWrap: 'wrap' }}>
                                                <input
                                                    aria-label="새 반 이름"
                                                    disabled={distributionRosterReadOnly}
                                                    value={newGroupName}
                                                    onChange={e => setNewGroupName(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup(); } }}
                                                    placeholder="반 이름 (예: 3학년 A반)"
                                                    autoFocus
                                                    style={{ flex: '2 1 140px', padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.85rem' }}
                                                />
                                                <input
                                                    aria-label="새 반 지역"
                                                    disabled={distributionRosterReadOnly}
                                                    value={newGroupRegion}
                                                    onChange={e => setNewGroupRegion(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup(); } }}
                                                    placeholder="지역(선택)"
                                                    style={{ flex: '1 1 90px', padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.85rem' }}
                                                />
                                            </div>
                                            <button
                                                type="button"
                                                disabled={distributionRosterReadOnly}
                                                onClick={handleCreateGroup}
                                                className="btn btn-primary"
                                                style={{ width: '100%', padding: '0.5rem', fontSize: '0.82rem' }}
                                            >
                                                반 만들고 대상으로 선택
                                            </button>
                                        </div>
                                    )}

                                    {groups.length === 0 && !showNewGroup ? (
                                        <div style={{ fontSize: '0.85rem', color: 'var(--muted)', lineHeight: 1.5, wordBreak: 'keep-all' }}>
                                            {distributionRosterReadOnly
                                                ? "저장된 반이 없습니다. 최신 서버 명단을 다시 불러오세요."
                                                : <><strong style={{ color: 'var(--foreground)' }}>새 반</strong> 버튼으로 이 화면에서 바로 반을 만들고 학생을 추가할 수 있습니다.</>}
                                        </div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem', maxHeight: '220px', overflowY: 'auto' }}>
                                            {groups.map(g => {
                                                const isSelected = selectedGroups.includes(g.id);
                                                const isAddingStudent = studentFormGroupId === g.id;
                                                const memberCount = countDistributionGroupMembers(g, students);
                                                return (
                                                    <div key={g.id} style={{ borderRadius: '8px', border: isSelected ? '1px solid rgba(99,102,241,0.35)' : '1px solid transparent', background: isSelected ? 'rgba(99,102,241,0.05)' : 'transparent', padding: '0.35rem 0.45rem' }}>
                                                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
                                                            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, cursor: 'pointer', minWidth: 0 }}>
                                                                <input
                                                                    type="checkbox"
                                                                    checked={isSelected}
                                                                    disabled={distributionRosterReadOnly}
                                                                    onChange={() => toggleGroup(g.id)}
                                                                />
                                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {formatRegionScopedLabel(g.name, g.region)}
                                                                </span>
                                                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0 }}>{memberCount}명</span>
                                                            </label>
                                                            <button
                                                                type="button"
                                                                disabled={distributionRosterReadOnly}
                                                                onClick={() => {
                                                                    setStudentFormGroupId(prev => prev === g.id ? null : g.id);
                                                                    setNewStudentName("");
                                                                    setNewStudentEmail("");
                                                                    setFormError("");
                                                                }}
                                                                aria-label={`${g.name} 학생 추가`}
                                                                style={{ display: 'inline-flex', alignItems: 'center', gap: '0.25rem', padding: '0.25rem 0.5rem', fontSize: '0.74rem', fontWeight: 700, borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--foreground)', cursor: 'pointer', flexShrink: 0 }}
                                                            >
                                                                <UserPlus size={12} /> 학생
                                                            </button>
                                                        </div>
                                                        {isAddingStudent && (
                                                            <div style={{ display: 'flex', gap: '0.4rem', marginTop: '0.45rem', flexWrap: 'wrap' }}>
                                                                <input
                                                                    aria-label="학생 이름"
                                                                    disabled={distributionRosterReadOnly}
                                                                    value={newStudentName}
                                                                    onChange={e => setNewStudentName(e.target.value)}
                                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStudent(g.id); } }}
                                                                    placeholder="이름"
                                                                    style={{ flex: '1 1 80px', padding: '0.45rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.82rem' }}
                                                                />
                                                                <input
                                                                    aria-label="학생 이메일"
                                                                    type="email"
                                                                    disabled={distributionRosterReadOnly}
                                                                    value={newStudentEmail}
                                                                    onChange={e => setNewStudentEmail(e.target.value)}
                                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStudent(g.id); } }}
                                                                    placeholder="이메일"
                                                                    style={{ flex: '1.4 1 120px', padding: '0.45rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.82rem' }}
                                                                />
                                                                <button
                                                                    type="button"
                                                                    disabled={distributionRosterReadOnly}
                                                                    onClick={() => handleAddStudent(g.id)}
                                                                    style={{ padding: '0.45rem 0.7rem', fontSize: '0.78rem', fontWeight: 700, borderRadius: '6px', border: 'none', background: 'var(--primary)', color: 'white', cursor: 'pointer', flexShrink: 0 }}
                                                                >
                                                                    추가
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                    {selectedGroups.length > 0 && (
                                        <div
                                            aria-label="그룹 배포 대상 요약"
                                            style={{
                                                marginTop: '0.85rem',
                                                padding: '0.75rem',
                                                borderRadius: '8px',
                                                border: targetSummary.targetStudentCount > 0 ? '1px solid rgba(16,185,129,0.22)' : '1px solid rgba(245,158,11,0.28)',
                                                background: targetSummary.targetStudentCount > 0 ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.1)',
                                            }}
                                        >
                                            <div style={{
                                                fontSize: '0.78rem',
                                                fontWeight: 900,
                                                color: targetSummary.targetStudentCount > 0 ? 'var(--success)' : 'var(--warning)',
                                                marginBottom: '0.25rem',
                                            }}>
                                                명단 기준 대상 {targetSummary.targetStudentCount}명
                                            </div>
                                            <div style={{ fontSize: '0.74rem', color: 'var(--muted)', lineHeight: 1.45, wordBreak: 'keep-all' }}>
                                                {targetSummary.targetStudentCount > 0
                                                    ? `${targetSummary.selectedGroupNames.join(", ")} 학생에게 배포되는 설정입니다.`
                                                    : targetSummary.hasRoster
                                                        ? "선택한 그룹에 연결된 학생 명단이 없습니다. 링크는 만들 수 있지만 미응시/카카오 후보 산정이 제한됩니다."
                                                        : "학생 명단이 아직 없습니다. 링크는 만들 수 있지만 미응시/카카오 후보 산정은 명단 등록 후 정확해집니다."}
                                                {targetSummary.missingGroupIds.length > 0 ? ` 누락 그룹: ${targetSummary.missingGroupIds.join(", ")}` : ""}
                                            </div>
                                        </div>
                                    )}
                                </div>
                            )}

                            {accessType === 'student' && (
                                <div style={{ marginBottom: '1.5rem', background: 'var(--background)', border: '1px solid var(--border)', padding: '1rem', borderRadius: '8px' }}>
                                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.75rem' }}>
                                        <label style={{ flex: 1, fontSize: '0.82rem', fontWeight: 700 }}>
                                            배정 유형
                                            <select
                                                aria-label="배정 유형"
                                                disabled={distributionRosterReadOnly}
                                                value={assignmentMode}
                                                onChange={event => setAssignmentMode(
                                                    retakeAssignmentsEnabled && event.target.value === "retake" ? "retake" : "base"
                                                )}
                                                style={{ width: '100%', marginTop: '0.35rem', padding: '0.55rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--surface)', color: 'var(--foreground)' }}
                                            >
                                                <option value="base">시험 배정</option>
                                                {retakeAssignmentsEnabled && <option value="retake">재시험 배정</option>}
                                            </select>
                                        </label>
                                    </div>
                                    {!retakeAssignmentsEnabled && (
                                        <p style={{ margin: '-0.35rem 0 0.75rem', color: 'var(--muted)', fontSize: '0.76rem' }}>
                                            재시험 배정은 Pro 플랜에서 사용할 수 있습니다.
                                        </p>
                                    )}
                                    <label htmlFor="individual-student-search" style={{ display: 'block', fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.35rem' }}>학생 검색</label>
                                    <input
                                        id="individual-student-search"
                                        disabled={distributionRosterReadOnly}
                                        value={studentSearch}
                                        onChange={event => setStudentSearch(event.target.value)}
                                        placeholder="이름, 반, 지역, 이메일"
                                        style={{ width: '100%', padding: '0.6rem 0.7rem', border: '1px solid var(--border)', borderRadius: '6px', background: 'var(--surface)', color: 'var(--foreground)', marginBottom: '0.7rem' }}
                                    />
                                    {(rosterLoadError || assignmentLoadError) && (
                                        <div role="status" style={{ color: 'var(--warning)', fontSize: '0.78rem', marginBottom: '0.6rem' }}>
                                            {assignmentLoadError || rosterLoadError}
                                        </div>
                                    )}
                                    <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                                        {visibleStudents.map(student => (
                                            <label key={student.id} style={{ display: 'flex', alignItems: 'center', gap: '0.55rem', padding: '0.55rem', border: '1px solid var(--border)', borderRadius: '6px', cursor: 'pointer' }}>
                                                <input
                                                    type="checkbox"
                                                    checked={selectedStudentIds.includes(student.id)}
                                                    disabled={distributionRosterReadOnly}
                                                    onChange={() => setSelectedStudentIds(current => current.includes(student.id)
                                                        ? current.filter(id => id !== student.id)
                                                        : [...current, student.id])}
                                                />
                                                <span style={{ flex: 1, minWidth: 0 }}>
                                                    <strong>{student.name}</strong>
                                                    <span style={{ marginLeft: '0.4rem', color: 'var(--muted)', fontSize: '0.75rem' }}>{formatRegionScopedLabel(student.group, student.region)}</span>
                                                </span>
                                            </label>
                                        ))}
                                        {!isRosterLoading && visibleStudents.length === 0 && (
                                            <div style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>검색 조건에 맞는 활성 학생이 없습니다.</div>
                                        )}
                                    </div>
                                    <div aria-label="선택한 학생 요약" style={{ marginTop: '0.75rem', padding: '0.65rem', borderRadius: '6px', background: 'rgba(99,102,241,0.08)', color: 'var(--foreground)', fontSize: '0.8rem', fontWeight: 800 }}>
                                        선택한 학생 {selectedStudentIds.length}명 · 최대 100명
                                    </div>
                                </div>
                            )}

                            <button
                                type="button"
                                onClick={handleShareClick}
                                className="btn btn-primary distribute-dialog-primary-action"
                                style={{ width: '100%', padding: '0.8rem' }}
                                disabled={distributionRosterReadOnly || isSaving || isAssignmentLoading || inviteLifecycleBlocksIssuance || (validationSummary ? !validationSummary.isPublishable : false)}
                            >
                                {isSaving
                                    ? "생성 중..."
                                    : accessType === "student"
                                        ? assignmentMode === "retake" ? "재시험 배정하기" : "선택한 학생에게 배정하기"
                                    : isGroupReissue
                                        ? "새 링크 발급하기"
                                        : "링크 생성하기"}
                            </button>
                            {formError && (
                                <div
                                    role="alert"
                                    style={{
                                        marginTop: '0.8rem',
                                        padding: '0.75rem 0.9rem',
                                        borderRadius: '8px',
                                        background: '#fef2f2',
                                        border: '1px solid #fecaca',
                                        color: '#dc2626',
                                        fontSize: '0.85rem',
                                        fontWeight: 700,
                                        lineHeight: 1.5,
                                    }}
                                >
                                    {formError}
                                    {accessType === "student" && (
                                        <button type="button" onClick={handleShareClick} style={{ marginLeft: '0.5rem', border: 0, background: 'transparent', color: 'inherit', fontWeight: 900, textDecoration: 'underline', cursor: 'pointer' }}>
                                            다시 시도
                                        </button>
                                    )}
                                </div>
                            )}
                        </>
                    ) : (
                        <div style={{ textAlign: 'center' }}>
                            {/* Celebration Header */}
                            <div style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.45rem',
                                padding: '0.4rem 0.9rem',
                                borderRadius: 'var(--radius-full)',
                                background: 'rgba(16, 185, 129, 0.1)',
                                border: '1px solid rgba(16, 185, 129, 0.25)',
                                color: 'var(--success)',
                                fontSize: '0.82rem',
                                fontWeight: 800,
                                marginBottom: '0.75rem',
                            }}>
                                <Sparkles size={14} /> 시험 배포 준비 완료!
                            </div>
                            <h3 style={{ fontSize: '1.25rem', fontWeight: 800, color: 'var(--foreground)', marginBottom: '0.35rem' }}>
                                학생 응시 링크가 발급되었습니다
                            </h3>
                            <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: '1.25rem', wordBreak: 'keep-all' }}>
                                QR 코드를 화면에 띄우거나, 링크 또는 안내 문구를 복사하여 학생들에게 전달하세요.
                            </p>

                            {!isShareUrlReachableByStudents(visibleShareUrl) && (
                                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.5, marginBottom: '1.25rem', textAlign: 'left' }}>
                                    ⚠️ 이 링크는 이 컴퓨터에서만 열립니다. 학생들이 다른 기기에서 접속하려면 공개 주소(NEXT_PUBLIC_SHARE_BASE_URL)를 설정해야 합니다.
                                </div>
                            )}

                            {/* QR Frame */}
                            <div style={{
                                display: 'inline-block',
                                padding: '1rem',
                                background: 'white',
                                borderRadius: '16px',
                                border: '1px solid var(--border)',
                                boxShadow: '0 8px 24px rgba(0,0,0,0.06)',
                                marginBottom: '1.25rem',
                            }}>
                                <QRCodeCanvas id="qr-code-canvas" value={visibleShareUrl} size={200} level={"H"} includeMargin={true} />
                            </div>

                            <div className="distribute-share-actions" style={{ marginBottom: '1rem', display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                <button
                                    type="button"
                                    onClick={copyShareLink}
                                    className="btn btn-primary"
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                                >
                                    {copyStatus === "복사됨" ? <Check size={15} /> : <Copy size={15} />}
                                    {copyStatus === "복사됨" ? "복사 완료!" : "링크 복사"}
                                </button>
                                <button
                                    type="button"
                                    onClick={copyGuideMessage}
                                    className="btn btn-secondary"
                                    style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}
                                >
                                    <Share2 size={15} /> 안내 문구 복사
                                </button>
                                <button type="button" onClick={downloadQR} className="btn btn-secondary">
                                    QR 저장
                                </button>
                                {accessType === "group" && examId && (
                                    <button
                                        type="button"
                                        onClick={revokeGroupInvite}
                                        disabled={isInviteRevoking || distributionRosterReadOnly}
                                        className="btn btn-secondary"
                                    >
                                        {isInviteRevoking ? "해지 중..." : "링크 해지"}
                                    </button>
                                )}
                            </div>

                            <div
                                data-testid="distribution-share-url"
                                style={{ background: 'var(--background)', border: '1px solid var(--border)', padding: '0.6rem 0.75rem', borderRadius: '8px', fontSize: '0.8rem', wordBreak: 'break-all', color: 'var(--muted)', marginBottom: '1.25rem' }}
                            >
                                {visibleShareUrl}
                            </div>

                            {shareExpiresAt && (
                                <div role="status" style={{ background: '#fffbeb', border: '1px solid #fcd34d', padding: '0.7rem 0.85rem', borderRadius: '6px', color: '#92400e', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.5, marginBottom: '1.25rem' }}>
                                    링크 만료 시각: {new Date(shareExpiresAt).toLocaleString('ko-KR')}
                                </div>
                            )}

                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, marginBottom: '1.25rem', wordBreak: 'keep-all' }}>
                                설치 앱 또는 웹 브라우저에서 열리는 응시 링크입니다. 학생 앱 로그인이 있으면 학생으로, 없으면 확인 화면에서 게스트로 입장합니다.
                            </p>

                            {examId && (
                                <div style={{ display: 'flex', gap: '0.6rem', justifyContent: 'center', flexWrap: 'wrap', marginTop: '0.5rem' }}>
                                    <a
                                        href={`/teacher/live?examId=${examId}`}
                                        className="btn btn-secondary"
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '0.4rem',
                                            fontSize: '0.85rem',
                                            padding: '0.6rem 1.1rem',
                                            borderRadius: 'var(--radius-full)',
                                        }}
                                    >
                                        <Radio size={14} color="var(--error)" />
                                        실시간 응시 모니터링
                                    </a>
                                    <a
                                        href={`/teacher/dashboard?tab=exam&examId=${examId}`}
                                        style={{
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: '0.4rem',
                                            fontSize: '0.85rem',
                                            fontWeight: 700,
                                            color: 'var(--primary)',
                                            textDecoration: 'none',
                                            padding: '0.6rem 1.1rem',
                                            borderRadius: 'var(--radius-full)',
                                            border: '1px solid rgba(99,102,241,0.28)',
                                            background: 'rgba(99,102,241,0.07)',
                                            transition: 'all 0.15s',
                                        }}
                                    >
                                        결과 분석 보러 가기 →
                                    </a>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
