"use client";

import { useMemo, useState, useEffect, useId, useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Lock, Plus, UserPlus } from 'lucide-react';
import type { Exam } from '@/types/omr';
import { formatRegionScopedLabel } from '@/lib/dashboardSelection';
import type { ExamValidationSummary } from '@/lib/examValidation';
import { isValidExamPin, normalizeExamPin } from '@/lib/examAccess';
import { readRosterGroups, readRosterInvites, readRosterStudents, type RosterGroup, type RosterInvite, type RosterStudent } from '@/lib/rosterStorage';
import { summarizeDistributionTargets } from '@/lib/distributionTargets';
import { addRosterGroup, addRosterStudent } from '@/lib/rosterMutations';
import { saveTeacherRosterSnapshot } from '@/lib/teacherRosterClient';
import { toast } from '@/components/Toast';

type AccessConfig = NonNullable<Exam["accessConfig"]>;

interface DistributeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaveAndShare: (config: AccessConfig) => Promise<string>; // Returns share URL
    onAutoMatchRegions?: () => void;
    validationSummary?: ExamValidationSummary;
    initialAccessConfig?: AccessConfig;
    examId?: string;
}

export default function DistributeModal({ isOpen, onClose, onSaveAndShare, onAutoMatchRegions, validationSummary, initialAccessConfig, examId }: DistributeModalProps) {
    const [accessType, setAccessType] = useState<'public' | 'group'>('public');
    const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
    const [groups, setGroups] = useState<RosterGroup[]>([]);
    const [students, setStudents] = useState<RosterStudent[]>([]);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
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
    const wasOpenRef = useRef(false);
    const dialogRef = useRef<HTMLDivElement>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const previouslyFocusedRef = useRef<HTMLElement | null>(null);
    const onCloseRef = useRef(onClose);
    const dialogTitleId = useId();

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    useEffect(() => {
        if (!isOpen) {
            wasOpenRef.current = false;
            return;
        }
        if (wasOpenRef.current) {
            return;
        }
        wasOpenRef.current = true;

        try {
            setGroups(readRosterGroups(localStorage));
            setStudents(readRosterStudents(localStorage));
        } catch {
            setGroups([]);
            setStudents([]);
        }
        const initialType = initialAccessConfig?.type === 'group' ? 'group' : 'public';

        setShareUrl(null);
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
    }, [isOpen, initialAccessConfig]);

    useEffect(() => {
        if (!isOpen) return;
        previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
            ? document.activeElement
            : null;
        const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                onCloseRef.current();
                return;
            }
            if (event.key !== 'Tab') return;

            const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
                'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            ) || []).filter(element => !element.hasAttribute('hidden'));
            if (focusable.length === 0) {
                event.preventDefault();
                dialogRef.current?.focus();
                return;
            }

            const first = focusable[0];
            const last = focusable[focusable.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            window.clearTimeout(focusTimer);
            document.removeEventListener('keydown', handleKeyDown);
            previouslyFocusedRef.current?.focus();
        };
    }, [isOpen]);

    const targetSummary = useMemo(() => summarizeDistributionTargets({
        selectedGroupIds: selectedGroups,
        groups,
        students,
    }), [groups, selectedGroups, students]);

    if (!isOpen) return null;

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

        if (accessType === 'public' && pin && !isValidExamPin(pin)) {
            setFormError("PIN은 4~6자리 숫자여야 합니다.");
            return;
        }

        const config = {
            type: accessType,
            groupIds: accessType === 'group' ? selectedGroups : undefined,
            pin: accessType === 'public' && pin ? pin : undefined,
        };

        setIsSaving(true);
        try {
            const url = await onSaveAndShare(config);
            if (!url) {
                setFormError("링크 생성에 실패했습니다. 배포 체크와 저장 상태를 확인한 뒤 다시 시도해주세요.");
                return;
            }
            setShareUrl(url);
        } catch {
            setFormError("링크 생성에 실패했습니다. 시험 저장 상태를 확인한 뒤 다시 시도해주세요.");
        } finally {
            setIsSaving(false);
        }
    };

    const copyShareLink = async () => {
        if (!shareUrl) return;
        try {
            await navigator.clipboard.writeText(shareUrl);
            setCopyStatus("복사됨");
            setTimeout(() => setCopyStatus(""), 1600);
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
            role="presentation"
            onMouseDown={(event) => {
                if (event.target === event.currentTarget) onClose();
            }}
            style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000
        }}>
            <div
                ref={dialogRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={dialogTitleId}
                tabIndex={-1}
                style={{
                background: 'var(--surface)',
                color: 'var(--foreground)',
                width: '500px',
                maxWidth: 'calc(100vw - 2rem)',
                borderRadius: '8px',
                display: 'flex', flexDirection: 'column',
                border: '1px solid var(--border)',
                boxShadow: '0 24px 60px rgba(0,0,0,0.22)'
            }}>
                <header style={{ padding: '1.5rem', borderBottom: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 id={dialogTitleId} style={{ fontSize: '1.25rem', fontWeight: 600 }}>시험 배포하기</h2>
                    <button
                        ref={closeButtonRef}
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

                <div style={{ padding: '2rem' }}>
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
                                <div style={{ display: 'flex', gap: '1rem' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                        <input type="radio" name="access" checked={accessType === 'public'} onChange={() => setAccessType('public')} />
                                        전체 공개 (링크 공유)
                                    </label>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                                        <input type="radio" name="access" checked={accessType === 'group'} onChange={() => setAccessType('group')} />
                                        특정 그룹만
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
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.6rem' }}>
                                        <p style={{ fontSize: '0.9rem', color: 'var(--muted)', margin: 0 }}>응시할 그룹 선택:</p>
                                        <button
                                            type="button"
                                            onClick={() => { setShowNewGroup(v => !v); setFormError(""); }}
                                            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.3rem', padding: '0.3rem 0.6rem', fontSize: '0.78rem', fontWeight: 700, borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--foreground)', cursor: 'pointer' }}
                                        >
                                            <Plus size={13} /> 새 반
                                        </button>
                                    </div>

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
                                                                <span style={{ fontSize: '0.72rem', color: 'var(--muted)', flexShrink: 0 }}>{g.count}명</span>
                                                            </label>
                                                            <button
                                                                type="button"
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

                            <button
                                onClick={handleShareClick}
                                className="btn btn-primary"
                                style={{ width: '100%', padding: '0.8rem' }}
                                disabled={isSaving || (validationSummary ? !validationSummary.isPublishable : false)}
                            >
                                {isSaving ? "생성 중..." : "링크 생성하기"}
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
                                </div>
                            )}
                        </>
                    ) : (
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ marginBottom: '1.5rem' }}>
                                <QRCodeCanvas id="qr-code-canvas" value={shareUrl} size={200} level={"H"} includeMargin={true} />
                            </div>

                            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginBottom: '1.5rem' }}>
                                <button onClick={downloadQR} className="btn btn-secondary">QR 저장</button>
                                <button onClick={copyShareLink} className="btn btn-primary">
                                    {copyStatus || "링크 복사"}
                                </button>
                            </div>

                            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', padding: '0.5rem', borderRadius: '4px', fontSize: '0.8rem', wordBreak: 'break-all', color: 'var(--muted)', marginBottom: '1.25rem' }}>
                                {shareUrl}
                            </div>

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
                                        transition: 'all 0.15s',
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
