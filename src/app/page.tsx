"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { Student } from "@/types/omr";
import { useToast } from "@/components/ui/Toast";

export default function Home() {
  const router = useRouter();
  const toast = useToast();
  const [role, setRole] = useState<'none' | 'teacher' | 'student'>('none');

  // Student Login State
  const [studentName, setStudentName] = useState("");
  const [phone, setPhone] = useState("");
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [guestExamCode, setGuestExamCode] = useState("");

  // Teacher Login State
  const [password, setPassword] = useState("");

  const handleTeacherLogin = () => {
    if (password === "admin123") {
      router.push("/teacher/dashboard");
    } else {
      toast.error("Invalid Password (Try: admin123)");
    }
  };

  const handleStudentLogin = () => {
    if (!studentName.trim() || !phone.trim()) {
      toast.error("이름과 전화번호를 모두 입력해주세요.");
      return;
    }

    const storedStudents = JSON.parse(localStorage.getItem('omr_students') || '[]');
    let student = storedStudents.find((s: Student) => s.name === studentName && s.phone === phone);

    if (isLoginMode) {
      if (!student) {
        toast.error("가입된 정보가 없습니다. '가입 및 로그인'을 선택해주세요.");
        return;
      }
    } else {
      if (!student) {
        student = {
          id: `stu_${Math.random().toString(36).substring(2, 9)}`,
          name: studentName,
          phone: phone,
          createdAt: new Date().toISOString()
        };
        storedStudents.push(student);
        localStorage.setItem('omr_students', JSON.stringify(storedStudents));
        toast.success("회원가입이 완료되었습니다!");
      } else {
        toast.success("이미 가입된 정보로 로그인합니다.");
      }
    }

    const session = {
      id: student.id,
      name: student.name,
      phone: student.phone,
      isGuest: false
    };
    sessionStorage.setItem("omr_student_session", JSON.stringify(session));
    router.push("/student/dashboard");
  };

  const handleGuestExamEnter = () => {
    if (!guestExamCode.trim()) {
      toast.error("시험 코드를 입력해주세요.");
      return;
    }
    router.push(`/solve/${guestExamCode.trim()}`);
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
                <div style={{ display: 'flex', gap: '1rem', marginBottom: '2rem' }}>
                  <button 
                    onClick={() => setIsLoginMode(true)}
                    style={{ flex: 1, padding: '0.5rem', borderBottom: isLoginMode ? '2px solid var(--primary)' : '2px solid transparent', background: 'none', color: isLoginMode ? 'var(--primary)' : 'var(--muted)', fontWeight: isLoginMode ? 700 : 500, cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    로그인
                  </button>
                  <button 
                    onClick={() => setIsLoginMode(false)}
                    style={{ flex: 1, padding: '0.5rem', borderBottom: !isLoginMode ? '2px solid var(--primary)' : '2px solid transparent', background: 'none', color: !isLoginMode ? 'var(--primary)' : 'var(--muted)', fontWeight: !isLoginMode ? 700 : 500, cursor: 'pointer', transition: 'all 0.2s' }}
                  >
                    가입 및 로그인
                  </button>
                </div>

                <div style={{ marginBottom: '1.5rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--muted)' }}>이름</label>
                  <input
                    type="text"
                    className="input-field"
                    value={studentName}
                    onChange={(e) => setStudentName(e.target.value)}
                    placeholder="홍길동"
                  />
                </div>
                <div style={{ marginBottom: '2.5rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--muted)' }}>전화번호 (또는 뒷자리 4자리)</label>
                  <input
                    type="text"
                    className="input-field"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleStudentLogin()}
                    placeholder="예: 010-1234-5678 또는 5678"
                  />
                </div>
                <button
                  onClick={handleStudentLogin}
                  className="btn btn-primary"
                  style={{ width: '100%', background: 'linear-gradient(135deg, var(--secondary), var(--secondary-light))', boxShadow: '0 4px 15px rgba(236, 72, 153, 0.4)', marginBottom: '1rem' }}
                >
                  {isLoginMode ? '로그인' : '학생 등록하고 시작'}
                </button>

                <div style={{ position: 'relative', textAlign: 'center', margin: '2rem 0' }}>
                  <hr style={{ borderColor: 'var(--border)' }} />
                  <span style={{ position: 'absolute', top: '-10px', left: '50%', transform: 'translateX(-50%)', background: 'var(--surface-glass)', padding: '0 0.5rem', fontSize: '0.8rem', color: 'var(--muted)' }}>OR</span>
                </div>

                <div style={{ marginBottom: '1rem' }}>
                  <label style={{ display: 'block', marginBottom: '0.75rem', fontSize: '0.95rem', fontWeight: 600, color: 'var(--foreground)' }}>시험 코드로 바로 입장 (비회원 가능)</label>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input
                      type="text"
                      className="input-field"
                      value={guestExamCode}
                      onChange={(e) => setGuestExamCode(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleGuestExamEnter()}
                      placeholder="시험 코드 입력 (예: exam_abc123)"
                      style={{ flex: 1 }}
                    />
                    <button
                      onClick={handleGuestExamEnter}
                      className="btn btn-secondary"
                      style={{ padding: '0 1.5rem' }}
                    >
                      입장
                    </button>
                  </div>
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
                    fontSize: '0.9rem',
                    marginTop: '1rem'
                  }}
                >
                  (테스트용) 게스트 대시보드 바로가기
                </button>
              </div>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
