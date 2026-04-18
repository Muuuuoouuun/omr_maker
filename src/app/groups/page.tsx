"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Group } from "@/types/omr";

export default function GroupsPage() {
    const [groups, setGroups] = useState<Group[]>([]);
    const [newGroupName, setNewGroupName] = useState("");

    useEffect(() => {
        const stored = localStorage.getItem('omr_groups');
        if (stored) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setGroups(JSON.parse(stored));
        }
    }, []);

    const handleCreateGroup = () => {
        if (!newGroupName.trim()) return;

        const newGroup: Group = {
            id: Date.now().toString(),
            name: newGroupName,
            studentCount: 0, // Mock for now
            createdAt: new Date().toISOString()
        };

        const updated = [...groups, newGroup];
        setGroups(updated);
        localStorage.setItem('omr_groups', JSON.stringify(updated));
        setNewGroupName("");
    };

    const handleDeleteGroup = (id: string) => {
        if (!confirm("정말 이 그룹을 삭제하시겠습니까?")) return;
        const updated = groups.filter(g => g.id !== id);
        setGroups(updated);
        localStorage.setItem('omr_groups', JSON.stringify(updated));
    };

    return (
        <div className="layout-main" style={{ minHeight: '100vh', background: '#f8fafc' }}>
            <header className="header" style={{ background: 'white', borderBottom: '1px solid #e2e8f0' }}>
                <div className="container header-content">
                    <Link href="/" className="logo">OMR Maker</Link>
                    <nav>
                        <Link href="/groups" className="nav-link" style={{ fontWeight: 'bold', color: 'var(--primary)' }}>
                            그룹 관리
                        </Link>
                    </nav>
                </div>
            </header>

            <main className="container" style={{ padding: '2rem 1rem', maxWidth: '800px', margin: '0 auto' }}>
                <h1 style={{ fontSize: '1.8rem', fontWeight: 700, marginBottom: '2rem', color: '#1e293b' }}>
                    👥 그룹 관리
                </h1>

                {/* Create Section */}
                <div style={{ background: 'white', padding: '1.5rem', borderRadius: '12px', boxShadow: '0 2px 4px rgba(0,0,0,0.05)', marginBottom: '2rem', display: 'flex', gap: '1rem' }}>
                    <input
                        type="text"
                        value={newGroupName}
                        onChange={(e) => setNewGroupName(e.target.value)}
                        placeholder="새 그룹 이름 (예: 3학년 2반)"
                        className="input-field"
                        style={{ flex: 1, padding: '0.8rem', borderRadius: '8px', border: '1px solid #e2e8f0' }}
                    />
                    <button
                        onClick={handleCreateGroup}
                        className="btn btn-primary"
                        disabled={!newGroupName.trim()}
                    >
                        + 그룹 생성
                    </button>
                </div>

                {/* List Section */}
                {groups.length === 0 ? (
                    <div style={{ textAlign: 'center', color: '#94a3b8', padding: '3rem' }}>
                        생성된 그룹이 없습니다.
                    </div>
                ) : (
                    <div style={{ display: 'grid', gap: '1rem' }}>
                        {groups.map(group => (
                            <div key={group.id} style={{ background: 'white', padding: '1.5rem', borderRadius: '12px', border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div>
                                    <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#0f172a' }}>{group.name}</h3>
                                    <p style={{ color: '#64748b', fontSize: '0.9rem' }}>학생 수: {group.studentCount}명 | 생성일: {new Date(group.createdAt).toLocaleDateString()}</p>
                                </div>
                                <button
                                    onClick={() => handleDeleteGroup(group.id)}
                                    className="btn btn-secondary"
                                    style={{ color: '#ef4444', borderColor: '#fee2e2', background: '#fef2f2' }}
                                >
                                    삭제
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </main>
        </div>
    );
}
