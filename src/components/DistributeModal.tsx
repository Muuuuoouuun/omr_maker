"use client";

import { useState, useEffect } from 'react';
import { QRCodeCanvas } from 'qrcode.react';
import { Group } from '@/types/omr';

interface DistributeModalProps {
    isOpen: boolean;
    onClose: () => void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onSaveAndShare: (config: any) => Promise<string>; // Returns share URL
}

export default function DistributeModal({ isOpen, onClose, onSaveAndShare }: DistributeModalProps) {
    const [accessType, setAccessType] = useState<'public' | 'group'>('public');
    const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [shareUrl, setShareUrl] = useState<string | null>(null);
    const [isSaving, setIsSaving] = useState(false);

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
        }
    }, [isOpen]);

    if (!isOpen) return null;

    const handleShareClick = async () => {
        if (accessType === 'group' && selectedGroups.length === 0) {
            alert("공유할 그룹을 최소 하나 선택해주세요.");
            return;
        }

        const config = {
            type: accessType,
            groupIds: accessType === 'group' ? selectedGroups : undefined
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
                                    <p style={{ fontSize: '0.9rem', marginBottom: '0.5rem', color: '#666' }}>응시할 그룹 선택:</p>
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

                            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', marginBottom: '1.5rem' }}>
                                <button onClick={downloadQR} className="btn btn-secondary">QR 저장</button>
                                <button onClick={() => { navigator.clipboard.writeText(shareUrl); alert("복사되었습니다!"); }} className="btn btn-primary">링크 복사</button>
                            </div>

                            <div style={{ background: '#f1f5f9', padding: '0.5rem', borderRadius: '4px', fontSize: '0.8rem', wordBreak: 'break-all', color: '#666' }}>
                                {shareUrl}
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
