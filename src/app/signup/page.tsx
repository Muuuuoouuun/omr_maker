"use client";

import { useState } from "react";
import Link from "next/link";
import { Mail, School, ShieldCheck } from "lucide-react";
import BrandLogo from "@/components/BrandLogo";
import ThemeToggle from "@/components/ThemeToggle";
import { createSupabaseBrowserAuthClient } from "@/lib/supabaseBrowserAuth";

export default function TeacherSignupPage() {
    const [email, setEmail] = useState("");
    const [pending, setPending] = useState<"email" | "google" | null>(null);
    const [message, setMessage] = useState("");
    const [error, setError] = useState("");

    const callbackUrl = () => `${window.location.origin}/auth/callback`;

    const handleEmail = async () => {
        const normalizedEmail = email.trim().toLowerCase();
        if (!normalizedEmail) {
            setError("이메일을 입력해주세요.");
            return;
        }
        const client = createSupabaseBrowserAuthClient();
        if (!client) {
            setError("교사 회원가입 서버가 아직 설정되지 않았습니다. 관리자에게 문의해주세요.");
            return;
        }
        setPending("email");
        setError("");
        setMessage("");
        const { error: authError } = await client.auth.signInWithOtp({
            email: normalizedEmail,
            options: { emailRedirectTo: callbackUrl(), shouldCreateUser: true },
        });
        setPending(null);
        if (authError) {
            setError("인증 메일을 보내지 못했습니다. 잠시 후 다시 시도해주세요.");
            return;
        }
        setMessage("인증 메일을 보냈습니다. 메일의 링크를 열면 학원 워크스페이스가 만들어집니다.");
    };

    const handleGoogle = async () => {
        const client = createSupabaseBrowserAuthClient();
        if (!client) {
            setError("교사 회원가입 서버가 아직 설정되지 않았습니다. 관리자에게 문의해주세요.");
            return;
        }
        setPending("google");
        setError("");
        const { error: authError } = await client.auth.signInWithOAuth({
            provider: "google",
            options: { redirectTo: callbackUrl() },
        });
        if (authError) {
            setPending(null);
            setError("Google 로그인을 시작하지 못했습니다. 잠시 후 다시 시도해주세요.");
        }
    };

    return (
        <main className="layout-main center-content" style={{ minHeight: "100vh", padding: "2rem 1rem" }}>
            <div style={{ position: "fixed", top: "1.25rem", right: "1.25rem" }}><ThemeToggle /></div>
            <section className="bento-card" style={{ width: "100%", maxWidth: 480, padding: "2rem" }} aria-labelledby="signup-title">
                <div style={{ display: "grid", justifyItems: "center", gap: "0.8rem", marginBottom: "1.75rem", textAlign: "center" }}>
                    <BrandLogo markOnly priorityLabel="OMR Maker 홈" />
                    <span className="badge badge-primary"><School size={13} /> 교사·원장 계정</span>
                    <h1 id="signup-title" style={{ fontSize: "1.7rem", fontWeight: 850 }}>학원 워크스페이스 시작</h1>
                    <p style={{ color: "var(--muted)", lineHeight: 1.6, wordBreak: "keep-all" }}>
                        교사만 계정을 만들고 학생은 회원가입 없이 반·학생번호·시작 코드로 바로 입장합니다.
                    </p>
                </div>

                <button
                    type="button"
                    className="btn"
                    onClick={() => void handleGoogle()}
                    disabled={pending !== null}
                    style={{ width: "100%", minHeight: 48, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--foreground)" }}
                >
                    {pending === "google" ? "Google 연결 중…" : "Google로 가입 또는 로그인"}
                </button>

                <div aria-hidden="true" style={{ display: "flex", alignItems: "center", gap: "0.75rem", margin: "1.25rem 0", color: "var(--muted)", fontSize: "0.8rem" }}>
                    <span style={{ height: 1, background: "var(--border)", flex: 1 }} />또는<span style={{ height: 1, background: "var(--border)", flex: 1 }} />
                </div>

                <form onSubmit={(event) => { event.preventDefault(); void handleEmail(); }}>
                    <label htmlFor="teacher-signup-email" style={{ display: "block", marginBottom: "0.5rem", fontWeight: 750, color: "var(--muted)" }}>이메일</label>
                    <input
                        id="teacher-signup-email"
                        type="email"
                        className="input-field"
                        value={email}
                        onChange={(event) => { setEmail(event.target.value); setError(""); setMessage(""); }}
                        placeholder="teacher@example.com"
                        autoComplete="email"
                        aria-invalid={Boolean(error)}
                        aria-describedby="teacher-signup-feedback"
                        required
                    />
                    <button type="submit" className="btn btn-primary" disabled={pending !== null} style={{ width: "100%", marginTop: "0.85rem", minHeight: 48 }}>
                        <Mail size={17} /> {pending === "email" ? "인증 메일 보내는 중…" : "이메일 인증 링크 받기"}
                    </button>
                </form>

                <div id="teacher-signup-feedback" aria-live="polite" style={{ minHeight: 44, marginTop: "0.85rem" }}>
                    {error && <p role="alert" style={{ color: "var(--error)", fontSize: "0.86rem", fontWeight: 650, lineHeight: 1.5 }}>{error}</p>}
                    {message && <p role="status" style={{ color: "var(--success)", fontSize: "0.86rem", fontWeight: 650, lineHeight: 1.5 }}>{message}</p>}
                </div>

                <div style={{ display: "flex", gap: "0.5rem", alignItems: "flex-start", padding: "0.8rem", borderRadius: "var(--radius-md)", background: "var(--background)", color: "var(--muted)", fontSize: "0.78rem", lineHeight: 1.5 }}>
                    <ShieldCheck size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                    인증이 완료되면 본인 전용 무료 학원 워크스페이스와 원장 권한이 생성됩니다.
                </div>

                <p style={{ textAlign: "center", marginTop: "1.25rem", fontSize: "0.86rem", color: "var(--muted)" }}>
                    기존 비밀번호 계정은 <Link href="/?role=teacher" style={{ color: "var(--primary)", fontWeight: 750 }}>교사 로그인</Link>
                </p>
            </section>
        </main>
    );
}
