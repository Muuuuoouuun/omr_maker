"use client";

import { useState, useEffect } from "react";
import { Group, Student } from "@/types/omr";
import { useToast } from "@/components/ui/Toast";
import { Users, Trash2 } from "lucide-react";

export default function ClassManagementTab() {
    const toast = useToast();
    const [groups, setGroups] = useState<Group[]>([]);
    const [students, setStudents] = useState<Student[]>([]);
    const [newGroupName, setNewGroupName] = useState("");

    useEffect(() => {
        loadData();
    }, []);

    const loadData = () => {
        const storedGroups = JSON.parse(localStorage.getItem('omr_groups') || '[]');
        const storedStudents = JSON.parse(localStorage.getItem('omr_students') || '[]');
        setGroups(storedGroups);
        setStudents(storedStudents);
    };

    const handleCreateGroup = () => {
        if (!newGroupName.trim()) {
            toast.error("그룹 이름을 입력해주세요.");
            return;
        }
        
        const newGroup: Group = {
            id: `usr_grp_${Date.now().toString()}`,
            name: newGroupName,
            studentCount: 0,
            createdAt: new Date().toISOString()
        };

        const updated = [...groups, newGroup];
        setGroups(updated);
        localStorage.setItem('omr_groups', JSON.stringify(updated));
        setNewGroupName("");
        toast.success("그룹이 생성되었습니다.");
        updateStudentCounts(updated, students); // Recalculate if there were students (unlikely for new group)
    };

    const handleDeleteGroup = (id: string) => {
        if (!confirm("정말 이 그룹을 삭제하시겠습니까? 학생들의 소속 정보가 초기화됩니다.")) return;
        
        const updatedGroups = groups.filter(g => g.id !== id);
        
        // Remove groupId from students who were in this group
        const updatedStudents = students.map(s => 
            s.groupId === id ? { ...s, groupId: undefined } : s
        );

        setGroups(updatedGroups);
        setStudents(updatedStudents);
        
        localStorage.setItem('omr_groups', JSON.stringify(updatedGroups));
        localStorage.setItem('omr_students', JSON.stringify(updatedStudents));
        toast.success("그룹이 삭제되었습니다.");
    };

    const handleAssignGroup = (studentId: string, groupId: string) => {
        const updatedStudents = students.map(s => {
            if (s.id === studentId) {
                return { ...s, groupId: groupId === "none" ? undefined : groupId };
            }
            return s;
        });

        setStudents(updatedStudents);
        localStorage.setItem('omr_students', JSON.stringify(updatedStudents));
        
        // Recalculate student counts for groups
        updateStudentCounts(groups, updatedStudents);
        toast.success("그룹이 변경되었습니다.");
    };

    const updateStudentCounts = (currentGroups: Group[], currentStudents: Student[]) => {
        const updatedGroups = currentGroups.map(g => {
            const count = currentStudents.filter(s => s.groupId === g.id).length;
            return { ...g, studentCount: count };
        });
        setGroups(updatedGroups);
        localStorage.setItem('omr_groups', JSON.stringify(updatedGroups));
    };

    return (
        <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            {/* Top Cards (Stats) */}
            <div className="bento-grid">
                <div className="bento-card col-span-1" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', padding: '2rem' }}>
                    <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--primary)', lineHeight: 1, marginBottom: '0.5rem' }}>{students.length}</div>
                    <div style={{ color: 'var(--muted)', fontSize: '1rem', fontWeight: 600 }}>총 학생 수</div>
                </div>
                <div className="bento-card col-span-1" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: 'var(--surface)', padding: '2rem' }}>
                    <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--secondary)', lineHeight: 1, marginBottom: '0.5rem' }}>{groups.length}</div>
                    <div style={{ color: 'var(--muted)', fontSize: '1rem', fontWeight: 600 }}>운영 중인 그룹 수</div>
                </div>
                <div className="bento-card col-span-2" style={{ background: 'var(--surface)', padding: '2rem', display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Users size={20} /> 새 그룹 만들기
                    </h3>
                    <div style={{ display: 'flex', gap: '1rem' }}>
                        <input
                            type="text"
                            value={newGroupName}
                            onChange={(e) => setNewGroupName(e.target.value)}
                            onKeyDown={(e) => e.key === 'Enter' && handleCreateGroup()}
                            placeholder="예: 3학년 1반, 심화 영어반"
                            className="input-field"
                            style={{ flex: 1 }}
                        />
                        <button className="btn btn-primary" onClick={handleCreateGroup}>생성하기</button>
                    </div>
                </div>
            </div>

            {/* Split View for Groups and Students */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2rem' }}>
                {/* Left: Groups */}
                <div className="glass-panel" style={{ padding: '1.5rem', background: 'var(--surface)' }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Users size={20} /> 그룹 (반) 목록
                    </h3>
                    {groups.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--muted)' }}>생성된 그룹이 없습니다.</div>
                    ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {groups.map(g => (
                                <div key={g.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'var(--background)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border)' }}>
                                    <div>
                                        <div style={{ fontWeight: 600, fontSize: '1rem', color: 'var(--foreground)' }}>{g.name}</div>
                                        <div style={{ fontSize: '0.85rem', color: 'var(--muted)' }}>{g.studentCount}명 배정됨</div>
                                    </div>
                                    <button 
                                        onClick={() => handleDeleteGroup(g.id)}
                                        style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', padding: '0.5rem' }}
                                        title="삭제"
                                    >
                                        <Trash2 size={18} />
                                    </button>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                {/* Right: Students */}
                <div className="glass-panel" style={{ padding: '1.5rem', background: 'var(--surface)' }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 700, marginBottom: '1.5rem' }}>학생 목록 및 반 배정</h3>
                    {students.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--muted)' }}>생성된 학생 데이터가 없습니다. 학생들이 메인 화면에서 로그인/가입하면 여기에 표시됩니다.</div>
                    ) : (
                        <div className="table-responsive" style={{ overflowX: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
                                <thead>
                                    <tr style={{ borderBottom: '2px solid var(--border)', color: 'var(--muted)', fontSize: '0.9rem' }}>
                                        <th style={{ padding: '1rem 0.5rem' }}>이름</th>
                                        <th style={{ padding: '1rem 0.5rem' }}>전화번호/식별자</th>
                                        <th style={{ padding: '1rem 0.5rem' }}>그룹(반) 배정</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {students.map(s => (
                                        <tr key={s.id} style={{ borderBottom: '1px solid var(--border)' }}>
                                            <td style={{ padding: '1rem 0.5rem', fontWeight: 500 }}>{s.name}</td>
                                            <td style={{ padding: '1rem 0.5rem', color: 'var(--muted)', fontSize: '0.9rem' }}>{s.phone}</td>
                                            <td style={{ padding: '1rem 0.5rem' }}>
                                                <select
                                                    className="input-field"
                                                    style={{ padding: '0.5rem', fontSize: '0.9rem', width: '100%', maxWidth: '200px' }}
                                                    value={s.groupId || "none"}
                                                    onChange={(e) => handleAssignGroup(s.id, e.target.value)}
                                                >
                                                    <option value="none">-- 미배정 --</option>
                                                    {groups.map(g => (
                                                        <option key={g.id} value={g.id}>{g.name}</option>
                                                    ))}
                                                </select>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
