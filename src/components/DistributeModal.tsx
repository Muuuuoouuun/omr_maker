"use client";

import { useMemo, useState, useEffect, useRef } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Lock } from 'lucide-react';
import type { Exam } from '@/types/omr';
import { formatRegionScopedLabel } from '@/lib/dashboardSelection';
import type { ExamValidationSummary } from '@/lib/examValidation';
import { isValidExamPin, normalizeExamPin } from '@/lib/examAccess';
import { readRosterGroups, readRosterStudents, type RosterGroup, type RosterStudent } from '@/lib/rosterStorage';
import { summarizeDistributionTargets } from '@/lib/distributionTargets';

type AccessConfig = NonNullable<Exam["accessConfig"]>;

interface DistributeModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSaveAndShare: (config: AccessConfig) => Promise<string>; // Returns share URL
    onAutoMatchRegions?: () => void;
    validationSummary?: ExamValidationSummary;
    initialAccessConfig?: AccessConfig;
}

export default function DistributeModal({ isOpen, onClose, onSaveAndShare, onAutoMatchRegions, validationSummary, initialAccessConfig }: DistributeModalProps) {
    const [accessType, setAccessType] = useState<'public' | 'group'>('public');
    const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
    const [groups, setGroups] = useState<RosterGroup[]>([]);
    const [students, setStudents] = useState<RosterStudent[]>([]);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);
    const [pin, setPin] = useState("");
    const [formError, setFormError] = useState("");
    const [copyStatus, setCopyStatus] = useState("");
    const wasOpenRef = useRef(false);

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
    }, [isOpen, initialAccessConfig]);

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

    return (
        <div style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            zIndex: 1000
        }}>
            <div style={{
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
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>시험 배포하기</h2>
                    <button onClick={onClose} aria-label="닫기" style={{ border: 'none', background: 'none', color: 'var(--muted)', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
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
                                    <p style={{ fontSize: '0.9rem', marginBottom: '0.5rem', color: 'var(--muted)' }}>응시할 그룹 선택:</p>
                                    {groups.length === 0 ? (
                                        <div style={{ color: 'var(--error)', fontSize: '0.9rem', fontWeight: 700 }}>생성된 그룹이 없습니다. 그룹 메뉴에서 먼저 생성하세요.</div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '150px', overflowY: 'auto' }}>
                                            {groups.map(g => (
                                                <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedGroups.includes(g.id)}
                                                        onChange={() => toggleGroup(g.id)}
                                                    />
                                                    {formatRegionScopedLabel(g.name, g.region)}
                                                </label>
                                            ))}
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

                            <div style={{ background: 'var(--background)', border: '1px solid var(--border)', padding: '0.5rem', borderRadius: '4px', fontSize: '0.8rem', wordBreak: 'break-all', color: 'var(--muted)' }}>
                                {shareUrl}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
