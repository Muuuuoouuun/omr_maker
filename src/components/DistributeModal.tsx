"use client";

import { useState, useEffect } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Group } from '@/types/omr';
import { useRouter } from 'next/navigation';

interface DistributeModalProps {
    isOpen: boolean;
    onClose: () => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSaveAndShare: (config: any) => Promise<string>; // Returns share URL
    examTitle?: string;
}

export default function DistributeModal({ isOpen, onClose, onSaveAndShare, examTitle = "OMR-Maker 시험" }: DistributeModalProps) {
    const router = useRouter();
    const [accessType, setAccessType] = useState<'public' | 'group'>('public');
    const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

    // Time Limit States
    const [hasTimeLimit, setHasTimeLimit] = useState(false);
    const [timeLimit, setTimeLimit] = useState<number>(45);

    useEffect(() => {
        if (isOpen) {
            const storedGroups = localStorage.getItem('omr_groups');
            if (storedGroups) {
                setGroups(JSON.parse(storedGroups));
            }
            // Reset state
            setShareUrl(null);
            setAccessType('public');
            setSelectedGroups([]);
            setIsSaving(false);
            setHasTimeLimit(false);
            setTimeLimit(45);
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleShareClick = async () => {
        const config = {
            type: accessType,
            groupIds: accessType === 'group' ? selectedGroups : undefined,
            timeLimit: hasTimeLimit ? timeLimit : undefined
        };

        setIsSaving(true);
        try {
            const url = await onSaveAndShare(config);
            setShareUrl(url);
        } finally {
            setIsSaving(false);
        }
    };

    const downloadQR = () => {
        const qrCanvas = document.getElementById("qr-code-canvas") as HTMLCanvasElement;
        if (!qrCanvas) return;

        // Create a wrapper canvas for the stylized image
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        canvas.width = qrCanvas.width + 40; // 20px padding left/right
        canvas.height = qrCanvas.height + 80; // 60px header + 20px bottom padding

        // Draw background
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw Header Text
        ctx.fillStyle = "#1b4332"; // Primary Theme Color
        ctx.font = "bold 16px sans-serif";
        ctx.textAlign = "center";

        // Truncate title if too long
        const safeTitle = examTitle.length > 20 ? examTitle.substring(0, 18) + "..." : examTitle;
        ctx.fillText(safeTitle, canvas.width / 2, 35);

        ctx.fillStyle = "#666666";
        ctx.font = "12px sans-serif";
        ctx.fillText("스캔하여 모바일로 응시하세요!", canvas.width / 2, 55);

        // Draw the QR Code image on top
        ctx.drawImage(qrCanvas, 20, 70);

        const pngUrl = canvas.toDataURL("image/png");
        const downloadLink = document.createElement("a");
        downloadLink.href = pngUrl;
        downloadLink.download = `${examTitle}_QR.png`;
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
    };

    const handleCopyTemplate = () => {
        if (!shareUrl) return;
        const textToCopy = `[시험 안내]\n\n배포된 시험지: ${examTitle}\n\n아래 접속 링크를 눌러 모바일 기기로 정답지를 작성해 주세요. \n👉 ${shareUrl}\n\n${hasTimeLimit ? `🕒 제한 시간: ${timeLimit}분\n` : ''}행운을 빕니다!`;
        navigator.clipboard.writeText(textToCopy);
        alert("학생들에게 보낼 공유 안내 문구가 클립보드에 복사되었습니다!");
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
                background: 'white',
                width: '500px',
                borderRadius: '8px',
                display: 'flex', flexDirection: 'column',
                boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
            }}>
                <header style={{ padding: '1.5rem', borderBottom: '1px solid #eee', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>시험 배포하기</h2>
                    <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
                </header>

                <div style={{ padding: '2rem' }}>
                    {!shareUrl ? (
                        <>
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

                            {accessType === 'group' && (
                                <div style={{ marginBottom: '1.5rem', background: '#f8fafc', padding: '1rem', borderRadius: '8px' }}>
                                    <p style={{ fontSize: '0.9rem', marginBottom: '0.5rem', color: '#666' }}>응시할 그룹 선택 (선택하지 않으면 추후 자동 분류 가능):</p>
                                    {groups.length === 0 ? (
                                        <div style={{ color: 'red', fontSize: '0.9rem' }}>생성된 그룹이 없습니다. 그룹 메뉴에서 먼저 생성하세요.</div>
                                    ) : (
                                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', maxHeight: '150px', overflowY: 'auto' }}>
                                            {groups.map(g => (
                                                <label key={g.id} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.9rem' }}>
                                                    <input
                                                        type="checkbox"
                                                        checked={selectedGroups.includes(g.id)}
                                                        onChange={() => toggleGroup(g.id)}
                                                    />
                                                    {g.name}
                                                </label>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )}

                            <div style={{ marginBottom: '1.5rem', borderTop: '1px solid #eee', paddingTop: '1.5rem' }}>
                                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    <span>타이머 및 시간 제한 설정</span>
                                </label>
                                <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.8rem' }}>학생이 응시 화면에 진입한 순간부터 타이머가 작동합니다.</p>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer', marginBottom: '0.5rem' }}>
                                    <input type="checkbox" checked={hasTimeLimit} onChange={(e) => setHasTimeLimit(e.target.checked)} />
                                    <span style={{ fontSize: '0.9rem' }}>제한 시간 활성화</span>
                                </label>
                                {hasTimeLimit && (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginLeft: '1.5rem', background: 'var(--surface)', padding: '0.5rem 1rem', borderRadius: '4px', border: '1px solid var(--border)', width: 'fit-content' }}>
                                        <input
                                            type="number"
                                            value={timeLimit}
                                            onChange={(e) => setTimeLimit(Number(e.target.value))}
                                            style={{ width: '60px', padding: '0.3rem', borderRadius: '4px', border: '1px solid #ccc', textAlign: 'center' }}
                                            min={1}
                                            max={300}
                                        />
                                        <span style={{ fontSize: '0.9rem', color: '#666' }}>분</span>
                                    </div>
                                )}
                            </div>

                            <div style={{ marginBottom: '1.5rem', borderTop: '1px solid #eee', paddingTop: '1.5rem' }}>
                                <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontWeight: 600, marginBottom: '0.5rem' }}>
                                    <span>시험지 비밀번호 (PIN) 설정</span>
                                    <span style={{ fontSize: '0.75rem', background: '#e2e8f0', color: '#64748b', padding: '0.2rem 0.5rem', borderRadius: '12px', fontWeight: 'bold' }}>업데이트 예정</span>
                                </label>
                                <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '0.8rem' }}>링크 접속 시 입력할 4~6자리 핀 번호를 설정합니다.</p>
                                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', opacity: 0.5, cursor: 'not-allowed' }}>
                                    <div style={{ width: '40px', height: '20px', background: '#cbd5e1', borderRadius: '10px', position: 'relative' }}>
                                        <div style={{ width: '16px', height: '16px', background: 'white', borderRadius: '50%', position: 'absolute', top: '2px', left: '2px' }}></div>
                                    </div>
                                    <span style={{ fontSize: '0.9rem' }}>PIN 사용하기</span>
                                </label>
                            </div>

                            <button
                                onClick={handleShareClick}
                                className="btn btn-primary"
                                style={{ width: '100%', padding: '0.8rem' }}
                                disabled={isSaving}
                            >
                                {isSaving ? "생성 중..." : "링크 생성하기"}
                            </button>
                        </>
                    ) : (
                        <div style={{ textAlign: 'center' }}>
                            <div style={{ marginBottom: '1.5rem' }}>
                                <QRCodeCanvas id="qr-code-canvas" value={shareUrl} size={200} level={"H"} includeMargin={true} />
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', alignItems: 'center', marginBottom: '1.5rem' }}>
                                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', flexWrap: 'wrap' }}>
                                    <button onClick={downloadQR} className="btn btn-secondary">QR 코드 다운로드</button>
                                    <button onClick={() => { navigator.clipboard.writeText(shareUrl); alert("링크가 복사되었습니다!"); }} className="btn btn-primary" style={{ background: '#3b82f6', border: 'none' }}>🔗 링크 복사</button>
                                    <button onClick={handleCopyTemplate} className="btn btn-primary">💬 안내 문구와 함께 복사</button>
                                </div>
                            </div>

                            <div style={{ background: '#f1f5f9', padding: '0.5rem', borderRadius: '4px', fontSize: '0.8rem', wordBreak: 'break-all', color: '#666', marginBottom: '1.5rem' }}>
                                {shareUrl}
                            </div>

                            <button
                                onClick={() => router.push('/teacher/dashboard')}
                                className="btn btn-primary"
                                style={{ width: '100%', padding: '0.8rem', background: '#1b4332', fontSize: '1rem' }}
                            >
                                📊 대시보드에서 실시간 현황 보기
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
