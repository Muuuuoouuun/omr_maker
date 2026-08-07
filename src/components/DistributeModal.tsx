"use client";

import { useMemo, useState, useEffect, useId, useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Lock, Plus, UserPlus } from 'lucide-react';
import type { Exam } from '@/types/omr';
import { formatRegionScopedLabel } from '@/lib/dashboardSelection';
import type { ExamValidationSummary } from '@/lib/examValidation';
import { isValidExamPin, normalizeExamPin } from '@/lib/examAccess';
import { readRosterGroups, readRosterInvites, readRosterStudents, type RosterGroup, type RosterInvite, type RosterStudent } from '@/lib/rosterStorage';
import { countDistributionGroupMembers, summarizeDistributionTargets } from '@/lib/distributionTargets';
import { isShareUrlReachableByStudents } from '@/lib/shareLink';
import { addRosterGroup, addRosterStudent } from '@/lib/rosterMutations';
import { loadTeacherRosterSnapshot, saveTeacherRosterSnapshot } from '@/lib/teacherRosterClient';
import { toast } from '@/components/Toast';
import { useDialogFocus } from '@/hooks/useDialogFocus';
import {
    confirmExistingGroupInviteRotation,
    normalizeDistributionShareResult,
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

type AccessConfig = NonNullable<Exam["accessConfig"]>;

interface DistributeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaveAndShare: (config: AccessConfig) => Promise<DistributionShareResultLike>;
    onAssignStudents: (input: SaveTeacherIndividualAssignmentInput) => Promise<SaveTeacherIndividualAssignmentResult | { status: "local_only" }>;
    onClearStudentAssignment: (input: ClearTeacherIndividualAssignmentInput) => Promise<ClearTeacherIndividualAssignmentResult | { status: "local_only" }>;
    onLoadStudentAssignment: (examId: string) => Promise<LoadTeacherIndividualAssignmentResult | { status: "local_only" }>;
    retakeAssignmentsEnabled: boolean;
    onAutoMatchRegions?: () => void;
    validationSummary?: ExamValidationSummary;
    initialAccessConfig?: AccessConfig;
    initialShareUrl?: string;
    initialShareExpiresAt?: string;
    examId?: string;
    isExistingExam?: boolean;
}

export default function DistributeModal({ isOpen, onClose, onSaveAndShare, onAssignStudents, onClearStudentAssignment, onLoadStudentAssignment, retakeAssignmentsEnabled, onAutoMatchRegions, validationSummary, initialAccessConfig, initialShareUrl, initialShareExpiresAt, examId, isExistingExam = false }: DistributeModalProps) {
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
    const [selectedStudentIds, setSelectedStudentIds] = useState<string[]>([]);
    const [studentSearch, setStudentSearch] = useState("");
    const [assignmentMode, setAssignmentMode] = useState<"base" | "retake">("base");
    const [assignmentRevision, setAssignmentRevision] = useState(0);
    const [assignmentLoadError, setAssignmentLoadError] = useState("");
    const [isAssignmentLoading, setIsAssignmentLoading] = useState(false);
    const wasOpenRef = useRef(false);
    const rosterLoadGenerationRef = useRef(0);
    const copyResetTimerRef = useRef<number | undefined>(undefined);
    const dialogRef = useDialogFocus(isOpen, onClose);
    const dialogTitleId = useId();

    useEffect(() => () => {
        if (copyResetTimerRef.current !== undefined) {
            window.clearTimeout(copyResetTimerRef.current);
        }
    }, []);

    useEffect(() => {
        const loadGeneration = ++rosterLoadGenerationRef.current;
        if (!isOpen) {
            setIsRosterLoading(false);
            setRosterLoadError("");
            return;
        }

        try {
            setGroups(readRosterGroups(localStorage));
            setStudents(readRosterStudents(localStorage));
        } catch {
            setGroups([]);
            setStudents([]);
        }

        setIsRosterLoading(true);
        setRosterLoadError("");
        void loadTeacherRosterSnapshot(localStorage)
            .then(snapshot => {
                if (rosterLoadGenerationRef.current !== loadGeneration) return;
                setGroups(snapshot.groups);
                setStudents(snapshot.students);
                if (snapshot.remoteError) {
                    setRosterLoadError("서버 명단을 불러오지 못해 이 기기에 저장된 명단을 표시합니다.");
                }
            })
            .catch(() => {
                if (rosterLoadGenerationRef.current !== loadGeneration) return;
                setRosterLoadError("서버 명단을 불러오지 못해 이 기기에 저장된 명단을 표시합니다.");
            })
            .finally(() => {
                if (rosterLoadGenerationRef.current === loadGeneration) {
                    setIsRosterLoading(false);
                }
            });

        return () => {
            if (rosterLoadGenerationRef.current === loadGeneration) {
                rosterLoadGenerationRef.current += 1;
            }
        };
    }, [isOpen]);

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
        setIsAssignmentLoading(true);
        void onLoadStudentAssignment(examId).then(result => {
            if (cancelled) return;
            if (result.status === "loaded") {
                setAccessType("student");
                setSelectedStudentIds(result.targetStudentIds);
                setAssignmentMode(result.mode === "retake" && !retakeAssignmentsEnabled ? "base" : result.mode);
                setAssignmentRevision(result.revision);
            } else if (result.status !== "not_found" && result.status !== "local_only") {
                setAssignmentLoadError("기존 개별 배정 상태를 불러오지 못했습니다. 다시 시도해주세요.");
            }
        }).catch(() => {
            if (!cancelled) setAssignmentLoadError("기존 개별 배정 상태를 불러오지 못했습니다. 다시 시도해주세요.");
        }).finally(() => {
            if (!cancelled) setIsAssignmentLoading(false);
        });
        return () => { cancelled = true; };
    }, [examId, isOpen, onLoadStudentAssignment, retakeAssignmentsEnabled]);

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

    if (!isOpen) return null;

    const reloadConflictedAssignment = async (targetExamId: string) => {
        const latest = await reloadLatestAssignmentAfterConflict(targetExamId, onLoadStudentAssignment);
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

        try {
            if (accessType === "student") {
                setIsSaving(true);
                let shareResult = examId ? null : normalizeDistributionShareResult(await onSaveAndShare(config));
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
                if (assigned.status !== "saved") {
                    if (assigned.status === "conflict") {
                        const reloaded = await reloadConflictedAssignment(targetExamId);
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
                if (!shareResult.shareUrl) {
                    setFormError("개별 배정은 저장됐지만 시험 편집 내용 저장에 실패했습니다. 다시 시도해주세요.");
                    return;
                }
                const targetedUrl = new URL(shareResult.shareUrl, window.location.origin);
                targetedUrl.searchParams.set("assignment", assigned.assignmentId);
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
                if (cleared.status !== "cleared") {
                    if (cleared.status === "conflict") {
                        const reloaded = await reloadConflictedAssignment(examId);
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
                needsConfirmation: isRotatingExistingGroupInvite,
                confirm: message => window.confirm(message),
                rotateAndSave: async () => {
                    setIsSaving(true);
                    return onSaveAndShare(config);
                },
            });
            if (outcome.status === "cancelled") return;
            const shareResult = normalizeDistributionShareResult(outcome.result);
            if (!shareResult.shareUrl) {
                setFormError("링크 생성에 실패했습니다. 배포 체크와 저장 상태를 확인한 뒤 다시 시도해주세요.");
                return;
            }
            setShareUrl(shareResult.shareUrl);
            setShareExpiresAt(shareResult.expiresAt || null);
        } catch {
            setFormError("링크 생성에 실패했습니다. 시험 저장 상태를 확인한 뒤 다시 시도해주세요.");
        } finally {
            setIsSaving(false);
        }
    };

    const copyShareLink = async () => {
        if (!shareUrl) return;
        if (copyResetTimerRef.current !== undefined) {
            window.clearTimeout(copyResetTimerRef.current);
            copyResetTimerRef.current = undefined;
        }
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopyStatus("복사됨");
            copyResetTimerRef.current = window.setTimeout(() => {
                copyResetTimerRef.current = undefined;
                setCopyStatus("");
            }, 1600);
        } catch {
            setCopyStatus("복사 실패");
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

    // Write the full roster snapshot through (preserving invites) and reflect it locally.
    const persistRoster = (nextStudents: RosterStudent[], nextGroups: RosterGroup[]) => {
        const previousStudents = students;
        const previousGroups = groups;
        setStudents(nextStudents);
        setGroups(nextGroups);
        let invites: RosterInvite[];
        try {
            invites = readRosterInvites(localStorage);
        } catch {
            invites = [];
        }
        void saveTeacherRosterSnapshot(localStorage, { students: nextStudents, groups: nextGroups, invites })
            .then(result => {
                if (result.remoteError && !result.localSaved) {
                    setStudents(previousStudents);
                    setGroups(previousGroups);
                    toast.error("명단 저장 실패", "서버에 저장되지 않아 방금 변경을 되돌렸습니다.");
                }
            })
            .catch(() => {
                toast.error("명단 저장 실패", "브라우저 저장소 권한을 확인해주세요.");
            });
    };

    const handleCreateGroup = () => {
        if (isRosterLoading) {
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
        if (isRosterLoading) {
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
                    {!shareUrl ? (
                        <>
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
                                        <input type="radio" name="access" checked={accessType === 'public'} onChange={() => setAccessType('public')} />
                                        전체 공개 (링크 공유)
                                    </label>
                                    <label className="distribute-access-option">
                                        <input type="radio" name="access" checked={accessType === 'group'} onChange={() => setAccessType('group')} />
                                        특정 그룹만
                                    </label>
                                    <label className="distribute-access-option">
                                        <input type="radio" name="access" checked={accessType === 'student'} onChange={() => setAccessType('student')} />
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
                                            disabled={isRosterLoading}
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
                                                    value={newGroupName}
                                                    onChange={e => setNewGroupName(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup(); } }}
                                                    placeholder="반 이름 (예: 3학년 A반)"
                                                    autoFocus
                                                    style={{ flex: '2 1 140px', padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.85rem' }}
                                                />
                                                <input
                                                    aria-label="새 반 지역"
                                                    value={newGroupRegion}
                                                    onChange={e => setNewGroupRegion(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleCreateGroup(); } }}
                                                    placeholder="지역(선택)"
                                                    style={{ flex: '1 1 90px', padding: '0.5rem 0.7rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.85rem' }}
                                                />
                                            </div>
                                            <button
                                                type="button"
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
                                            아직 만든 반이 없습니다. <strong style={{ color: 'var(--foreground)' }}>새 반</strong> 버튼으로 이 화면에서 바로 반을 만들고 학생을 추가할 수 있습니다.
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
                                                                    onChange={() => toggleGroup(g.id)}
                                                                />
                                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                                    {formatRegionScopedLabel(g.name, g.region)}
                                                                </span>
                                                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0 }}>{memberCount}명</span>
                                                            </label>
                                                            <button
                                                                type="button"
                                                                disabled={isRosterLoading}
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
                                                                    value={newStudentName}
                                                                    onChange={e => setNewStudentName(e.target.value)}
                                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStudent(g.id); } }}
                                                                    placeholder="이름"
                                                                    style={{ flex: '1 1 80px', padding: '0.45rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.82rem' }}
                                                                />
                                                                <input
                                                                    aria-label="학생 이메일"
                                                                    type="email"
                                                                    value={newStudentEmail}
                                                                    onChange={e => setNewStudentEmail(e.target.value)}
                                                                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddStudent(g.id); } }}
                                                                    placeholder="이메일"
                                                                    style={{ flex: '1.4 1 120px', padding: '0.45rem 0.6rem', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '0.82rem' }}
                                                                />
                                                                <button
                                                                    type="button"
                                                                    disabled={isRosterLoading}
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
                                onClick={handleShareClick}
                                className="btn btn-primary distribute-dialog-primary-action"
                                style={{ width: '100%', padding: '0.8rem' }}
                                disabled={isSaving || isAssignmentLoading || (validationSummary ? !validationSummary.isPublishable : false)}
                            >
                                {isSaving
                                    ? "생성 중..."
                                    : accessType === "student"
                                        ? assignmentMode === "retake" ? "재시험 배정하기" : "선택한 학생에게 배정하기"
                                    : isRotatingExistingGroupInvite
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
                            {!isShareUrlReachableByStudents(shareUrl) && (
                                <div style={{ background: '#fef2f2', border: '1px solid #fecaca', color: '#b91c1c', padding: '0.75rem 1rem', borderRadius: 'var(--radius-md)', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.5, marginBottom: '1.25rem', textAlign: 'left' }}>
                                    ⚠️ 이 링크는 이 컴퓨터에서만 열립니다. 학생들이 다른 기기에서 접속하려면 공개 주소(NEXT_PUBLIC_SHARE_BASE_URL)를 설정해야 합니다.
                                </div>
                            )}
                            <div style={{ marginBottom: '1.5rem' }}>
                                <QRCodeCanvas id="qr-code-canvas" value={shareUrl} size={200} level={"H"} includeMargin={true} />
                            </div>

                            <div className="distribute-share-actions">
                                <button onClick={downloadQR} className="btn btn-secondary">QR 저장</button>
                                <button onClick={copyShareLink} className="btn btn-primary">
                                    {copyStatus || "링크 복사"}
                                </button>
                            </div>

                            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', padding: '0.5rem', borderRadius: '4px', fontSize: '0.8rem', wordBreak: 'break-all', color: 'var(--muted)', marginBottom: '1.25rem' }}>
                                {shareUrl}
                            </div>

                            {shareExpiresAt && (
                                <div role="status" style={{ background: '#fffbeb', border: '1px solid #fcd34d', padding: '0.7rem 0.85rem', borderRadius: '6px', color: '#92400e', fontSize: '0.82rem', fontWeight: 700, lineHeight: 1.5, marginBottom: '1.25rem' }}>
                                    링크 만료 시각: {new Date(shareExpiresAt).toLocaleString('ko-KR')}
                                </div>
                            )}

                            <p style={{ fontSize: '0.82rem', color: 'var(--muted)', lineHeight: 1.55, marginBottom: '1rem', wordBreak: 'keep-all' }}>
                                설치 앱 또는 웹 브라우저에서 열리는 응시 링크입니다. 학생 앱 로그인이 있으면 학생으로, 없으면 확인 화면에서 게스트로 입장합니다.
                            </p>

                            {examId && (
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
                                        padding: '0.6rem 1rem',
                                        borderRadius: 'var(--radius-full)',
                                        border: '1px solid rgba(99,102,241,0.28)',
                                        background: 'rgba(99,102,241,0.07)',
                                        transition: 'border-color 0.15s, background-color 0.15s, color 0.15s, transform 0.15s',
                                    }}
                                >
                                    결과 분석 보러 가기 →
                                </a>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
