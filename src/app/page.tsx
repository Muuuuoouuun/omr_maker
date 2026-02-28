"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Group } from "@/types/omr";

export default function Home() {
  const router = useRouter();
  const [role, setRole] = useState<'none' | 'teacher' | 'student'>('none');

  // Student Login State
  const [studentName, setStudentName] = useState("");
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [groups, setGroups] = useState<Group[]>([]);

  // Teacher Login State
  const [password, setPassword] = useState("");

  useEffect(() => {
    // Load Groups for Student Login
    const stored = localStorage.getItem('omr_groups');
    if (stored) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setGroups(JSON.parse(stored));
    }
  }, []);

  const handleTeacherLogin = () => {
    if (password === "admin123") {
      router.push("/teacher/dashboard");
    } else {
      alert("Invalid Password (Try: admin123)");
    }
  };

  const handleStudentLogin = () => {
    if (!studentName.trim() || !selectedGroupId) {
      alert("이름과 그룹을 모두 입력해주세요.");
      return;
    }
    const group = groups.find(g => g.id === selectedGroupId);
    const session = {
      name: studentName,
      groupId: selectedGroupId,
      groupName: group?.name || "Unknown"
    };
    sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    router.push("/student/dashboard");
  };

  return (
    <div className="layout-main center-content">

      <div className="container animate-fade-in" style={{ maxWidth: '900px' }}>

        {/* Header Section */}
        <div style={{ textAlign: 'center', marginBottom: '5rem', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Image src="/logo.png" alt="OMR Maker Logo" width={100} height={100} style={{ marginBottom: '1rem', objectFit: 'contain' }} />
          <h1 className="title-gradient" style={{ fontSize: '4.5rem', marginBottom: '1.5rem', lineHeight: 1.1, letterSpacing: '-0.03em' }}>
            OMR Maker
          </h1>
          <p style={{ fontSize: '1.4rem', color: 'var(--muted)', fontWeight: 300 }}>
            Smart Evaluation Platform for Schools
          </p>
        </div>

        {/* Role Selection Cards */}
        {role === 'none' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '2.5rem' }}>
            {/* Student Card */}
            <div
              onClick={() => setRole('student')}
              className="glass-panel card-hover"
              style={{
                padding: '4rem 2rem', textAlign: 'center',
                display: 'flex', flexDirection: 'column', alignItems: 'center'
              }}
            >
              <div style={{ fontSize: '5rem', marginBottom: '1.5rem', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.1))' }}>🎓</div>
              <h2 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.75rem' }}>Student</h2>
              <p style={{ color: 'var(--muted)', fontSize: '1.1rem' }}>Access your assignments and check results.</p>
            </div>

            {/* Teacher Card */}
            <div
              onClick={() => setRole('teacher')}
              className="glass-panel card-hover"
              style={{
                padding: '4rem 2rem', textAlign: 'center',
                display: 'flex', flexDirection: 'column', alignItems: 'center'
              }}
            >
              <div style={{ fontSize: '5rem', marginBottom: '1.5rem', filter: 'drop-shadow(0 4px 6px rgba(0,0,0,0.1))' }}>👨‍🏫</div>
              <h2 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '0.75rem' }}>Teacher</h2>
              <p style={{ color: 'var(--muted)', fontSize: '1.1rem' }}>Manage exams, view analytics, and grade.</p>
            </div>
          </div>
        )}

        {/* Login Forms */}
        {role !== 'none' && (
          <div className="glass-panel animate-slide-up" style={{ maxWidth: '420px', margin: '0 auto', padding: '3rem 2.5rem' }}>
            <button
              onClick={() => setRole('none')}
              style={{
                marginBottom: '2rem', fontSize: '0.95rem', color: 'var(--muted)',
                display: 'flex', alignItems: 'center', gap: '0.5rem',
                fontWeight: 500, transition: 'color 0.2s'
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = 'var(--primary)'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'var(--muted)'}
            >
              ← Back to role selection
            </button>

            {role === 'teacher' ? (
              <div>
                <h2 style={{ fontSize: '1.8rem', marginBottom: '2rem', fontWeight: 800, color: 'var(--foreground)' }}>Teacher Access</h2>
                <div style={{ marginBottom: '2rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--muted)' }}>Password</label>
                  <input
                    type="password"
                    className="input-field"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleTeacherLogin()}
                    placeholder="Enter password"
                  />
                  <div style={{ fontSize: '0.85rem', color: 'var(--muted)', marginTop: '0.75rem' }}>Hint: admin123</div>
                </div>
                <button
                  onClick={handleTeacherLogin}
                  className="btn btn-primary"
                  style={{ width: '100%' }}
                >
                  Enter Dashboard
                </button>
              </div>
            ) : (
              <div>
                <h2 style={{ fontSize: '1.8rem', marginBottom: '2rem', fontWeight: 800, color: 'var(--foreground)' }}>Student Login</h2>
                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--muted)' }}>Name</label>
                  <input
                    type="text"
                    className="input-field"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    placeholder="e.g. Kim Minji"
                  />
                </div>
                <div style={{ marginBottom: '2.5rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--muted)' }}>Select Class</label>
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="input-field"
                    style={{ cursor: 'pointer' }}
                  >
                    <option value="">-- Select Group --</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>{g.name}</option>
                    ))}
                  </select>
                  {groups.length === 0 && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--error)', marginTop: '0.75rem', background: 'rgba(239, 68, 68, 0.1)', padding: '0.5rem', borderRadius: 'var(--radius-md)' }}>
                      No groups found. Please ask teacher to create groups first.
                    </div>
                  )}
                </div>
                <button
                  onClick={handleStudentLogin}
                  className="btn btn-primary"
                  style={{ width: '100%', background: 'linear-gradient(135deg, var(--secondary), var(--secondary-light))', boxShadow: '0 4px 15px rgba(236, 72, 153, 0.4)', marginBottom: '1rem' }}
                >
                  Start Learning
                </button>

                <div style={{ position: 'relative', textAlign: 'center', margin: '1.5rem 0' }}>
                  <hr style={{ borderColor: 'var(--border)' }} />
                  <span style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', background: 'var(--surface-glass)', padding: '0 0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>OR</span>
                </div>

                <button
                  onClick={() => {
                    const guestId = Math.random().toString(36).substring(2, 15);
                    const session = {
                      name: "Guest Student",
                      isGuest: true,
                      guestId: guestId,
                      groupName: "Guest Mode"
                    };
                    sessionStorage.setItem("omr_student_session", JSON.stringify(session));
                    localStorage.setItem("omr_guest_id", guestId); // Persist for merging later
                    router.push("/student/dashboard");
                  }}
                  className="btn"
                  style={{
                    width: '100%',
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    color: 'var(--muted)',
                    fontSize: '0.9rem'
                  }}
                >
                  Continue as Guest
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
