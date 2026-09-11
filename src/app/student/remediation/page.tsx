"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { loadStudentRemediation } from "@/app/actions/remediation";
import { REMEDIATION_STATE_LABELS, type StudentRemediationCase } from "@/lib/remediation";
import styles from "../../teacher/remediation/remediation.module.css";

export default function StudentRemediationPage() {
    const [cases, setCases] = useState<StudentRemediationCase[] | null>(null);
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const generation = useRef(0);
    const load = useCallback(async () => {
        const current = ++generation.current;
        setLoading(true); setError(""); setCases(null);
        try {
            const result = await loadStudentRemediation();
            if (current !== generation.current) return;
            if (result.status === "loaded") setCases(result.cases);
            else setError(result.code === "unauthorized" ? "등록 학생 계정으로 로그인해주세요." : result.error);
        } catch { if (current === generation.current) setError("보강 목록을 불러오지 못했습니다. 다시 시도해주세요."); }
        finally { if (current === generation.current) setLoading(false); }
    }, []);
    useEffect(() => { const counter = generation; void load(); return () => { counter.current++; }; }, [load]);
    return <main id="main-content" className={styles.main}>
        <Link href="/student/dashboard" className={styles.link}>← 학습 홈</Link>
        <header className={styles.heading}><div><span className={styles.eyebrow}>나의 보강</span><h1>틀린 문제, 다시 확인하기</h1>
            <p>오답을 다시 풀고 선생님에게 풀이를 설명해보세요. 문제를 수정한 뒤 선생님의 확인을 받으면 완료됩니다.</p></div>
            <button className="btn btn-secondary" disabled={loading} onClick={() => void load()}>새로고침</button></header>
        {error && <p role="alert" className={styles.error}>{error}</p>}
        {loading && <p role="status">보강 목록을 확인하고 있습니다…</p>}
        {cases && !cases.length && <section className={styles.card}><p>배정된 보강이 없습니다.</p></section>}
        {cases && <div className={styles.grid}>{cases.map(item => <article className={styles.card} key={item.sourceAttemptId}>
            <span className={styles.badge} data-state={item.state}>{REMEDIATION_STATE_LABELS[item.state]}</span><h2>{item.examTitle}</h2>
            <p>수정한 오답 {item.correctedCount} / {item.targetCount}문항<br />기한 {new Date(item.dueAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}</p>
            {item.state === "handoff" || item.state === "paused" ? <p>선생님에게 보강 진행 여부를 확인해주세요.</p>
                : <Link className={styles.link} href={`/student/review/${encodeURIComponent(item.sourceAttemptId)}`}>{item.state === "confirmed" || item.state === "awaiting_review" ? "수정 결과 보기" : "오답 확인하고 다시 풀기"} →</Link>}
        </article>)}</div>}
        <p>보강 목록은 최대 50건입니다. 다시 풀기가 열리지 않으면 선생님에게 시험 공개·배정 상태를 확인해주세요.</p>
    </main>;
}
