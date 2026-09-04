"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import BrandLogo from "@/components/BrandLogo";
import { startSupabaseTeacherSession } from "@/app/actions/auth";
import { createSupabaseBrowserAuthClient } from "@/lib/supabaseBrowserAuth";
import { saveTeacherSessionWithIdentity } from "@/lib/teacherSession";
import { setCurrentPlan } from "@/utils/plans";

export default function AuthCallbackPage() {
    const router = useRouter();
    const [error, setError] = useState("");

    useEffect(() => {
        let cancelled = false;
        const complete = async () => {
            const client = createSupabaseBrowserAuthClient();
            if (!client) {
                setError("교사 회원가입 서버가 아직 설정되지 않았습니다.");
                return;
            }
            const { data, error: sessionError } = await client.auth.getSession();
            if (cancelled) return;
            if (sessionError || !data.session?.access_token) {
                setError("인증 링크가 만료되었거나 유효하지 않습니다. 다시 가입을 시도해주세요.");
                return;
            }
            const result = await startSupabaseTeacherSession(data.session.access_token);
            if (cancelled) return;
            if (!result.success || !result.token || !result.teacher) {
                setError(result.error || "교사 워크스페이스를 준비하지 못했습니다.");
                return;
            }
            if (!saveTeacherSessionWithIdentity(result.token, result.teacher)) {
                setError("브라우저 세션 저장을 사용할 수 없습니다.");
                return;
            }
            if (result.teacher.plan) setCurrentPlan(result.teacher.plan);
            await client.auth.signOut({ scope: "local" });
            router.replace("/teacher/dashboard");
        };
        void complete();
        return () => { cancelled = true; };
    }, [router]);

    return (
        <main className="layout-main center-content" style={{ minHeight: "100vh", padding: "2rem", textAlign: "center" }}>
            <section className="bento-card" style={{ width: "100%", maxWidth: 440, padding: "2rem", display: "grid", justifyItems: "center", gap: "1rem" }}>
                <BrandLogo markOnly priorityLabel="OMR Maker 홈" />
                <h1 style={{ fontSize: "1.35rem", fontWeight: 850 }}>{error ? "계정 연결을 완료하지 못했습니다" : "교사 계정을 준비하고 있습니다"}</h1>
                {error ? (
                    <>
                        <p role="alert" style={{ color: "var(--error)", lineHeight: 1.6 }}>{error}</p>
                        <button type="button" className="btn btn-primary" onClick={() => router.replace("/signup")}>가입 화면으로 돌아가기</button>
                    </>
                ) : (
                    <p role="status" aria-live="polite" style={{ color: "var(--muted)" }}>인증 확인 및 학원 워크스페이스 생성 중…</p>
                )}
            </section>
        </main>
    );
}
